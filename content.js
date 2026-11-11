(() => {
  if (window.__rcLoaded) return;
  window.__rcLoaded = true;

  const KEY = "comments";
  const frames = ReviewFrames.create(cssPath);
  let frameContext = null;
  let dockVisible = false;
  let frameShooting = false;
  const pageKey = () => frameContext?.pageKey;
  const owns = (c) => frameContext && JSON.stringify(c.framePath || []) === JSON.stringify(frameContext.framePath);

  // ---- オーバーレイ(Shadow DOMでサイトのCSSと分離) ----
  const host = document.createElement("div");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .hl{position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.15);pointer-events:none;display:none;box-sizing:border-box}
      .tag{position:fixed;background:#2563eb;color:#fff;font:11px/1.4 system-ui,sans-serif;padding:2px 6px;border-radius:3px;pointer-events:none;display:none;white-space:nowrap}
      .pin{position:fixed;width:22px;height:22px;border-radius:50%;background:#dc2626;color:#fff;font:bold 12px/22px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.4);transform:translate(-50%,-50%);pointer-events:none}
      .pin.done{background:#16a34a}
      .flash{position:fixed;border:3px solid #f59e0b;background:rgba(245,158,11,.25);pointer-events:none;box-sizing:border-box}
      .mark{position:fixed;background:rgba(250,204,21,.35);border-bottom:2px solid #eab308;pointer-events:none;box-sizing:border-box}
      .mark.done{background:rgba(22,163,74,.12);border-color:#16a34a}
    </style>
    <div class="hl"></div><div class="tag"></div><div class="marks"></div><div class="pins"></div><div class="flashbox"></div>`;
  document.documentElement.appendChild(host);

  const hl = shadow.querySelector(".hl");
  const tag = shadow.querySelector(".tag");
  const marksBox = shadow.querySelector(".marks");
  const pinsBox = shadow.querySelector(".pins");
  const flashBox = shadow.querySelector(".flashbox");

  // ---- セレクタ生成 ----
  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
        parts.unshift("#" + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      const cls = [...el.classList].filter((c) => !/^\d|:/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const sibs = [...(el.parentNode?.children || [])].filter(
        (s) => s.tagName === el.tagName
      );
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(el) + 1})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  // ---- 文字範囲 <-> 要素内の文字位置(textContent基準) ----
  function textOffset(root, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  function rangeFromOffsets(root, start, end) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0, started = false, n;
    while ((n = w.nextNode())) {
      const len = n.data.length;
      if (!started && start <= pos + len) {
        r.setStart(n, start - pos);
        started = true;
      }
      if (started && end <= pos + len) {
        r.setEnd(n, end - pos);
        return r;
      }
      pos += len;
    }
    return null;
  }

  // 保存済みの文字コメントの位置を探す。文言が変わっていたら前後の文脈→最初の一致の順で探す
  function locateText(c) {
    let root = null;
    try {
      root = document.querySelector(c.selector);
    } catch {}
    if (!root) return null;
    const full = root.textContent;
    const { start, prefix = "", suffix = "" } = c.range;
    const q = c.quote;
    let at = full.substr(start, q.length) === q ? start : -1;
    if (at < 0) {
      const ctx = full.indexOf(prefix + q + suffix);
      at = ctx >= 0 ? ctx + prefix.length : full.indexOf(q);
    }
    if (at < 0) return null;
    return rangeFromOffsets(root, at, at + q.length);
  }

  // コメントの対象(要素 or 文字範囲)を、表示判定用の要素と矩形リストで返す
  function targetOf(c) {
    if (!owns(c)) return null;
    if (c.kind === "text" && c.range) {
      const range = locateText(c);
      if (!range) return null;
      const el = range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      return { el, rects, text: true };
    }
    let el = null;
    try {
      el = document.querySelector(c.selector);
    } catch {}
    return el ? { el, rects: [el.getBoundingClientRect()], text: false } : null;
  }

  // ---- 選択モード(クリック=要素 / ドラッグ=文字) ----
  let picking = false;
  let hoverEl = null;
  let baseEl = null; // マウスの下にあるいちばん内側の要素。↑↓ で hoverEl をその外側へ広げる

  // サイト側で文字選択を禁止していても選べるようにする
  const selectStyle = document.createElement("style");
  selectStyle.textContent = "*{-webkit-user-select:text!important;user-select:text!important}";

  function drawHl(el) {
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, {
      display: "block",
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    tag.textContent =
      el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + "  クリック=要素 / ドラッグ=文字 / ↑↓=外側・内側の要素";
    Object.assign(tag.style, {
      display: "block",
      left: r.left + "px",
      top: Math.max(0, r.top - 20) + "px",
    });
  }

  function hideHl() {
    hl.style.display = "none";
    tag.style.display = "none";
  }

  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  // サイトには渡さないが、既定動作(文字選択)は残す
  const stop = (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  function clearHover() {
    hoverEl = baseEl = null;
    hideHl();
  }

  function onOut(e) {
    const next = e.relatedTarget;
    // iframe内のイベントは親documentへ届かないため、境界を越えた時点で消す。
    if (!next || next.ownerDocument !== document || /^(IFRAME|FRAME)$/.test(next.tagName || "")) clearHover();
  }

  function onMove(e) {
    if (e.buttons & 1) return hideHl(); // ドラッグ中は文字選択の邪魔をしない
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // フレーム内の対象はそのフレームのスクリプトが表示する。枠全体を重ねない。
    if (!el || el === host || el === dock?.el || /^(IFRAME|FRAME)$/.test(el.tagName)) return clearHover();
    if (el === baseEl && hoverEl) return drawHl(hoverEl); // 同じ要素の上なら、↑↓ で選んだ外側の要素を保つ
    baseEl = hoverEl = el;
    drawHl(el);
  }

  // ↑ で外側(親)の要素へ広げ、↓ でマウスの下の要素の方へ戻す
  function widen(up) {
    if (!hoverEl || !baseEl) return;
    if (up) {
      const p = hoverEl.parentElement;
      if (p && p !== document.body && p !== document.documentElement) hoverEl = p;
    } else if (hoverEl !== baseEl) {
      let c = baseEl;
      while (c.parentElement && c.parentElement !== hoverEl) c = c.parentElement;
      hoverEl = c;
    }
    drawHl(hoverEl);
  }

  async function resolveFrameContext(clip = null) {
    const c = await frames.context(clip);
    if (frames.isTop) return c;
    // 親URL・タイトルはページのpostMessageに流さず、拡張機能内部だけで取得する。
    const page = await chrome.runtime.sendMessage({ type: "frame-page" });
    if (!page?.pageKey) throw new Error("親ページの情報を取得できません。ページを再読み込みしてください。");
    return { ...c, ...page };
  }

  async function emitPicked(data, clip = null) {
    try {
      const c = await resolveFrameContext(clip);
      frameContext = c;
      const { pageKey, url, title, framePath } = c;
      chrome.runtime.sendMessage({ type: "picked", data: { ...data, pageKey, url, title, framePath }, clip: c.clip });
    } catch (e) {
      showOverlay();
      chrome.runtime.sendMessage({ type: "pick-error", error: e.message });
    }
  }

  // 画像(またはテキストのない要素の中の画像1枚)なら、その画像のURLを返す
  function imageOf(el) {
    const img = el.tagName === "IMG" ? el : !el.innerText?.trim() && el.querySelectorAll("img").length === 1 ? el.querySelector("img") : null;
    const src = img && (img.currentSrc || img.src);
    return src && src.length < 200000 ? src : "";
  }

  // 要素の見えている範囲(下パネルに隠れた部分は除く)。サイドパネル側でこの範囲を撮影する
  function clipOf(el) {
    const r = el.getBoundingClientRect();
    const bottom = innerHeight - (dock ? dock.height : 0);
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x, h = Math.min(bottom, r.bottom) - y;
    return w >= 4 && h >= 4 ? { x, y, w, h, vw: innerWidth } : null;
  }

  // 撮影のために隠したピンなどを戻す(サイドパネルから撮影済みの連絡が来ないときも時間で戻す)
  let overlayTimer = 0;
  function showOverlay() {
    clearTimeout(overlayTimer);
    if (!shot && !frameShooting) host.style.display = "";
  }

  function pickElement(el) {
    stopPick();
    const image = imageOf(el);
    const data = {
      kind: "element",
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.alt || "").trim().slice(0, 2000),
      image,
    };
    // 画像以外の要素は見た目を撮って対象として表示する。写り込まないようピンなどを隠してから知らせる
    const clip = image ? null : clipOf(el);
    if (!clip) return emitPicked(data);
    host.style.display = "none";
    overlayTimer = setTimeout(showOverlay, 3000);
    setTimeout(() => emitPicked(data, clip), 80);
  }

  // 選択範囲を文字コメントの対象にする。前後の空白は除き、選べなければ false
  function pickText(range) {
    let root = range.commonAncestorContainer;
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root || root === host) return false;
    const full = root.textContent;
    let s = textOffset(root, range.startContainer, range.startOffset);
    let e = textOffset(root, range.endContainer, range.endOffset);
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    if (s >= e) return false;
    const quote = full.slice(s, e);
    stopPick();
    emitPicked({
      kind: "text",
      selector: cssPath(root),
      tag: root.tagName.toLowerCase(),
      text: quote.replace(/\s+/g, " ").slice(0, 80),
      quote,
      range: { start: s, prefix: full.slice(Math.max(0, s - 20), s), suffix: full.slice(e, e + 20) },
    });
    return true;
  }

  function selectedRange() {
    const sel = getSelection();
    return sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
  }

  function onUp(e) {
    stop(e);
    if (e.button !== 0) return;
    const range = selectedRange();
    if (range && pickText(range)) return;
    if (hoverEl) pickElement(hoverEl);
  }

  function onKey(e) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      block(e);
      return widen(e.key === "ArrowUp");
    }
    if (e.key === "Escape") {
      block(e);
      stopPick();
      chrome.runtime.sendMessage({ type: "pick-cancelled" });
    }
  }

  const stopEvents = ["mousedown", "pointerdown", "pointerup"];
  const blockEvents = ["click", "dblclick", "auxclick", "contextmenu", "dragstart"];

  // ページで最後に選んだ文字。サイドパネルのボタンを押してページからフォーカスが外れると
  // 選択が消えることがあるので覚えておく(ページ上でクリックしたり選択を外したりしたら忘れる)
  let lastSel = null;
  document.addEventListener("selectionchange", () => {
    if (picking) return;
    const r = selectedRange();
    if (r) lastSel = r.cloneRange();
    else if (document.hasFocus()) lastSel = null;
  });
  document.addEventListener("mousedown", () => { if (!picking) lastSel = null; }, true);

  function startPick() {
    if (picking) return;
    // ボタンを押す前に文字を選んでいたら、その文字をそのまま対象にする
    const inChild = /^(IFRAME|FRAME)$/.test(document.activeElement?.tagName || "");
    const pre = !inChild && (selectedRange() || (lastSel?.startContainer.isConnected ? lastSel : null));
    lastSel = null;
    if (pre && pickText(pre)) {
      getSelection()?.removeAllRanges();
      return;
    }
    getSelection()?.removeAllRanges();
    picking = true;
    document.documentElement.style.cursor = "crosshair";
    document.head.appendChild(selectStyle);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("mouseleave", clearHover);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("keydown", onKey, true);
    stopEvents.forEach((t) => document.addEventListener(t, stop, true));
    blockEvents.forEach((t) => document.addEventListener(t, block, true));
  }

  function stopPick() {
    picking = false;
    hoverEl = baseEl = null;
    document.documentElement.style.cursor = "";
    selectStyle.remove();
    hideHl();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseout", onOut, true);
    document.removeEventListener("mouseleave", clearHover);
    document.removeEventListener("mouseup", onUp, true);
    document.removeEventListener("keydown", onKey, true);
    stopEvents.forEach((t) => document.removeEventListener(t, stop, true));
    blockEvents.forEach((t) => document.removeEventListener(t, block, true));
  }

  // ---- ピン表示(保存済みコメントの位置) ----
  let comments = [];

  // ---- サイドパネルが開いているか(パネルとの接続が切れたら閉じたと判断) ----
  let panelOpen = false;
  let port = null;
  function connectPanel() {
    if (port) return;
    let p;
    try {
      p = port = chrome.runtime.connect({ name: "pins" });
    } catch {
      return; // 拡張が更新・削除された後の古いスクリプト
    }
    p.onMessage.addListener((m) => {
      if (m.type === "panel-ok") {
        panelOpen = true;
        renderPins();
      }
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== p) return; // つなぎ直した後に古い接続の切断が届いた
      port = null;
      panelOpen = false;
      if (picking && !dock && !dockVisible) stopPick();
      renderPins();
    });
  }

  // ---- 下パネル(サイドパネルと同じ画面を、ページ下部の iframe で出す) ----
  let dock = null;
  const DOCK_MIN = 180;

  async function openDock() {
    dockVisible = true;
    if (!frames.isTop || dock) return renderPins();
    const { dockHeight = 320 } = await chrome.storage.local.get("dockHeight");
    const el = document.createElement("div");
    el.style.cssText = "all:initial;position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:block;";
    const sh = el.attachShadow({ mode: "open" });
    sh.innerHTML = `
      <style>
        .bar{position:absolute;left:0;right:0;top:0;height:6px;cursor:ns-resize;background:#e5e7eb;border-top:1px solid #d1d5db;box-sizing:border-box}
        .bar:hover,.bar.on{background:#93c5fd}
        iframe{position:absolute;left:0;top:6px;width:100%;height:calc(100% - 6px);border:0;background:#fff;color-scheme:light}
        .cover{position:fixed;inset:0;display:none;cursor:ns-resize}
      </style>
      <div class="bar" title="ドラッグで高さを変更"></div><iframe></iframe><div class="cover"></div>`;
    sh.querySelector("iframe").src = chrome.runtime.getURL("sidepanel.html?dock=1");
    // ページの最後が下パネルに隠れないよう、同じ高さの余白を足す
    const spacer = document.createElement("style");
    document.documentElement.appendChild(el);
    document.head.appendChild(spacer);
    dock = { el, spacer };
    setDockHeight(dockHeight);

    // 上端のバーをドラッグして高さを変える(iframe 上でもマウスを追えるよう全面に覆いを出す)
    const bar = sh.querySelector(".bar"), cover = sh.querySelector(".cover");
    bar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      cover.style.display = "block";
      bar.classList.add("on");
      const move = (ev) => setDockHeight(innerHeight - ev.clientY);
      const up = () => {
        cover.style.display = "none";
        bar.classList.remove("on");
        removeEventListener("mousemove", move, true);
        removeEventListener("mouseup", up, true);
        chrome.storage.local.set({ dockHeight: dock.height });
      };
      addEventListener("mousemove", move, true);
      addEventListener("mouseup", up, true);
    });
    renderPins();
  }

  function setDockHeight(h) {
    h = Math.round(Math.max(DOCK_MIN, Math.min(h, innerHeight - 80)));
    dock.height = h;
    dock.el.style.height = h + "px";
    dock.spacer.textContent = `html::after{content:"";display:block;height:${h}px}`;
  }

  function closeDock() {
    dockVisible = false;
    if (!dock) {
      if (picking && !panelOpen) stopPick();
      return renderPins();
    }
    dock.el.remove();
    dock.spacer.remove();
    dock = null;
    if (picking && !panelOpen) stopPick();
    renderPins();
  }
  // レビュー番号の並び(並べ替えた順 order → なければ作成順)。サイドパネルと同じ
  const byOrder = (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt);

  async function load(onlyIfMoved = false) {
    try {
      const next = await resolveFrameContext();
      const unchanged = frameContext?.pageKey === next.pageKey &&
        JSON.stringify(frameContext?.framePath) === JSON.stringify(next.framePath);
      frameContext = next;
      if (onlyIfMoved && unchanged) return;
    } catch { return; }
    chrome.storage.local.get(KEY, (r) => {
      comments = (r[KEY] || [])
        .filter((c) => c.pageKey === pageKey())
        .sort(byOrder);
      renderPins();
    });
  }

  // 対象要素が実際に見えている時だけピンを出す(ホバーで出るモーダル等が
  // opacity:0 / visibility:hidden / 画面外で隠れているケースも非表示にする)
  function isVisible(el, inViewport = true) {
    if (typeof el.checkVisibility === "function") {
      if (
        !el.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        })
      )
        return false;
    } else {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")
        return false;
    }
    const r = el.getBoundingClientRect();
    if (!inViewport) return r.width > 0 && r.height > 0;
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.left < innerWidth &&
      r.bottom > 0 &&
      r.top < innerHeight
    );
  }

  const inView = (r) =>
    r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;

  function box(cls, r) {
    const d = document.createElement("div");
    d.className = cls;
    Object.assign(d.style, {
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    return d;
  }

  function renderPins() {
    pinsBox.innerHTML = "";
    marksBox.innerHTML = "";
    if (!panelOpen && !dock && !dockVisible) return; // サイドパネルか下パネルを開いている間だけ印を出す
    comments.forEach((c, i) => {
      const t = targetOf(c);
      if (!t || !t.rects.length || !isVisible(t.el)) return;
      if (t.text) {
        if (!t.rects.some(inView)) return;
        t.rects.forEach((r) => marksBox.appendChild(box("mark" + (c.resolved ? " done" : ""), r)));
      }
      const r = t.rects[0];
      const p = document.createElement("div");
      p.className = "pin" + (c.resolved ? " done" : "");
      p.textContent = i + 1;
      p.style.left = Math.max(11, r.left) + "px";
      p.style.top = Math.max(11, r.top) + "px";
      pinsBox.appendChild(p);
    });
  }

  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderPins);
  };
  addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  ["mouseover", "mouseout", "transitionend", "animationend"].forEach((t) =>
    addEventListener(t, schedule, true)
  );
  setInterval(renderPins, 400); // SPA・ホバー表示などのDOM変化に追従
  chrome.storage.onChanged.addListener((ch) => {
    if (ch[KEY]) load();
  });

  // ---- サイドパネルからの指示 ----
  function flash(msg) {
    const c = comments.find((x) => x.id === msg.id) || msg;
    const path = c.framePath || [];
    const ownPath = frameContext?.framePath;
    if (ownPath && path.length > ownPath.length && ownPath.every((p, i) => p === path[i])) {
      try { document.querySelector(path[ownPath.length])?.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
      return;
    }
    const t0 = targetOf(c);
    if (!t0) return;
    t0.el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      const t = targetOf(c);
      if (!t) return;
      flashBox.innerHTML = "";
      t.rects.forEach((r) => flashBox.appendChild(box("flash", r)));
      setTimeout(() => (flashBox.innerHTML = ""), 1500);
    }, 450);
  }

  // ---- PDF用のページ全体の撮影(サイドパネルがスクロール位置ごとに撮って貼り合わせる) ----
  let shot = null;
  // 描画が反映されるまで待つ(rAF は描画が止まっているタブで進まないことがあるのでタイマーにする)
  const settle = (ms = 150) => new Promise((res) => setTimeout(res, ms));
  const scrollStyle = document.createElement("style");
  scrollStyle.textContent = "html,body{scroll-behavior:auto!important}";

  // 撮影を始める。各コメントの対象位置をページ座標で返す(印はサイドパネル側で描く)
  async function beginShot() {
    shot = { scroll: [scrollX, scrollY], hidden: [] };
    hideHl();
    flashBox.innerHTML = "";
    host.style.display = "none";
    if (dock) {
      dock.el.style.display = "none"; // 撮影には写さない(撮影中も中のスクリプトは動き続ける)
      dock.spacer.disabled = true;
    }
    document.head.appendChild(scrollStyle);
    const docH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const targets = comments.map((c) => {
      const t = targetOf(c);
      if (!t || !t.rects.length || !isVisible(t.el, false)) return { id: c.id, rects: [] };
      return {
        id: c.id,
        text: t.text,
        rects: t.rects.map((r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height })),
      };
    });
    const children = await chrome.runtime.sendMessage({ type: "collect-frame-targets" }).catch(() => []);
    return { docH, vw: innerWidth, vh: innerHeight, targets: targets.concat(children || []) };
  }

  // 2枚目以降は固定ヘッダーなどが何度も写らないように隠す
  function hideFixed() {
    for (const el of document.querySelectorAll("body *")) {
      const pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      shot.hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
      el.style.setProperty("visibility", "hidden", "important");
    }
  }

  async function shotScroll(y, index) {
    if (index === 1) hideFixed();
    scrollTo({ left: 0, top: y, behavior: "instant" });
    await settle();
    return { y: scrollY };
  }

  function endShot() {
    if (!shot) return;
    shot.hidden.forEach(([el, v, p]) => (v ? el.style.setProperty("visibility", v, p) : el.style.removeProperty("visibility")));
    scrollStyle.remove();
    host.style.display = "";
    if (dock) {
      dock.el.style.display = "block";
      dock.spacer.disabled = false;
    }
    scrollTo({ left: shot.scroll[0], top: shot.scroll[1], behavior: "instant" });
    shot = null;
    chrome.runtime.sendMessage({ type: "end-frame-shot" }).catch(() => {});
    renderPins();
  }

  async function frameTargets() {
    frameShooting = true;
    host.style.display = "none";
    const targets = [];
    for (const c of comments) {
      const t = targetOf(c);
      if (!t || !isVisible(t.el)) continue;
      const rects = [];
      for (const r of t.rects) {
        const local = { x: Math.max(0, r.left), y: Math.max(0, r.top),
          w: Math.min(innerWidth, r.right) - Math.max(0, r.left),
          h: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) };
        if (local.w <= 0 || local.h <= 0) continue;
        const ctx = await frames.context(local, true);
        if (ctx.clip) rects.push({ x: ctx.clip.x + ctx.scrollX, y: ctx.clip.y + ctx.scrollY, w: ctx.clip.w, h: ctx.clip.h });
      }
      targets.push({ id: c.id, text: t.text, rects });
    }
    return targets;
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "frame-state" && frames.isTop) reply({ picking, dock: !!dock });
    if (msg.type === "shot-frame-begin" && !frames.isTop) {
      frameTargets().then(reply, () => reply([]));
      return true;
    }
    if (msg.type === "shot-frame-end") { frameShooting = false; showOverlay(); }
    if (msg.type === "hide-overlays") host.style.display = "none";
    if (msg.type === "start-pick") startPick();
    if (msg.type === "stop-pick") stopPick();
    if (msg.type === "focus") flash(msg);
    if (msg.type === "clip-done") showOverlay();
    if (msg.type === "pick-key" && picking) widen(msg.key === "ArrowUp");
    if (msg.type === "ping") reply({ ok: true });
    if (msg.type === "panel-opened") connectPanel();
    if (msg.type === "dock-open") openDock();
    if (msg.type === "dock-close") closeDock();
    if (msg.type === "shot-begin" && frames.isTop) {
      beginShot().then(reply, () => reply(null));
      return true;
    }
    if (msg.type === "shot-scroll" && frames.isTop) {
      shotScroll(msg.y, msg.index).then(reply, () => reply(null));
      return true;
    }
    if (msg.type === "shot-end" && frames.isTop) endShot();
  });

  // フレームIDは実行中の通信専用。保存データには再読み込みで変わらないセレクタ列を使う。
  function registerFrame() {
    let p;
    try { p = chrome.runtime.connect({ name: "review-frame" }); } catch { return; }
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      setTimeout(() => { if (document.documentElement.isConnected) registerFrame(); }, 1000);
    });
  }
  registerFrame();
  load();
  setInterval(() => load(true), 1500); // SPAで親URLやiframeの位置が変わったときも更新する
  connectPanel();
  // 戻る・進むでページが復元されたら(その間に接続が切れているので)つなぎ直す
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    port = null;
    panelOpen = false;
    load();
    connectPanel();
  });
  chrome.runtime.sendMessage({ type: "dock-state" }).then((r) => r?.open && openDock(), () => {});
  if (!frames.isTop) chrome.runtime.sendMessage({ type: "initial-frame-state" }).then(r => {
    if (r?.dock) openDock();
    if (r?.picking) startPick();
  }, () => {});
})();
