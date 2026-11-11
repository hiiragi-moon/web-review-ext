const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const content = fs.readFileSync('content.js', 'utf8');
const helper = fs.existsSync('frames.js') ? fs.readFileSync('frames.js', 'utf8') : '';
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

function setup({ crossOrigin = false, initialPicking = false } = {}) {
  const dom = new JSDOM('<head></head><body><button id="same">Parent</button><iframe id="outer"></iframe></body>', { url: 'https://claude.ai/artifact/example', runScripts: 'outside-only', pretendToBeVisual: true });
  const top = dom.window;
  const outer = top.document.querySelector('iframe');
  const childDom = crossOrigin ? new JSDOM('<body></body>', { url: 'https://artifact.example/app', runScripts: 'outside-only', pretendToBeVisual: true }) : null;
  const child = childDom?.window || outer.contentWindow;
  if (childDom) {
    Object.defineProperty(outer, 'contentWindow', { value: child });
    Object.defineProperty(child, 'parent', { value: top });
    childDom.reconfigure({ windowTop: top });
  }
  child.document.body.innerHTML = '<button id="same">Child</button><iframe id="inner"></iframe>';
  const inner = child.document.querySelector('iframe');
  const nestedDom = crossOrigin ? new JSDOM('<body></body>', { url: 'https://nested.example/app', runScripts: 'outside-only', pretendToBeVisual: true }) : null;
  const nested = nestedDom?.window || inner.contentWindow;
  if (nestedDom) {
    Object.defineProperty(inner, 'contentWindow', { value: nested });
    Object.defineProperty(nested, 'parent', { value: child });
    nestedDom.reconfigure({ windowTop: top });
  }
  nested.document.body.innerHTML = '<button id="same">Nested</button>';
  const windows = [top, child, nested];
  const bridgeMessages = [];
  // jsdom does not populate MessageEvent.source on postMessage; reproduce that browser boundary.
  windows.forEach((w, i) => {
    w.postMessage = data => {
      bridgeMessages.push(structuredClone(data));
      const source = data.type === 'rc-context-request' ? windows[i + 1] : windows[i - 1];
      queueMicrotask(() => w.dispatchEvent(new w.MessageEvent('message', { data, source })));
    };
  });
  const messages = [], listeners = [], changed = [], state = { comments: [] };
  const rect = (x, y, width, height) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height });
  for (const [el, r] of [[outer, rect(100, 60, 500, 400)], [inner, rect(20, 30, 200, 150)]]) {
    el.getBoundingClientRect = () => r;
    for (const [k, v] of Object.entries({ offsetWidth: r.width, offsetHeight: r.height, clientWidth: r.width, clientHeight: r.height, clientLeft: 0, clientTop: 0 })) Object.defineProperty(el, k, { value: v });
  }
  windows.forEach((w, i) => {
    Object.defineProperty(w, 'innerWidth', { value: [1000, 500, 200][i] });
    Object.defineProperty(w, 'innerHeight', { value: [800, 400, 150][i] });
    w.CSS = { escape: x => x };
    w.setInterval = () => 0;
    w.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = function() { this.dataset.scrolled = 'yes'; };
    const button = w.document.querySelector('button');
    button.getBoundingClientRect = () => rect(10, 15, 80, 25);
    w.document.elementFromPoint = () => button;
    const handlers = []; listeners.push(handlers);
    w.chrome = {
      runtime: {
        getURL: path => 'chrome-extension://test/' + path,
        onMessage: { addListener: f => handlers.push(f) },
        connect: () => ({ onMessage: { addListener: f => queueMicrotask(() => f({ type: 'panel-ok' })) }, onDisconnect: { addListener() {} } }),
        sendMessage: async m => { messages.push({ frame: i, ...structuredClone(m) }); return m.type === 'frame-page' ? { pageKey: top.location.origin + top.location.pathname, url: top.location.href, title: top.document.title } : m.type === 'initial-frame-state' && initialPicking ? { picking: true, dock: true } : {}; },
      },
      storage: {
        local: { get: (key, cb) => { if (cb) cb(state); else return Promise.resolve(state); } },
        onChanged: { addListener: f => changed.push(f) },
      },
    };
    if (helper) w.eval(helper);
    w.eval(content);
  });
  const send = (i, m) => listeners[i].forEach(f => f(m, {}, () => {}));
  const request = (i, m) => new Promise(resolve => listeners[i].forEach(f => f(m, {}, resolve)));
  return { top, child, nested, windows, bridgeMessages, messages, send, request, state, changed, close: () => { nestedDom?.window.close(); childDom?.window.close(); dom.window.close(); } };
}

