const KEY = "comments";
const $ = (s) => document.querySelector(s);

let tab = null;
let pageKey = "";

const keyOf = (u) => {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return u || ""; }
};

// 下パネル(ページ内の iframe)として開かれているか。下パネルでは、置かれているタブだけを扱う
const DOCK = new URLSearchParams(location.search).has("dock");
if (DOCK) document.body.classList.add("dock");
let dockTab = null; // 「横に戻す」でクリック直後に同期でサイドパネルを開くため、先に取っておく
if (DOCK) chrome.tabs.getCurrent().then((t) => (dockTab = t));

async function currentTab() {
  const t = DOCK
    ? await chrome.tabs.getCurrent()
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  tab = t;
  pageKey = t ? keyOf(t.url) : "";
}
async function getAll() { return (await chrome.storage.local.get(KEY))[KEY] || []; }
async function setAll(v) { await chrome.storage.local.set({ [KEY]: v }); }
// id のコメントに patch を書き込む
async function update(id, patch) {
  const all = await getAll();
  const t = all.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  await setAll(all);
}

function notice(msg) {
  const n = $("#notice");
  n.hidden = !msg;
  n.textContent = msg || "";
}

function send(msg) {
  if (!tab) return Promise.resolve(false);
  return chrome.tabs.sendMessage(tab.id, msg).then(() => true).catch(() => false);
}

function ask(msg) {
  if (!tab) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }).catch(() => null);
}

// 対象の表示(文字なら選んだ文字、画像ならその画像・撮影した要素、それ以外は要素内の文字かタグ名)
// 長い文字は省略せず、枠の中でスクロールして読む
function renderTarget(box, c) {
  box.textContent = "";
  box.classList.toggle("has-image", !!c.image);
  if (c.image) {
    const img = document.createElement("img");
    img.src = c.image;
    img.alt = c.text || "";
    img.onerror = () => { box.classList.remove("has-image"); box.textContent = `<${c.tag}>`; };
    box.appendChild(img);
    return;
  }
  const shown = c.kind === "text" ? c.quote.replace(/\s+/g, " ") : c.text;
  box.textContent = shown ? `「${shown}」` : `<${c.tag}>`;
}

// レビュー番号の並び(並べ替えた順 order → なければ作成順)
const byOrder = (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt);

async function pageComments() {
  const all = await getAll();
  return all.filter((c) => c.pageKey === pageKey).sort(byOrder);
}

// id のコメントを beforeId の前へ動かし(null なら一番下)、番号を振り直す
async function move(id, beforeId) {
  if (id === beforeId) return;
  const list = await pageComments();
  const from = list.findIndex((c) => c.id === id);
  if (from < 0) return;
  const [m] = list.splice(from, 1);
  const to = beforeId ? list.findIndex((c) => c.id === beforeId) : list.length;
  list.splice(to < 0 ? list.length : to, 0, m);
  const order = new Map(list.map((c, i) => [c.id, i]));
  const all = await getAll();
  all.forEach((c) => { if (order.has(c.id)) c.order = order.get(c.id); });
  await setAll(all);
}

// ---- ドラッグで並べ替え(一覧全体で落とす位置を判定するので、一番上・一番下にも入れられる) ----
let dragId = null;
let dropBefore = null; // この id の前に入れる。null は一番下
const dropLine = document.createElement("li");
dropLine.className = "drop-line";

// 下パネルでは一覧が横並びなので、左右の位置で判定する
function placeDropLine(e) {
  const ul = $("#list");
  const p = DOCK ? e.clientX : e.clientY;
  const items = [...ul.querySelectorAll("li.item:not(.dragging)")];
  const next = items.find((li) => {
    const r = li.getBoundingClientRect();
    return DOCK ? p < r.left + r.width / 2 : p < r.top + r.height / 2;
  });
  dropBefore = next ? next.dataset.id : null;
  ul.insertBefore(dropLine, next || null);
  // 端に近づいたら自動でスクロール
  const r = ul.getBoundingClientRect();
  const [start, end] = DOCK ? [r.left, r.right] : [r.top, r.bottom];
  const d = p < start + 40 ? -12 : p > end - 40 ? 12 : 0;
  if (DOCK) ul.scrollLeft += d;
  else ul.scrollTop += d;
}

function endDrag() {
  dragId = null;
  dropLine.remove();
  document.querySelectorAll("li.dragging").forEach((x) => x.classList.remove("dragging"));
}

