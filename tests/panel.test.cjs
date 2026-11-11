const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const wait = () => new Promise(resolve => setTimeout(resolve, 30));

function panel({ otherWindow = false } = {}) {
  const dom = new JSDOM(fs.readFileSync('sidepanel.html', 'utf8'), { url: 'https://extension.test/sidepanel.html', runScripts: 'outside-only' });
  const w = dom.window, handlers = [], connects = [], sent = [], state = { comments: [] };
  const tab = { id: 10, windowId: 1, url: 'https://claude.ai/artifact/example', title: 'Artifact' };
  // 別ウィンドウ(id 2)で表示中のタブ。最後に操作したのはこちらのウィンドウ
  const other = { id: 20, windowId: 2, url: 'https://other.test/page', title: 'Other' };
  const event = { addListener() {} };
  const tabEvents = { activated: [], updated: [] };
  w.chrome = {
    runtime: { onMessage: { addListener: f => handlers.push(f) }, onConnect: { addListener: f => connects.push(f) }, sendMessage: async () => '' },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async (q = {}) => !otherWindow ? [tab]
        : q.windowId === 1 ? [tab] : q.windowId === 2 || q.lastFocusedWindow ? [other] : [tab, other],
      sendMessage: async (id, msg, options) => { sent.push({ id, ...msg, options }); return { ok: true }; },
      onActivated: { addListener: f => tabEvents.activated.push(f) }, onUpdated: { addListener: f => tabEvents.updated.push(f) },
    },
    storage: {
      local: { get: async (key, cb) => { if (cb) cb(state); return state; }, set: async patch => Object.assign(state, patch) },
      session: { get: async () => ({}), onChanged: event }, onChanged: event,
    },
  };
  w.eval(fs.readFileSync('sidepanel.js', 'utf8'));
  const receive = (msg, frameId = 2) => handlers.forEach(f => f(msg, { tab, frameId }, () => {}));
  const connect = (name) => {
    const fns = [];
    const p = { name, sender: { tab, frameId: 0 }, onDisconnect: { addListener: f => fns.push(f) }, postMessage() {}, disconnect() {} };
    connects.forEach(f => f(p));
    return fns; // 接続を受けた直後(awaitの前)に登録されているか見る
  };
  return { w, state, sent, receive, connect, tabEvents, other, close: () => dom.window.close() };
}

test('first frame selection wins, stops every frame and is saved under the tab URL', async () => {
  const s = panel();
  try {
    await wait();
    await s.w.document.querySelector('#pick').onclick();
    s.receive({ type: 'picked', data: { pageKey: 'https://child.test/', url: 'https://child.test/', framePath: ['#artifact'], selector: '#target', text: 'Target' } });
    s.receive({ type: 'picked', data: { selector: '#unwanted' } }, 3);
    await wait();
    assert.equal(s.state.comments.length, 1);
    assert.equal(s.state.comments[0].pageKey, 'https://claude.ai/artifact/example');
    assert.deepEqual(structuredClone(s.state.comments[0].framePath), ['#artifact']);
    assert.ok(s.sent.some(m => m.type === 'stop-pick' && m.options === undefined));
  } finally { s.close(); }
});

test('Escape in one frame stops selection in every frame', async () => {
  const s = panel();
  try {
    await wait();
    await s.w.document.querySelector('#pick').onclick();
    s.receive({ type: 'pick-cancelled' });
    await wait();
    assert.ok(s.sent.some(m => m.type === 'stop-pick'));
    assert.equal(s.w.document.querySelector('#pick').classList.contains('picking'), false);
  } finally { s.close(); }
});

test('every received port swallows the back/forward cache disconnect error immediately', () => {
  const s = panel();
  try {
    for (const name of ['pins', 'review-frame']) {
      assert.ok(s.connect(name).length > 0, `${name} port has no onDisconnect listener before the first await`);
    }
  } finally { s.close(); }
});

test('updates in another window do not switch the panel away from its own tab or close the comment being written', async () => {
  const s = panel({ otherWindow: true });
  try {
    s.state.comments = [{ id: 'mine', pageKey: 'https://claude.ai/artifact/example', selector: '#a', comment: '', createdAt: 1 }];
    await wait();
    await s.w.document.querySelector('#pick').onclick();
    s.receive({ type: 'picked', data: { selector: '#target', text: 'Target' } });
    await wait();
    const doc = s.w.document;
    assert.equal(doc.querySelector('#form').hidden, false);
    doc.querySelector('#text').value = '書きかけ';
    // 別ウィンドウでタブを再読み込み・切り替え
    s.tabEvents.updated.forEach(f => f(s.other.id, { status: 'complete' }, s.other));
    s.tabEvents.activated.forEach(f => f({ tabId: s.other.id, windowId: 2 }));
    await wait(60);
    assert.equal(doc.querySelector('#form').hidden, false);
    assert.equal(doc.querySelector('#text').value, '書きかけ');
    assert.deepEqual([...doc.querySelectorAll('#list li.item')].map(li => li.dataset.id), ['mine']);
    // このウィンドウのタブが更新されたときは描き直す(別ウィンドウのタブに切り替わらない)
    s.tabEvents.updated.forEach(f => f(10, { status: 'complete' }, {}));
    await wait(60);
    assert.equal(doc.querySelectorAll('#list li.item').length, 2);
    assert.equal(doc.querySelector('#form').hidden, false);
  } finally { s.close(); }
});