test('nested frame element is saved under the parent URL with its frame path and translated clip', async () => {
  const s = setup();
  try {
    await wait();
    s.windows.forEach((_, i) => s.send(i, { type: 'start-pick' }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mouseup', { button: 0 }));
    await wait(150);
    const picked = s.messages.find(m => m.type === 'picked');
    assert.ok(picked);
    assert.equal(picked.data.pageKey, 'https://claude.ai/artifact/example');
    assert.deepEqual(picked.data.framePath, ['#outer', '#inner']);
    assert.equal(picked.data.selector, '#same');
    assert.deepEqual(picked.clip, { x: 130, y: 105, w: 80, h: 25, vw: 1000 });
  } finally { s.close(); }
});

test('pins with identical element selectors stay in their own frame and retain global numbering', async () => {
  const s = setup();
  try {
    s.state.comments = [
      { id: 'legacy', pageKey: 'https://claude.ai/artifact/example', selector: '#same', createdAt: 1 },
      { id: 'nested', pageKey: 'https://claude.ai/artifact/example', selector: '#same', framePath: ['#outer', '#inner'], createdAt: 2 },
    ];
    s.changed.forEach(f => f({ comments: {} }));
    await wait(100);
    const pins = w => [...w.document.querySelector('div').shadowRoot.querySelectorAll('.pin')].map(p => p.textContent);
    assert.deepEqual(pins(s.top), ['1']);
    assert.deepEqual(pins(s.child), []);
    assert.deepEqual(pins(s.nested), ['2']);
    s.windows.forEach((_, i) => s.send(i, { type: 'focus', id: 'nested', selector: '#same', framePath: ['#outer', '#inner'] }));
    await wait();
    assert.equal(s.top.document.querySelector('button').dataset.scrolled, undefined);
    assert.equal(s.nested.document.querySelector('button').dataset.scrolled, 'yes');
    assert.equal(s.top.document.querySelector('#outer').dataset.scrolled, 'yes');
  } finally { s.close(); }
});

test('only the parent creates a bottom panel', async () => {
  const s = setup();
  try {
    s.windows.forEach((_, i) => s.send(i, { type: 'dock-open' }));
    await wait();
    assert.equal(s.top.document.querySelectorAll('div').length, 2);
    assert.equal(s.child.document.querySelectorAll('div').length, 1);
    assert.equal(s.nested.document.querySelectorAll('div').length, 1);
  } finally { s.close(); }
});

test('preselected frame text keeps its quote and resolves the parent page identity', async () => {
  const s = setup();
  try {
    await wait();
    const r = s.nested.document.createRange();
    r.selectNodeContents(s.nested.document.querySelector('button'));
    s.nested.getSelection().addRange(r);
    s.send(2, { type: 'start-pick' });
    await wait();
    const picked = s.messages.find(m => m.type === 'picked');
    assert.equal(picked.data.kind, 'text');
    assert.equal(picked.data.quote, 'Nested');
    assert.deepEqual(picked.data.framePath, ['#outer', '#inner']);
    assert.equal(picked.data.url, s.top.location.href);
  } finally { s.close(); }
});

test('PDF frame targets use parent page coordinates and hide overlays until capture ends', async () => {
  const s = setup();
  try {
    s.state.comments = [{ id: 'nested', pageKey: s.top.location.href, selector: '#same', framePath: ['#outer', '#inner'], createdAt: 1 }];
    s.changed.forEach(f => f({ comments: {} }));
    await wait();
    const targets = await s.request(2, { type: 'shot-frame-begin' });
    assert.deepEqual(structuredClone(targets), [{ id: 'nested', text: false, rects: [{ x: 130, y: 105, w: 80, h: 25 }] }]);
    const overlay = s.nested.document.querySelector('div');
    assert.equal(overlay.style.display, 'none');
    s.send(2, { type: 'shot-frame-end' });
    assert.equal(overlay.style.display, '');
  } finally { s.close(); }
});


test('separate origins resolve nested frame paths without reading parent documents', async () => {
  const s = setup({ crossOrigin: true });
  try {
    await wait();
    const context = await s.nested.ReviewFrames.create(() => '').context({ x: 10, y: 15, w: 80, h: 25 });
    assert.equal(s.child.location.origin, 'https://artifact.example');
    assert.equal(s.nested.location.origin, 'https://nested.example');
    assert.deepEqual(structuredClone(context.framePath), ['#outer', '#inner']);
    assert.equal(context.pageKey, undefined);
    assert.deepEqual(structuredClone(context.clip), { x: 130, y: 105, w: 80, h: 25, vw: 1000 });
  } finally { s.close(); }
});

test('frame clip accounts for scaled borders and clips to the parent viewport', () => {
  const s = setup();
  try {
    const frame = {
      getBoundingClientRect: () => ({ left: 100, top: 60, width: 500, height: 400 }),
      offsetWidth: 250, offsetHeight: 200, clientLeft: 2, clientTop: 2,
      clientWidth: 246, clientHeight: 196,
    };
    const map = s.top.ReviewFrames.mapClip;
    assert.deepEqual(structuredClone(map({ x: -10, y: -5, w: 50, h: 30 }, frame, { w: 150, h: 100 })), { x: 104, y: 64, w: 46, h: 36 });
    assert.equal(map({ x: 300, y: 0, w: 10, h: 10 }, frame, { w: 1000, h: 800 }), null);
  } finally { s.close(); }
});

test('a newly loaded child joins the current pick and bottom-panel state', async () => {
  const s = setup({ initialPicking: true });
  try {
    await wait();
    assert.equal(s.nested.document.documentElement.style.cursor, 'crosshair');
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mouseup', { button: 0 }));
    await wait(150);
    assert.ok(s.messages.some(m => m.type === 'picked' && m.frame === 2));
  } finally { s.close(); }
});


test('full-page PDF retains iframe targets below the current top viewport', async () => {
  const s = setup();
  try {
    s.top.document.querySelector('iframe').getBoundingClientRect = () => ({ left: 100, top: 900, right: 600, bottom: 1300, width: 500, height: 400 });
    s.state.comments = [{ id: 'below-fold', pageKey: s.top.location.href, selector: '#same', framePath: ['#outer', '#inner'], createdAt: 1 }];
    s.changed.forEach(f => f({ comments: {} }));
    await wait();
    const targets = await s.request(2, { type: 'shot-frame-begin' });
    assert.deepEqual(structuredClone(targets), [{ id: 'below-fold', text: false, rects: [{ x: 130, y: 945, w: 80, h: 25 }] }]);
  } finally { s.close(); }
});

test('iframe picking works when secure-context-only randomUUID is unavailable', async () => {
  const s = setup();
  try {
    await wait();
    s.nested.crypto.randomUUID = undefined;
    s.send(2, { type: 'start-pick' });
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mouseup', { button: 0 }));
    await wait(150);
    assert.ok(s.messages.some(m => m.type === 'picked' && m.frame === 2));
    assert.equal(s.messages.some(m => m.type === 'pick-error'), false);
  } finally { s.close(); }
});


test('the page-visible bridge never exposes parent URL, title, or comment metadata', async () => {
  const s = setup({ crossOrigin: true });
  try {
    await wait();
    s.send(2, { type: 'start-pick' });
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mouseup', { button: 0 }));
    await wait(150);
    for (const msg of s.bridgeMessages.filter(m => m.type === 'rc-context-reply')) {
      assert.equal(msg.context.url, undefined);
      assert.equal(msg.context.pageKey, undefined);
      assert.equal(msg.context.title, undefined);
    }
    const picked = s.messages.find(m => m.type === 'picked');
    assert.equal(picked.data.pageKey, s.top.location.href);
  } finally { s.close(); }
});

test('entering an iframe does not leave a blue highlight over the frame element', async () => {
  const s = setup();
  try {
    await wait();
    s.windows.forEach((_, i) => s.send(i, { type: 'start-pick' }));
    s.top.document.elementFromPoint = () => s.top.document.querySelector('iframe');
    s.top.document.dispatchEvent(new s.top.MouseEvent('mousemove', { clientX: 120, clientY: 90 }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    const highlight = w => w.document.querySelector('div').shadowRoot.querySelector('.hl');
    assert.equal(highlight(s.top).style.display, 'none');
    assert.equal(highlight(s.nested).style.display, 'block');
  } finally { s.close(); }
});

test('moving from a parent target into a child frame clears the stale parent selection', async () => {
  const s = setup();
  try {
    await wait();
    s.send(0, { type: 'start-pick' });
    s.top.document.dispatchEvent(new s.top.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    const highlight = s.top.document.querySelector('div').shadowRoot.querySelector('.hl');
    assert.equal(highlight.style.display, 'block');
    s.top.document.querySelector('button').dispatchEvent(new s.top.MouseEvent('mouseout', { bubbles: true, relatedTarget: s.top.document.querySelector('iframe') }));
    assert.equal(highlight.style.display, 'none');
    s.send(0, { type: 'pick-key', key: 'ArrowUp' });
    assert.equal(highlight.style.display, 'none');
  } finally { s.close(); }
});

test('leaving a child document clears its highlight and stale click target', async () => {
  const s = setup();
  try {
    await wait();
    s.send(2, { type: 'start-pick' });
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mouseleave'));
    const highlight = s.nested.document.querySelector('div').shadowRoot.querySelector('.hl');
    assert.equal(highlight.style.display, 'none');
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mouseup', { button: 0 }));
    await wait(150);
    assert.equal(s.messages.some(m => m.type === 'picked'), false);
  } finally { s.close(); }
});

test('an SPA route change drops the previous route pins at once and loads the new route comments', async () => {
  const s = setup();
  try {
    s.state.comments = [
      { id: 'a', pageKey: 'https://claude.ai/artifact/example', selector: '#same', createdAt: 1 },
      { id: 'b', pageKey: 'https://claude.ai/other', selector: '#same', createdAt: 2, resolved: true },
    ];
    s.changed.forEach(f => f({ comments: {} }));
    await wait(100);
    const pins = () => [...s.top.document.querySelector('div').shadowRoot.querySelectorAll('.pin')].map(p => p.textContent);
    assert.deepEqual(pins(), ['1']);
    s.top.history.pushState({}, '', '/other');
    s.top.dispatchEvent(new s.top.Event('scroll'));
    await wait(50);
    // 新しい画面のコメント(b・解決済み)だけが出る
    assert.deepEqual([...s.top.document.querySelector('div').shadowRoot.querySelectorAll('.pin')].map(p => p.className), ['pin done']);
    s.top.history.pushState({}, '', '/nowhere');
    s.top.dispatchEvent(new s.top.Event('scroll'));
    await wait(50);
    assert.deepEqual(pins(), []);
  } finally { s.close(); }
});

test('Enter picks the highlighted element like a click, from the page or from the panel', async () => {
  const s = setup();
  try {
    await wait();
    s.send(0, { type: 'start-pick' });
    s.top.document.dispatchEvent(new s.top.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.top.document.dispatchEvent(new s.top.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(150);
    let picked = s.messages.filter(m => m.type === 'picked');
    assert.equal(picked.length, 1);
    assert.equal(picked[0].frame, 0);
    assert.equal(picked[0].data.selector, '#same');

    s.messages.length = 0;
    s.windows.forEach((_, i) => s.send(i, { type: 'start-pick' }));
    s.nested.document.dispatchEvent(new s.nested.MouseEvent('mousemove', { clientX: 15, clientY: 20 }));
    s.windows.forEach((_, i) => s.send(i, { type: 'pick-key', key: 'Enter' }));
    await wait(150);
    picked = s.messages.filter(m => m.type === 'picked');
    assert.equal(picked.length, 1);
    assert.equal(picked[0].frame, 2);
    assert.deepEqual(picked[0].data.framePath, ['#outer', '#inner']);
  } finally { s.close(); }
});
