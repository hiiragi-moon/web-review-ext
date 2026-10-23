const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = (t) => new Date(t).toLocaleString("ja-JP");

function target(it) {
  const box = el("div", "target");
  if (it.targetImage) {
    const img = el("img");
    img.src = it.targetImage;
    img.onerror = () => { box.textContent = `<${it.tag}>`; };
    box.appendChild(img);
  } else {
    box.textContent = it.target ? `「${it.target}」` : `<${it.tag}>`;
  }
  return box;
}

// 内容の大きさに合わせて用紙サイズを決め、1ページに収める
// ・印刷時は画面とわずかにレイアウトがずれる(フォント等)。高さが少しでも足りないと
//   画像が丸ごと2ページ目に送られるので、高さに余裕を持たせ、画像も用紙内に収まる高さに抑える
// ・PDFの1辺は200インチ(=19200px)までなので、超える分は縮小する
function fitOnePage() {
  const sheet = $("#sheet");
  sheet.style.zoom = "";
  const w = sheet.offsetWidth, h = sheet.offsetHeight;
  const rest = h - $("#shot").offsetHeight; // 図以外の部分の高さ(配置が横でも下でも使える)
  const pageH = Math.min(19000, Math.ceil(h * 1.03 + 120));
  const zoom = Math.min(1, 19000 / (h * 1.03 + 120));
  sheet.style.zoom = zoom;
  const shotMax = Math.floor(pageH / zoom - rest - 24);
  $("#page-size").textContent =
    `@page { size: ${Math.ceil(w * zoom)}px ${pageH}px; margin: 0; }\n` +
    `@media print { #shot { max-height: ${shotMax}px; object-fit: contain; object-position: left top; } }`;
}

// 画像の読み込みを待つ(大きな画像で decode() が終わらないことがあるので load と時間切れで判断)
const loaded = (img) =>
  new Promise((res) => {
    if (img.complete) return res();
    img.addEventListener("load", res, { once: true });
    img.addEventListener("error", res, { once: true });
    setTimeout(res, 8000);
  });

function render(r) {
  if (!r) {
    $("#title").textContent = "レビュー結果が見つかりません";
    $("#meta").textContent = "サイドパネルから、もう一度「PDF出力」を押してください。";
    return;
  }
  $("#title").textContent = r.title || "レビュー結果";
  $("#meta").textContent = `${r.url}\n出力日時: ${fmt(r.createdAt)} ・ ${r.items.length}件`;

  // 保存時の既定ファイル名になる
  let host = "";
  try { host = new URL(r.url).hostname + new URL(r.url).pathname; } catch {}
  const d = new Date(r.createdAt);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  document.title = `${ymd}_review_${host}`.replace(/[^\w.-]+/g, "-").replace(/-+$/g, "");

  const ol = $("#items");
  r.items.forEach((it) => {
    const li = el("li", it.resolved ? "done" : "");
    const head = el("div", "head");
    head.append(
      el("span", "num", it.no),
      el("span", "", `${it.author || "匿名"} ・ ${fmt(it.createdAt)}`),
      el("span", "status", it.resolved ? "解決済み" : "未解決")
    );
    li.append(head, target(it));
    if (!it.found) li.appendChild(el("div", "missing", "※ 撮影時に画面に見えていなかったため、左の図に印はありません"));
    li.appendChild(el("div", "comment", it.comment));
    if (it.resolution) li.appendChild(el("div", "resolution", it.resolution));
    ol.appendChild(li);
  });

  $("#shot").src = r.image;
  report = r;
  // 画像を読み終えてから用紙サイズを決め、PDFを作ってダウンロードする
  Promise.all([...document.images].map(loaded)).then(async () => {
    const { reportLayout } = await chrome.storage.local.get("reportLayout");
    setLayout(reportLayout === "below" ? "below" : "side");
    downloadPdf();
  });
}

let report = null;

// 修正箇所を、左の図で対象がある高さの横に置く。重なる場合は下へずらす。
// 図に印のないもの(撮影時に見えなかった対象)は最後にまとめる
function layoutNotes() {
  const ol = $("#items");
  const shot = $("#shot");
  const scale = report.vw ? shot.clientWidth / report.vw : 0;
  const lis = [...ol.children];
  const placed = report.items
    .map((it, i) => ({ li: lis[i], y: it.y }))
    .sort((a, b) => (a.y ?? Infinity) - (b.y ?? Infinity));
  // 番号の丸(上から約19px)が図のピンと同じ高さに来るようにする
  const offset = shot.offsetTop - ol.offsetTop - 19;
  let bottom = 0;
  placed.forEach(({ li, y }) => {
    const want = y != null && scale ? y * scale + offset : bottom;
    const top = Math.max(want, bottom);
    li.style.top = top + "px";
    bottom = top + li.offsetHeight + 8;
  });
  ol.style.height = bottom + "px";
}

// 修正箇所の配置: side=図の横(対象の高さに合わせる) / below=図の下に横並び
function setLayout(mode) {
  document.querySelector(`input[name="layout"][value="${mode}"]`).checked = true;
  $("#sheet").classList.toggle("below", mode === "below");
  if (mode === "side") layoutNotes();
  else [...$("#items").children].forEach((li) => (li.style.top = ""));
}

document.querySelectorAll('input[name="layout"]').forEach((r) =>
  r.addEventListener("change", () => {
    if (!report) return;
    setLayout(r.value);
    chrome.storage.local.set({ reportLayout: r.value }); // 次回も同じ配置で出力する
  })
);

const status = (t) => ($("#status").textContent = t);

async function downloadPdf() {
  const btn = $("#download");
  btn.disabled = true;
  status("PDFを作成中…");
  fitOnePage();
  try {
    const r = await chrome.runtime.sendMessage({ type: "make-pdf" });
    if (!r || r.error) throw new Error(r?.error);
    const bin = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([bin], { type: "application/pdf" }));
    a.download = document.title + ".pdf";
    a.click();
    status("PDFをダウンロードしました");
  } catch {
    status("PDFを作れませんでした。「印刷画面で保存」をお試しください");
  } finally {
    btn.disabled = false;
  }
}

$("#download").onclick = downloadPdf;
$("#print").onclick = () => { fitOnePage(); print(); };
addEventListener("resize", () => report && !$("#sheet").classList.contains("below") && layoutNotes());
chrome.runtime
  .sendMessage({ type: "get-report", id: new URLSearchParams(location.search).get("id") })
  .then(render, () => render(null));
