// 拡張機能の管理画面。コメントしたページを一覧し、開く・書き出す・消すができる
const KEY = "comments";
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = (t) => (t ? new Date(t).toLocaleString("ja-JP") : "");
// レビュー番号の並び(サイドパネルと同じ)
const byOrder = (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt);

const opened = new Set(); // 中身を開いているページ(描き直しても保つ)
let all = [];

async function load() {
  all = (await chrome.storage.local.get(KEY))[KEY] || [];
  render();
  const bytes = await chrome.storage.local.getBytesInUse(null);
  summaryBytes = bytes;
  renderSummary();
}

let summaryBytes = 0;
function renderSummary(pages = groups()) {
  const open = all.filter((c) => !c.resolved).length;
  const mb = (summaryBytes / 1024 / 1024).toFixed(summaryBytes < 1024 * 1024 ? 2 : 1);
  $("#summary").textContent = `${pages.length} ページ ・ コメント ${all.length} 件(未解決 ${open})・ 保存容量 ${mb} MB`;
}

// ページごとにまとめる(最後に更新したページが上)
function groups() {
  const map = new Map();
  for (const c of all) {
    if (!map.has(c.pageKey)) map.set(c.pageKey, []);
    map.get(c.pageKey).push(c);
  }
  return [...map.entries()]
    .map(([key, list]) => {
      list.sort(byOrder);
      const latest = list.reduce((a, c) => ((c.createdAt || 0) > (a.createdAt || 0) ? c : a), list[0]);
      return {
        key,
        list,
        title: latest.title || "",
        url: latest.url || key,
        updated: Math.max(...list.map((c) => c.updatedAt || c.createdAt || 0)),
        open: list.filter((c) => !c.resolved).length,
      };
    })
    .sort((a, b) => b.updated - a.updated);
}

function matches(g, q) {
  if (!q) return true;
  const hay = [g.title, g.key, ...g.list.map((c) => `${c.comment || ""} ${c.resolution || ""} ${c.text || ""} ${c.quote || ""} ${c.author || ""}`)]
    .join("\n").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function targetBox(c) {
  const box = el("div", "target");
  if (c.image) {
    box.classList.add("has-image");
    const img = el("img");
    img.src = c.image;
    img.alt = c.text || "";
    img.onerror = () => { box.classList.remove("has-image"); box.textContent = `<${c.tag}>`; };
    box.appendChild(img);
  } else {
    const shown = c.kind === "text" ? (c.quote || "").replace(/\s+/g, " ") : c.text;
    box.textContent = shown ? `「${shown}」` : `<${c.tag}>`;
  }
  return box;
}

function render() {
  const q = $("#q").value.trim();
  const openOnly = $("#openOnly").checked;
  const pages = groups();
  const shown = pages.filter((g) => (!openOnly || g.open) && matches(g, q));
  const ul = $("#pages");
  ul.innerHTML = "";
  $("#empty").hidden = shown.length > 0;
  $("#empty").textContent = pages.length ? "条件に合うページはありません。" : "コメントしたページはまだありません。";

  for (const g of shown) {
    const li = el("li", "page" + (opened.has(g.key) ? " open" : ""));
    const head = el("div", "page-head");
    const info = el("div", "info");
    const link = el("a", "url", g.url);
    link.href = g.url;
    link.target = "_blank";
    link.onclick = (e) => e.stopPropagation();
    info.append(el("div", "title", g.title || "(タイトルなし)"), link, el("div", "meta", `最終更新 ${fmt(g.updated)}`));
    const badge = el("span", "badge" + (g.open ? "" : " clear"), g.open ? `未解決 ${g.open} / ${g.list.length}` : `すべて解決 ${g.list.length}`);

    const ops = el("div", "ops");
    const openBtn = el("button", "", "ページを開く");
    openBtn.onclick = (e) => { e.stopPropagation(); openPage(g); };
    const jsonBtn = el("button", "", "JSON出力");
    jsonBtn.onclick = (e) => { e.stopPropagation(); download(fileName(g.key), pageJson(g)); };
    const delBtn = el("button", "danger", "削除");
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`「${g.title || g.key}」のコメント ${g.list.length} 件をすべて削除しますか?\n元に戻せません。必要なら先に「JSON出力」してください。`)) return;
      const now = (await chrome.storage.local.get(KEY))[KEY] || [];
      await chrome.storage.local.set({ [KEY]: now.filter((c) => c.pageKey !== g.key) });
    };
    ops.append(openBtn, jsonBtn, delBtn);
    head.append(el("span", "caret", "▶"), info, badge, ops);
    head.onclick = () => {
      opened.has(g.key) ? opened.delete(g.key) : opened.add(g.key);
      li.classList.toggle("open");
    };

    const cl = el("ul", "comments");
    g.list.forEach((c, i) => {
      const item = el("li", c.resolved ? "done" : "");
      const body = el("div", "c-body");
      body.append(targetBox(c), el("div", "text" + (c.comment ? "" : " empty"), c.comment || "(コメント未入力)"));
      if (c.resolved && c.resolution) body.append(el("div", "resolution", c.resolution));
      body.append(el("div", "who", `${c.author || "匿名"} ・ ${fmt(c.createdAt)}${c.resolved ? " ・ 解決済み" : ""}`));
      item.append(el("span", "num", i + 1), body);
      cl.appendChild(item);
    });
    li.append(head, cl);
    ul.appendChild(li);
  }
  renderSummary(pages);
}