$("#list").addEventListener("dragover", (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  placeDropLine(e);
});
$("#list").addEventListener("drop", (e) => {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId, before = dropBefore;
  endDrag();
  move(id, before);
});
$("#list").addEventListener("dragleave", (e) => {
  if (!$("#list").contains(e.relatedTarget)) dropLine.remove();
});

// 編集中の状態(一覧が描き直されても編集を続けられるよう保持する)
// field: "comment"=コメント本文(未解決のみ) / "resolution"=解決コメント(解決済みのみ)
// 入力は自動で保存する(「保存」を押し忘れても残る)。「キャンセル」/Esc は編集前に戻す
let editing = null; // { id, field, draft, orig, fresh }
let editTimer = 0;

async function writeEdit() {
  clearTimeout(editTimer);
  if (!editing) return;
  await update(editing.id, { [editing.field]: editing.draft.trim(), updatedAt: Date.now() });
}

async function saveEdit() {
  await writeEdit();
  editing = null;
  refresh();
}

async function cancelEdit() {
  clearTimeout(editTimer);
  const e = editing;
  editing = null;
  if (e) await update(e.id, { [e.field]: e.orig });
  refresh();
}

function editor(c, li) {
  li.draggable = false; // テキストを選べるようにする
  const box = document.createElement("div");
  box.className = "edit";
  box.onclick = (e) => e.stopPropagation();
  const ta = document.createElement("textarea");
  ta.rows = 3;
  if (editing.field === "resolution") {
    box.classList.add("resolution-edit");
    ta.placeholder = "解決コメント(どう直したか など)";
  }
  ta.value = editing.draft;
  ta.oninput = () => {
    editing.draft = ta.value;
    clearTimeout(editTimer);
    editTimer = setTimeout(writeEdit, 400);
  };
  ta.onblur = () => {
    writeEdit();
    if (deferred) refresh();
  };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
    if (e.key === "Escape") cancelEdit();
  };
  const row = document.createElement("div");
  row.className = "row";
  row.onmousedown = (e) => e.preventDefault(); // ボタンを押しても入力欄からフォーカスを外さない
  const ok = document.createElement("button");
  ok.className = "primary";
  ok.textContent = "保存";
  ok.onclick = saveEdit;
  const cancel = document.createElement("button");
  cancel.textContent = "キャンセル";
  cancel.onclick = cancelEdit;
  row.append(ok, cancel);
  box.append(ta, row);
  if (editing.fresh) { // 開いたときだけフォーカスする(描き直しのたびに奪わない)
    editing.fresh = false;
    setTimeout(() => ta.focus(), 0);
  }
  return box;
}

// 入力中に一覧を描き直すと入力欄が作り直されるので、入力欄から離れるまで待つ
let deferred = false;
function refreshSoon() {
  if (document.activeElement?.closest?.("#list .edit")) {
    deferred = true;
    return;
  }
  refresh();
}

