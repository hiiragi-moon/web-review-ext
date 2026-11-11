const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const wait = () => new Promise(resolve => setTimeout(resolve, 30));

function panel() {
  const dom = new JSDOM(fs.readFileSync('sidepanel.html', 'utf8'), { url: 'https://extension.test/sidepanel.html', runScripts: 'outside-only' });
  const w = dom.window, handlers = [], sent = [], state = { comments: [] };
  const tab = { id: 10, windowId: 1, url: 'https://claude.ai/artifact/example', title: 'Artifact' };
  const event = { addListener() {} };
  w.chrome = {
    runtime: { onMessage: { addListener: f => handlers.push(f) }, onConnect: event, sendMessage: async () => '' },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [tab],
      sendMessage: async (id, msg, options) => { sent.push({ id, ...msg, options }); return { ok: true }; },
      onActivated: event, onUpdated: event,
    },
    storage: {
      local: { get: async (key, cb) => { if (cb) cb(state); return state; }, set: async patch => Object.assign(state, patch) },
      session: { get: async () => ({}), onChanged: event }, onChanged: event,
    },
  };
  w.eval(fs.readFileSync('sidepanel.js', 'utf8'));
  const receive = (msg, frameId = 2) => handlers.forEach(f => f(msg, { tab, frameId }, () => {}));
  return { w, state, sent, receive, close: () => dom.window.close() };
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
