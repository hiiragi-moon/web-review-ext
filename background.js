// アイコンクリックで右側にサイドパネルを開く
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ---- 下パネル表示中のタブ(storage.session の dockTabs)。ショートカットの判断用に手元にも持つ ----
let docked = new Set();
chrome.storage.session.get("dockTabs").then((r) => (docked = new Set(r.dockTabs || [])));
chrome.storage.session.onChanged.addListener((ch) => {
  if (ch.dockTabs) docked = new Set(ch.dockTabs.newValue || []);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { dockTabs = [] } = await chrome.storage.session.get("dockTabs");
  if (dockTabs.includes(tabId)) chrome.storage.session.set({ dockTabs: dockTabs.filter((t) => t !== tabId) });
});

// ショートカット(既定 Option+C / Alt+C)。選択開始を依頼する(下パネル表示中のタブは下パネルが受け取る)
// sidePanel.open はユーザー操作の直後に同期で呼ぶ必要があるので await しない
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "start-pick" || !tab) return;
  chrome.storage.session.set({ pickRequest: { at: Date.now(), tabId: tab.id, windowId: tab.windowId } });
  if (!docked.has(tab.id)) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// ページ側から、このタブで下パネルを出すかを問い合わせる(再読み込みしても下パネルを保つ)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type !== "dock-state" || !sender.tab) return;
  chrome.storage.session.get("dockTabs").then((r) => reply({ open: (r.dockTabs || []).includes(sender.tab.id) }));
  return true;
});

// レポート画面を1ページのPDFにする。印刷画面を通すと用紙サイズの指定が効かない場合があるため、
// Chrome の PDF 作成機能(DevTools Protocol の Page.printToPDF)を使う
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type !== "make-pdf" || !sender.tab) return;
  const target = { tabId: sender.tab.id };
  (async () => {
    await chrome.debugger.attach(target, "1.3");
    try {
      const { data } = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
        printBackground: true,
        preferCSSPageSize: true,
      });
      reply({ data });
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
  })().catch((e) => reply({ error: String(e?.message || e) }));
  return true;
});