async function refresh() {
  deferred = false;
  const fid = formId; // 読み込み中に新しいコメントへ切り替わった場合は判定しない
  await currentTab();
  const list = await pageComments();
  // 入力欄のコメントが消えた・別のページに移ったときは入力欄を閉じる(内容は保存済み)
  if (fid && fid === formId && !list.some((c) => c.id === fid)) closeForm();
  const showDone = $("#showDone").checked;
  const ul = $("#list");
  ul.innerHTML = "";
  list.forEach((c, i) => {
    if (c.resolved && !showDone) return;
    const li = document.createElement("li");
    li.className = "item" + (c.resolved ? " done" : "") + (c.id === formId ? " writing" : "");
    li.dataset.id = c.id;
    li.draggable = true;
    li.ondragstart = (e) => {
      dragId = c.id;
      e.dataTransfer.setData("text/plain", c.id);
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => li.classList.add("dragging"), 0); // ドラッグ中の半透明画像は元の見た目で出す
    };
    li.ondragend = endDrag;

    // 左端のつまみ(ここを持ってドラッグ)
    const grip = document.createElement("div");
    grip.className = "grip";
    grip.title = "ドラッグで並べ替え";
    grip.textContent = "⋮⋮";
    const content = document.createElement("div");
    content.className = "content";

    const meta = document.createElement("div");
    meta.className = "meta";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i + 1;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `${c.author || "匿名"} ・ ${new Date(c.createdAt).toLocaleString("ja-JP")}`;
    meta.append(num, who);

    const quote = document.createElement("div");
    quote.className = "quote";
    renderTarget(quote, c);

    // 未解決は本文、解決済みは解決コメントだけを編集できる
    if (editing?.id === c.id && (editing.field === "resolution") !== !!c.resolved) editing = null;
    const isEditing = editing && editing.id === c.id;
    const body = isEditing && editing.field === "comment" ? editor(c, li) : document.createElement("div");
    if (!(isEditing && editing.field === "comment")) {
      body.className = "body" + (c.comment ? "" : " empty");
      body.textContent = c.comment || "(コメント未入力)";
    }
    let resolution = null;
    if (isEditing && editing.field === "resolution") resolution = editor(c, li);
    else if (c.resolved && c.resolution) {
      resolution = document.createElement("div");
      resolution.className = "resolution";
      resolution.textContent = c.resolution;
    }

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
    const edit = document.createElement("button");
    edit.textContent = c.resolved ? (c.resolution ? "解決コメントを編集" : "解決コメント") : "編集";
    edit.onclick = async (e) => {
      e.stopPropagation();
      if (c.id === formId) await closeForm(); // 上の入力欄と同じコメントは二重に編集しない
      const field = c.resolved ? "resolution" : "comment";
      const value = c[field] || "";
      editing = { id: c.id, field, draft: value, orig: value, fresh: true };
      refresh();
    };
    const del = document.createElement("button");
    del.textContent = "削除";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("このコメントを削除しますか?")) return;
      await setAll((await getAll()).filter((x) => x.id !== c.id));
    };
    actions.append(edit, done, del);
    if (isEditing) actions.style.display = "none";

    content.append(meta, quote, body);
    if (resolution) content.append(resolution);
    content.append(actions);
    li.append(grip, content);
    li.onclick = () => send({ type: "focus", id: c.id, selector: c.selector, framePath: c.framePath || [] });
    ul.appendChild(li);
  });
  const open = list.filter((c) => !c.resolved).length;
  $("#count").textContent = `未解決 ${open} / ${list.length}`;
}

// ---- 要素選択 → コメント入力 ----
$("#pick").onclick = async () => {
  // 選択中にもう一度押したら中止
  if ($("#pick").classList.contains("picking")) {
    await send({ type: "stop-pick" });
    resetPickButton();
    return;
  }
  await currentTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    notice("このページでは使えません(http/https のページを開いてください)");
    return;
  }
  notice("");
  $("#pick").classList.add("picking");
  $("#pick").textContent = "要素や文字を選択してください";
  const ok = await send({ type: "start-pick" });
  if (!ok) {
    resetPickButton();
    notice("ページを再読み込みしてからもう一度お試しください");
  }
};

let shortcut = "";
function resetPickButton() {
  $("#pick").classList.remove("picking");
  $("#pick").textContent = "＋ 要素・文字を選んでコメント" + (shortcut ? ` (${shortcut})` : "");
}

// 割り当て中のショートカットをボタンに表示(chrome://extensions/shortcuts で変更できる)
// 下パネルの iframe では chrome.commands が使えないので、バックグラウンドに問い合わせる
chrome.runtime.sendMessage({ type: "get-shortcut" }).then((s) => {
  // Mac では "⌥C" のように返るので、同時押しとわかるよう "⌥+C" にする(Windows は元から "Alt+C")
  shortcut = (s || "").replace(/([⌘⌥⇧⌃])(?=.)/g, "$1+");
  if (!$("#pick").classList.contains("picking")) resetPickButton();
}).catch(() => {});

// 選択中は、パネル側で押した ↑↓(外側・内側の要素)・Enter(決定)・Esc(中止)もページで押したのと同じにする
addEventListener("keydown", (e) => {
  if (!$("#pick").classList.contains("picking")) return;
  if (e.key === "ArrowUp" || e.key === "ArrowDown" || (e.key === "Enter" && !e.isComposing && !/^(TEXTAREA|INPUT)$/.test(e.target.tagName))) {
    e.preventDefault();
    send({ type: "pick-key", key: e.key });
  } else if (e.key === "Escape") {
    e.preventDefault();
    $("#pick").click();
  }
});