// サイドパネルの「JSON出力」と同じ形
function pageJson(g) {
  return {
    title: g.title,
    url: g.url,
    items: g.list.map((c, i) => ({
      no: i + 1,
      selector: c.selector,
      framePath: c.framePath || [],
      tag: c.tag,
      kind: c.kind || "element",
      targetText: c.kind === "text" ? c.quote : c.text,
      targetImage: c.image || "",
      comment: c.comment,
      resolution: c.resolved ? c.resolution || "" : "",
      author: c.author,
      resolved: !!c.resolved,
    })),
  };
}

function fileName(key) {
  try {
    const u = new URL(key);
    return `review-${u.hostname}${u.pathname}`.replace(/[^\w.-]+/g, "-").replace(/-+$/g, "");
  } catch {
    return "review-comments";
  }
}

function download(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = name + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("#exportAll").onclick = () => {
  const pages = groups();
  if (!pages.length) return alert("出力するコメントがありません");
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  download(`review-all-${ymd}`, { exportedAt: d.toISOString(), pages: pages.map(pageJson) });
};

// ---- 元のページ(管理画面を開く前に見ていたタブ)に戻る ----
const fromId = Number(new URLSearchParams(location.search).get("from"));

async function activate(t) {
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
}

async function setupBack() {
  const from = fromId ? await chrome.tabs.get(fromId).catch(() => null) : null;
  const back = $("#back");
  back.hidden = !from;
  if (!from) return;
  back.title = from.title || from.url || "";
  back.onclick = async () => {
    const t = await chrome.tabs.get(fromId).catch(() => null);
    if (!t) return (back.hidden = true); // 元のタブがもう閉じられている
    const me = await chrome.tabs.getCurrent();
    await activate(t);
    if (me) chrome.tabs.remove(me.id); // 管理画面のタブは閉じる
  };
}
chrome.tabs.onRemoved.addListener((id) => { if (id === fromId) $("#back").hidden = true; });

// すでにそのページを開いているタブがあれば切り替え、なければ新しいタブで開く
const keyOf = (u) => {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u || ""; }
};
async function openPage(g) {
  const tabs = await chrome.tabs.query({});
  const t = tabs.find((x) => x.id === fromId && keyOf(x.url) === g.key) || tabs.find((x) => keyOf(x.url) === g.key);
  if (t) return activate(t);
  chrome.tabs.create({ url: g.url });
}

$("#q").oninput = render;
$("#openOnly").onchange = render;
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[KEY]) load(); });
load();
setupBack();
