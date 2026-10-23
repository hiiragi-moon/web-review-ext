(() => {
  if (window.__rcLoaded) return;
  window.__rcLoaded = true;

  const KEY = "comments";
  const pageKey = () => location.origin + location.pathname;

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
    </style>
    <div class="hl"></div><div class="tag"></div><div class="pins"></div><div class="flashbox"></div>`;
  document.documentElement.appendChild(host);

  const hl = shadow.querySelector(".hl");
  const tag = shadow.querySelector(".tag");
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

  // ---- 要素選択モード ----
  let picking = false;
  let hoverEl = null;

  function drawHl(el) {
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, {
      display: "block",
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    tag.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
    Object.assign(tag.style, {
      display: "block",
      left: r.left + "px",
      top: Math.max(0, r.top - 20) + "px",
    });
  }

  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    hoverEl = el;
    drawHl(el);
  }

  function onClick(e) {
    block(e);
    if (!hoverEl) return;
    const el = hoverEl;
    stopPick();
    chrome.runtime.sendMessage({
      type: "picked",
      data: {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.alt || "").trim().slice(0, 80),
        pageKey: pageKey(),
        url: location.href,
        title: document.title,
      },
    });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      block(e);
      stopPick();
      chrome.runtime.sendMessage({ type: "pick-cancelled" });
    }
  }

  const blockEvents = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"];

  function startPick() {
    if (picking) return;
    picking = true;
    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    blockEvents.forEach((t) => document.addEventListener(t, block, true));
  }

  function stopPick() {
    picking = false;
    hoverEl = null;
    document.documentElement.style.cursor = "";
    hl.style.display = "none";
    tag.style.display = "none";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    blockEvents.forEach((t) => document.removeEventListener(t, block, true));
  }

  // ---- ピン表示(保存済みコメントの位置) ----
  let comments = [];

  function load() {
    chrome.storage.local.get(KEY, (r) => {
      comments = (r[KEY] || [])
        .filter((c) => c.pageKey === pageKey())
        .sort((a, b) => a.createdAt - b.createdAt);
      renderPins();
    });
  }

  // 対象要素が実際に見えている時だけピンを出す(ホバーで出るモーダル等が
  // opacity:0 / visibility:hidden / 画面外で隠れているケースも非表示にする)
  function isVisible(el) {
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
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.left < innerWidth &&
      r.bottom > 0 &&
      r.top < innerHeight
    );
  }

  function renderPins() {
    pinsBox.innerHTML = "";
    comments.forEach((c, i) => {
      let el = null;
      try {
        el = document.querySelector(c.selector);
      } catch {}
      if (!el || !isVisible(el)) return;
      const r = el.getBoundingClientRect();
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
  function flash(selector) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {}
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      const r = el.getBoundingClientRect();
      flashBox.innerHTML = "";
      const f = document.createElement("div");
      f.className = "flash";
      Object.assign(f.style, {
        left: r.left + "px",
        top: r.top + "px",
        width: r.width + "px",
        height: r.height + "px",
      });
      flashBox.appendChild(f);
      setTimeout(() => (flashBox.innerHTML = ""), 1500);
    }, 450);
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "start-pick") startPick();
    if (msg.type === "stop-pick") stopPick();
    if (msg.type === "focus") flash(msg.selector);
    if (msg.type === "ping") reply({ ok: true });
  });

  load();
})();