// ショートカットが押されたら、ボタンを押したのと同じ動きをする(選択中なら中止)
// 下パネルは自分のタブ宛てだけ、サイドパネルは自分のウィンドウで下パネルでないタブ宛てだけ受け取る
async function takePickRequest() {
  const { pickRequest: r, dockTabs = [] } = await chrome.storage.session.get(["pickRequest", "dockTabs"]);
  if (!r || Date.now() - r.at > 5000) return;
  if (DOCK) {
    if (r.tabId !== (await chrome.tabs.getCurrent())?.id) return;
  } else {
    if (r.windowId !== (await myWindow).id || dockTabs.includes(r.tabId)) return;
  }
  await chrome.storage.session.remove("pickRequest");
  $("#pick").click();
}
chrome.storage.session.onChanged.addListener((ch) => { if (ch.pickRequest?.newValue) takePickRequest(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "get-report" && report && msg.id === report.id) reply(report);
  // ページからの通知は、いま扱っているタブのものだけ受け取る(別のパネルと取り合わない)
  if (sender.tab && tab && sender.tab.id !== tab.id) return;
  if (msg.type === "picked" && sender.tab && $("#pick").classList.contains("picking")) {
    const url = sender.tab.url || tab?.url || "";
    onPicked({ ...msg.data, pageKey: keyOf(url), url, title: sender.tab.title || "" }, msg.clip);
  }
  if (msg.type === "pick-error" && sender.tab) {
    resetPickButton();
    send({ type: "stop-pick" });
    notice(msg.error || "フレーム内の要素を選択できませんでした");
  }
  if (msg.type === "pick-cancelled" && sender.tab) {
    resetPickButton();
    send({ type: "stop-pick" });
  }
});

// 選んだ時点でコメントを保存し(本文が空でも残す)、入力も自動で保存する。
// 「保存」を押し忘れて次の対象を選んだり、パネルを閉じたりしても消えない
let formId = null; // 入力欄で書いているコメントの id
let formTimer = 0;

function saveForm() {
  clearTimeout(formTimer);
  if (!formId) return Promise.resolve();
  return update(formId, { comment: $("#text").value.trim(), author: $("#author").value.trim(), updatedAt: Date.now() });
}

async function closeForm() {
  await saveForm();
  formId = null;
  $("#form").hidden = true;
  $("#list .writing")?.classList.remove("writing");
}

// 要素の見えている範囲をタブの画面から切り出す
async function captureClip(clip) {
  const bmp = await captureBitmap();
  const s = bmp.width / clip.vw;
  const [sx, sy, sw, sh] = [clip.x * s, clip.y * s, clip.w * s, clip.h * s];
  // 保存容量を抑えるため、Retina でも等倍(CSSピクセル)にし、さらに 600×900 に収まるよう縮小して WebP で保存する
  const k = Math.min(1 / s, 600 / sw, 900 / sh);
  const cv = new OffscreenCanvas(Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)));
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  return toDataURL(await cv.convertToBlob({ type: "image/webp", quality: 0.7 }));
}

async function onPicked(data, clip) {
  resetPickButton();
  await send({ type: "stop-pick" });
  await closeForm(); // 前に書いていたコメントを確定する
  if (clip) {
    await send({ type: "hide-overlays" });
    try {
      await sleep(80);
      data.image = await captureClip(clip).catch(() => "");
    } finally {
      send({ type: "clip-done" });
    }
  }
  const author = $("#author").value.trim();
  chrome.storage.local.set({ author });
  const c = { id: crypto.randomUUID(), ...data, comment: "", author, createdAt: Date.now(), resolved: false };
  const all = await getAll();
  all.push(c);
  await setAll(all);
  formId = c.id;
  renderTarget($("#target"), c);
  $("#form").hidden = false;
  $("#text").value = "";
  $("#text").focus();
}

$("#text").oninput = () => {
  clearTimeout(formTimer);
  formTimer = setTimeout(saveForm, 400);
};
$("#text").onblur = () => saveForm();
$("#text").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#save").click();
};

$("#save").onclick = closeForm;

// キャンセル = 選んだ対象ごと取り消す(自動保存したコメントを消す)
$("#cancel").onclick = async () => {
  const id = formId;
  if ($("#text").value.trim() && !confirm("入力中のコメントを取り消しますか?")) return;
  clearTimeout(formTimer);
  formId = null;
  $("#form").hidden = true;
  if (id) await setAll((await getAll()).filter((x) => x.id !== id));
};

// パネルを閉じる・隠れるときは入力途中の内容を書き込む
addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  saveForm();
  writeEdit();
});

// ---- このページのコメントを全削除 ----
$("#clearAll").onclick = async () => {
  await currentTab();
  const list = await pageComments();
  if (!list.length) return notice("削除するコメントがありません");
  if (!confirm(`このページのコメント ${list.length} 件をすべて削除しますか?\n解決済みも含みます。元に戻せないので、必要なら先に「JSON出力」で書き出してください。`)) return;
  clearTimeout(formTimer);
  formId = null;
  $("#form").hidden = true;
  editing = null;
  const ids = new Set(list.map((c) => c.id));
  await setAll((await getAll()).filter((c) => !ids.has(c.id)));
  notice("");
};

