// 親子間で交換するのはフレームの位置情報だけ。拡張機能の操作・コメントはruntime経由。
(() => {
  function mapClip(clip, frame, viewport) {
    if (!clip) return null;
    const r = frame.getBoundingClientRect();
    const sx = r.width / frame.offsetWidth, sy = r.height / frame.offsetHeight;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
    const left = r.left + frame.clientLeft * sx, top = r.top + frame.clientTop * sy;
    const x = Math.max(viewport.left ?? 0, left, left + clip.x * sx);
    const y = Math.max(viewport.top ?? 0, top, top + clip.y * sy);
    const right = Math.min(viewport.w, left + frame.clientWidth * sx, left + (clip.x + clip.w) * sx);
    const bottom = Math.min(viewport.h, top + frame.clientHeight * sy, top + (clip.y + clip.h) * sy);
    return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
  }

  function create(cssPath) {
    const isTop = window === window.top;
    const pending = new Map();
    // HTTPのステージングでも使えるよう、secure context限定のrandomUUIDには依存しない。
    const prefix = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
    let requestNo = 0;
    function context(clip = null, pageSpace = false) {
      if (isTop) return Promise.resolve({
        framePath: [], pageKey: location.origin + location.pathname,
        url: location.href, title: document.title,
        clip: clip ? { ...clip, vw: innerWidth } : null,
        scrollX, scrollY,
      });
      return new Promise((resolve, reject) => {
        const id = `${prefix}-${++requestNo}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('親フレームと通信できません。ページを再読み込みしてください。'));
        }, 1500);
        pending.set(id, { resolve, reject, timer });
        window.parent.postMessage({ type: 'rc-context-request', id, clip, pageSpace }, '*');
      });
    }
    addEventListener('message', async e => {
      const m = e.data;
      if (!m || typeof m.id !== 'string') return;
      if (m.type === 'rc-context-reply' && e.source === window.parent) {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        if (m.context) p.resolve(m.context);
        else p.reject(new Error('親フレームの情報を取得できません。'));
      }
      if (m.type !== 'rc-context-request') return;
      const frame = [...document.querySelectorAll('iframe,frame')].find(f => f.contentWindow === e.source);
      if (!frame) return;
      try {
        // PDFは親ページ全体をスクロールして撮るため、最上位の現在の画面端では切らない。
        const viewport = isTop && m.pageSpace === true
          ? { left: -Infinity, top: -Infinity, w: Infinity, h: Infinity }
          : { w: innerWidth, h: innerHeight };
        const clip = mapClip(m.clip, frame, viewport);
        const c = await context(clip, m.pageSpace === true);
        e.source.postMessage({ type: 'rc-context-reply', id: m.id, context: {
          framePath: [...c.framePath, cssPath(frame)],
          clip: c.clip, scrollX: c.scrollX, scrollY: c.scrollY,
        } }, '*');
      } catch {
        e.source.postMessage({ type: 'rc-context-reply', id: m.id, context: null }, '*');
      }
    });
    return { isTop, context };
  }
  globalThis.ReviewFrames = { create, mapClip };
})();
