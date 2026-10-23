const KEY = "comments";
const $ = (s) => document.querySelector(s);

let tab = null;
let pageKey = "";
let pending = null;

const keyOf = (u) => {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u || ""; }
};

async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  tab = t;
  pageKey = t ? keyOf(t.url) : "";
}
async function getAll() { return (await chrome.storage.local.get(KEY))[KEY] || []; }
async function setAll(v) { await chrome.storage.local.set({ [KEY]: v }); }

function notice(msg) {
  const n = $("#notice");
  n.hidden = !msg;
  n.textContent = msg || "";
}

function send(msg) {
  if (!tab) return Promise.resolve(false);
  return chrome.tabs.sendMessage(tab.id, msg).then(() => true).catch(() => false);
}

async function pageComments() {
  const all = await getAll();
  return all.filter((c) => c.pageKey === pageKey).sort((a, b) => a.createdAt - b.createdAt);
}

async function refresh() {
  await currentTab();
  const list = await pageComments();
  const showDone = $("#showDone").checked;
  const ul = $("#list");
  ul.innerHTML = "";
  list.forEach((c, i) => {
    if (c.resolved && !showDone) return;
    const li = document.createElement("li");
    if (c.resolved) li.className = "done";

    const meta = document.createElement("div");
    meta.className = "meta";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i + 1;
    const who = document.createElement("span");
    who.textContent = `${c.author || "匿名"} ・ ${new Date(c.createdAt).toLocaleString("ja-JP")}`;
    meta.append(num, who);

    const sel = document.createElement("div");
    sel.className = "sel";
    sel.textContent = c.selector;

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = c.comment;

    const actions = document.createElement("div");
    actions.className = "actions";
    const done = document.createElement("button");
    done.textContent = c.resolved ? "再開" : "解決";
    done.onclick = async (e) => {
      e.stopPropagation();
      const all = await getAll();
      const t = all.find((x) => x.id === c.id);
      if (t) t.resolved = !t.resolved;
      await setAll(all);
    };
    const del = document.createElement("button");
    del.textContent = "削除";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("このコメントを削除しますか?")) return;
      await setAll((await getAll()).filter((x) => x.id !== c.id));
    };
    actions.append(done, del);

    li.append(meta, sel, body, actions);
    li.onclick = () => send({ type: "focus", selector: c.selector });
    ul.appendChild(li);
  });
  const open = list.filter((c) => !c.resolved).length;
  $("#count").textContent = `未解決 ${open} / 全${list.length}件`;
}

// ---- 要素選択 → コメント入力 ----
$("#pick").onclick = async () => {
  await currentTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    notice("このページでは使えません(http/https のページを開いてください)");
    return;
  }
  const ok = await send({ type: "start-pick" });
  if (!ok) {
    notice("ページを再読み込みしてからもう一度お試しください");
    return;
  }
  notice("");
  $("#pick").classList.add("picking");
  $("#pick").textContent = "左のページで要素をクリック(Escで中止)";
};

function resetPickButton() {
  $("#pick").classList.remove("picking");
  $("#pick").textContent = "＋ 要素を選んでコメント";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "picked") {
    pending = msg.data;
    resetPickButton();
    $("#target").textContent = `対象: ${pending.selector}` + (pending.text ? `\n「${pending.text}」` : "");
    $("#form").hidden = false;
    $("#text").value = "";
    $("#text").focus();
  }
  if (msg.type === "pick-cancelled") resetPickButton();
});

$("#cancel").onclick = () => {
  pending = null;
  $("#form").hidden = true;
};

$("#save").onclick = async () => {
  const comment = $("#text").value.trim();
  if (!pending || !comment) return;
  const author = $("#author").value.trim();
  await chrome.storage.local.set({ author });
  const all = await getAll();
  all.push({
    id: crypto.randomUUID(),
    ...pending,
    comment,
    author,
    createdAt: Date.now(),
    resolved: false,
  });
  await setAll(all);
  pending = null;
  $("#form").hidden = true;
};

// ---- エクスポート ----
$("#copy").onclick = async () => {
  const list = await pageComments();
  const md =
    `# レビューコメント\n${pageKey}\n\n` +
    list
      .map((c, i) => `- [${c.resolved ? "x" : " "}] #${i + 1} (${c.author || "匿名"}) ${c.comment}\n  - 対象: \`${c.selector}\``)
      .join("\n");
  await navigator.clipboard.writeText(md);
  $("#copy").textContent = "コピーしました";
  setTimeout(() => ($("#copy").textContent = "Markdownでコピー"), 1200);
};

$("#json").onclick = async () => {
  // 表示中のページ1件分を、title/url をメタデータ、コメントを items に並べて出力
  await currentTab();
  const list = await pageComments();
  const data = {
    title: (tab && tab.title) || (list[0] && list[0].title) || "",
    url: tab ? tab.url : pageKey,
    items: list.map((c, i) => ({
      no: i + 1,
      selector: c.selector,
      tag: c.tag,
      targetText: c.text,
      comment: c.comment,
      author: c.author,
      resolved: !!c.resolved,
    })),
  };
  let name = "review-comments";
  try {
    const u = new URL(pageKey);
    name = `review-${u.hostname}${u.pathname}`.replace(/[^\w.-]+/g, "-").replace(/-+$/g, "");
  } catch {}
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name + ".json";
  a.click();
};

// ---- 追従 ----
$("#showDone").onchange = refresh;
chrome.storage.onChanged.addListener((ch) => { if (ch[KEY]) refresh(); });
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.url) refresh(); });

chrome.storage.local.get("author", (r) => { $("#author").value = r.author || ""; });
refresh();