// ---- エクスポート ----
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

// ---- PDF出力(ページ全体を撮って番号の印を描き、右に修正箇所を並べたレポートを印刷) ----
let report = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toDataURL = (blob) =>
  new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });

const MAX_W = 1400;   // 出力画像の最大幅(px)
const MAX_H = 16000;  // 大きすぎると表示・印刷が重くなるので抑える

async function captureBitmap() {
  const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return createImageBitmap(await (await fetch(url)).blob());
}

// スクロールしながら撮って1枚に貼り合わせる
async function captureFullPage(info, progress) {
  const { docH, vw, vh } = info;
  const steps = Math.max(1, Math.ceil(docH / vh));
  let cv = null, ctx = null, k = 1;
  for (let i = 0; i < steps; i++) {
    progress(i + 1, steps);
    const pos = await ask({ type: "shot-scroll", y: i * vh, index: i });
    if (!pos) throw new Error("scroll failed");
    if (i) await sleep(550); // captureVisibleTab は1秒に2回まで
    const bmp = await captureBitmap();
    if (!cv) {
      k = Math.min(bmp.width / vw, MAX_W / vw, MAX_H / docH);
      cv = new OffscreenCanvas(Math.round(vw * k), Math.round(docH * k));
      ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, Math.round(pos.y * k), Math.round(vw * k), Math.round(vh * k));
    if (pos.y + vh >= docH) break;
  }
  return { cv, ctx, k };
}

// 対象に印(文字=黄色マーカー / 要素=赤枠)と番号のピンを描く
function drawMarks(ctx, k, targets, numbers) {
  targets.forEach((t) => {
    const no = numbers.get(t.id);
    if (!no || !t.rects.length) return;
    t.rects.forEach((r) => {
      const [x, y, w, h] = [r.x * k, r.y * k, r.w * k, r.h * k];
      if (t.text) {
        ctx.fillStyle = "rgba(250,204,21,.35)";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#eab308";
        ctx.fillRect(x, y + h - 2, w, 2);
      } else {
        ctx.strokeStyle = "#dc2626";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
      }
    });
    const r0 = t.rects[0];
    const rad = 13;
    const cx = Math.max(rad, r0.x * k), cy = Math.max(rad, r0.y * k);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = "#dc2626";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(no), cx, cy + 1);
  });
}

