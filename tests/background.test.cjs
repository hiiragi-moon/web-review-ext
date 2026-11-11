const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker() {
  const listeners = () => ({ fns: [], addListener(f) { this.fns.push(f); } });
  const onMessage = listeners(), onConnect = listeners(), sent = [];
  const chrome = {
    runtime: { onMessage, onConnect, onInstalled: listeners() },
    tabs: { onRemoved: listeners(), sendMessage: async (tabId, msg, options) => {
      sent.push({ tabId, ...msg, options });
      if (options?.frameId === 9) throw new Error('frame unloaded');
      return msg.type === 'frame-state' ? { picking: true, dock: true } : [{ id: `comment-${options?.frameId}`, rects: [] }];
    } },
    commands: { onCommand: listeners() },
    storage: { session: { get: async () => ({}), onChanged: listeners() } },
  };
  vm.runInNewContext(fs.readFileSync('background.js', 'utf8'), { chrome, console, URL });
  const connect = frameId => {
    const onDisconnect = listeners();
    const p = { name: 'review-frame', sender: { tab: { id: 10 }, frameId }, onDisconnect };
    onConnect.fns.forEach(f => f(p));
    return () => onDisconnect.fns.forEach(f => f());
  };
  const request = (type, frameId = 0) => new Promise(resolve => onMessage.fns.forEach(f => f({ type }, { tab: { id: 10, url: 'https://claude.ai/artifact/example?view=preview', title: 'Artifact' }, frameId }, resolve)));
  return { connect, request, sent };
}

test('PDF collector addresses each child separately, tolerates navigation and excludes the parent', async () => {
  const w = worker();
  w.connect(0); w.connect(2); w.connect(7); w.connect(9);
  const result = await w.request('collect-frame-targets');
  assert.deepEqual(structuredClone(result), [{ id: 'comment-2', rects: [] }, { id: 'comment-7', rects: [] }]);
  assert.deepEqual(w.sent.map(m => m.options.frameId), [2, 7, 9]);
});

test('a stale disconnected document cannot remove its replacement from the collector', async () => {
  const w = worker();
  const disconnectOld = w.connect(2);
  w.connect(2);
  disconnectOld();
  const result = await w.request('collect-frame-targets');
  assert.deepEqual(structuredClone(result), [{ id: 'comment-2', rects: [] }]);
});

test('late-loading child gets selection state from frame zero', async () => {
  const w = worker();
  const state = await w.request('initial-frame-state', 5);
  assert.deepEqual(state, { picking: true, dock: true });
  assert.deepEqual(structuredClone(w.sent), [{ tabId: 10, type: 'frame-state', options: { frameId: 0 } }]);
});


test('parent page identity is returned only on the extension runtime channel', async () => {
  const w = worker();
  const page = await w.request('frame-page', 5);
  assert.deepEqual(structuredClone(page), {
    pageKey: 'https://claude.ai/artifact/example',
    url: 'https://claude.ai/artifact/example?view=preview',
    title: 'Artifact',
  });
});