$("#pdf").onclick = async () => {
  await currentTab();
  const showDone = $("#showDone").checked;
  const all = await pageComments();
  const targets = all.map((c, i) => ({ c, no: i + 1 })).filter(({ c }) => showDone || !c.resolved);
  if (!targets.length) return notice("出力するコメントがありません");
  if (!(await send({ type: "ping" }))) return notice("ページを再読み込みしてからもう一度お試しください");
  notice("撮影中はタブを切り替えないでください");
  const btn = $("#pdf");
  btn.disabled = true;
  let image = null;
  let found = new Set();
  let tops = new Map(); // 対象の上端(ページ座標)。レポートで修正箇所を対象の横に並べるのに使う
  let vw = 0;
  try {
    const info = await ask({ type: "shot-begin" });
    if (!info) throw new Error("begin failed");
    const { cv, ctx, k } = await captureFullPage(info, (i, n) => (btn.textContent = `撮影中 ${i}/${n}`));
    const numbers = new Map(targets.map(({ c, no }) => [c.id, no]));
    drawMarks(ctx, k, info.targets, numbers);
    found = new Set(info.targets.filter((t) => t.rects.length).map((t) => t.id));
    tops = new Map(info.targets.filter((t) => t.rects.length).map((t) => [t.id, Math.min(...t.rects.map((r) => r.y))]));
    vw = info.vw;
    image = await toDataURL(await cv.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
  } catch {
    notice("撮影できませんでした。ページを再読み込みしてもう一度お試しください");
  } finally {
    await send({ type: "shot-end" });
    btn.disabled = false;
    btn.textContent = "PDF出力";
  }
  if (!image) return;
  notice("");
  report = {
    id: crypto.randomUUID(),
    title: tab.title || "",
    url: tab.url || pageKey,
    createdAt: Date.now(),
    image,
    vw,
    items: targets.map(({ c, no }) => ({
      y: tops.has(c.id) ? tops.get(c.id) : null,
      no,
      found: found.has(c.id),
      kind: c.kind || "element",
      target: c.kind === "text" ? c.quote.replace(/\s+/g, " ") : c.text,
      tag: c.tag,
      targetImage: c.image || "",
      comment: c.comment,
      resolution: c.resolved ? c.resolution || "" : "",
      author: c.author,
      createdAt: c.createdAt,
      resolved: !!c.resolved,
    })),
  };
  chrome.tabs.create({ url: `report.html?id=${report.id}` });
};

// ---- ページ側にパネルが開いていることを伝える(接続が切れる=パネルを閉じた) ----
const myWindow = chrome.windows.getCurrent();
chrome.runtime.onConnect.addListener(async (p) => {
  // ページが戻る・進むのキャッシュに入ると Chrome が接続を切る。エラーとして出さないよう受け止める。
  // 使わない接続(各フレームの "review-frame")や、下の await 中に切れた接続も対象なので最初に登録する
  p.onDisconnect.addListener(() => void chrome.runtime.lastError);
  if (p.name !== "pins") return;
  const ok = DOCK
    ? p.sender?.tab?.id === (await chrome.tabs.getCurrent())?.id
    : p.sender?.tab?.windowId === (await myWindow).id; // 別ウィンドウのタブは対象外
  if (!ok) return p.disconnect();
  p.postMessage({ type: "panel-ok" });
});
if (!DOCK) {
  myWindow.then(async (win) => {
    for (const t of await chrome.tabs.query({ windowId: win.id })) {
      chrome.tabs.sendMessage(t.id, { type: "panel-opened" }).catch(() => {});
    }
  });
}

// ---- 下パネルの左右の境目(コメント入力側の幅)をドラッグで変える ----
if (DOCK) {
  const setLeft = (w) => {
    w = Math.round(Math.max(260, Math.min(w, innerWidth - 300)));
    document.body.style.setProperty("--left", w + "px");
    return w;
  };
  chrome.storage.local.get("dockLeft", (r) => r.dockLeft && setLeft(r.dockLeft));
  $("#splitter").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const sp = $("#splitter");
    sp.classList.add("on");
    let w = 0;
    const move = (ev) => (w = setLeft(ev.clientX));
    const up = () => {
      sp.classList.remove("on");
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      if (w) chrome.storage.local.set({ dockLeft: w });
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  });
}

// ---- 表示場所の切り替え(サイドパネル ⇄ ページ下部の下パネル) ----
async function setDocked(tabId, on) {
  const { dockTabs = [] } = await chrome.storage.session.get("dockTabs");
  const next = dockTabs.filter((t) => t !== tabId);
  if (on) next.push(tabId);
  await chrome.storage.session.set({ dockTabs: next });
}

$("#toBottom").onclick = async () => {
  await currentTab();
  if (!tab || !(await send({ type: "ping" }))) return notice("このページでは下に表示できません(ページを再読み込みしてください)");
  await setDocked(tab.id, true);
  await send({ type: "dock-open" });
  window.close(); // サイドパネルを閉じる
};

$("#toSide").onclick = async () => {
  if (dockTab) chrome.sidePanel.open({ windowId: dockTab.windowId }).catch(() => {}); // await より前に呼ぶ必要がある
  await currentTab();
  await setDocked(tab.id, false);
  send({ type: "dock-close" }); // この iframe ごと消える
};

// 管理画面(コメントしたページの一覧)を開く。元のタブへ戻れるよう、いま見ているタブを渡す
// すでに管理画面のタブがあれば、それを使い回す
$("#manage").onclick = async () => {
  await currentTab();
  const base = chrome.runtime.getURL("manage.html");
  const url = base + (tab ? `?from=${tab.id}` : "");
  const old = (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith(base));
  if (old) {
    await chrome.tabs.update(old.id, { url, active: true });
    chrome.windows.update(old.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url, ...(tab ? { windowId: tab.windowId, index: tab.index + 1 } : {}) });
  }
};

$("#closeDock").onclick = async () => {
  await currentTab();
  await setDocked(tab.id, false);
  send({ type: "dock-close" });
};

// ---- 追従 ----
$("#showDone").onchange = refresh;
chrome.storage.onChanged.addListener((ch) => { if (ch[KEY]) refreshSoon(); });
if (!DOCK) chrome.tabs.onActivated.addListener(refreshSoon);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.url) refreshSoon(); });

chrome.storage.local.get("author", (r) => { $("#author").value = r.author || ""; });
refresh();
takePickRequest(); // ショートカットでパネルを開いた場合
