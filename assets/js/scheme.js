/* ============================================================
 *  Цветовые шкалы и SVG-схема сети с анимацией потока
 * ============================================================ */
window.SW = window.SW || {};

/* ---------- Цвета: OKLab-интерполяция между полюсами ---------- */
SW.colors = (function () {
  const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255); };
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  function toLab(hex) {
    const [r, g, b] = hex2rgb(hex).map(lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function fromLab([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, gam(c))) * 255).toString(16).padStart(2, '0')).join('');
  }
  const cache = new Map();
  function mix(a, b, t) {
    const k = a + b + Math.round(t * 200);
    if (cache.has(k)) return cache.get(k);
    const A = toLab(a), B = toLab(b);
    const v = fromLab([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
    cache.set(k, v); return v;
  }
  let theme = { mid: '#f0efec', blue: '#2a78d6', red: '#e34948', seqLo: '#cde2fb', seqHi: '#0d366b', neutral: '#c3c2b7' };
  return {
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
    setTheme(t) { theme = Object.assign({}, theme, t); },
    theme() { return theme; },
    /* t ∈ [-1, 1]: −1 — красный (ниже), 0 — нейтраль, +1 — синий (выше) */
    diverging(t) { t = Math.max(-1, Math.min(1, t || 0)); return t < 0 ? mix(theme.mid, theme.red, -t) : mix(theme.mid, theme.blue, t); },
    /* t ∈ [0, 1] — один тон, светлый → тёмный */
    sequential(t) { return mix(theme.seqLo, theme.seqHi, Math.max(0, Math.min(1, t || 0))); },
    /* Состояние по абсолютному давлению */
    statusFor(P, norm) {
      if (P == null) return 'none';
      if (P < norm.min - 0.7 || P > norm.max + 1.2) return 'critical';
      if (P < norm.min || P > norm.max) return 'serious';
      if (P < norm.min + 0.3 || P > norm.max - 0.3) return 'warning';
      return 'good';
    },
    /* Состояние отклонения показания от расчёта */
    deviationStatus(delta, dev) {
      const a = Math.abs(delta);
      return a <= dev.ok ? 'ok' : a <= dev.warn ? 'warn' : 'alarm';
    },
  };
})();

/* ---------- Схема ---------- */
SW.scheme = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const pipeWidth = (p) => 1.2 + p.d / 24;

  function create(host, net, handlers) {
    handlers = handlers || {};
    const svg = el('svg', { class: 'sw-svg', role: 'img', 'aria-label': 'Схема водоснабжения' }, host);
    const defs = el('defs', {}, svg);
    const marker = el('marker', { id: 'sw-arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto' }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'sw-arrowhead' }, marker);

    const gBack = el('g', { class: 'sw-back' }, svg);
    if (net.cfg.background && net.cfg.background.url) {
      const bg = net.cfg.background;
      const img = el('image', { href: bg.url, x: bg.x || 0, y: bg.y || 0, width: bg.width, height: bg.height, preserveAspectRatio: 'none', class: 'sw-back-img' }, gBack);
      img.style.opacity = bg.opacity == null ? 0.5 : bg.opacity;
    }
    const gStreets = el('g', { class: 'sw-streets' }, svg);
    const gPipes = el('g', { class: 'sw-pipes' }, svg);
    const gFlow = el('g', { class: 'sw-flow' }, svg);
    const gNodes = el('g', { class: 'sw-nodes' }, svg);
    const gLabels = el('g', { class: 'sw-labels' }, svg);

    // Границы
    const xs = net.nodes.map((n) => n.x), ys = net.nodes.map((n) => n.y);
    const pad = 70;
    const bg = net.cfg.background;
    if (bg && bg.url) { xs.push(bg.x || 0, (bg.x || 0) + bg.width); ys.push(bg.y || 0, (bg.y || 0) + bg.height); }
    const bounds = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad - 10, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 + 10 };
    let view = Object.assign({}, bounds);
    const hitEls = [];
    /* Площадка попадания держится примерно постоянной на экране (~22 px),
     * иначе на общем плане дома становятся неприцельными. */
    let lastHitW = 0;
    function updateHitAreas() {
      const px = svg.clientWidth || svg.getBoundingClientRect().width || 1;
      const half = Math.max(9, (view.w / px) * 11);
      hitEls.forEach((r) => {
        r.setAttribute('x', -half); r.setAttribute('y', -half);
        r.setAttribute('width', half * 2); r.setAttribute('height', half * 2);
      });
    }
    const applyView = () => {
      svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
      if (view.w !== lastHitW) { lastHitW = view.w; updateHitAreas(); }
    };
    applyView();
    window.addEventListener('resize', updateHitAreas);

    // Подложка улиц
    net.streets.forEach((s) => {
      el('rect', { x: s.x0 - 30, y: s.y - 14, width: s.x1 - s.x0 + 60, height: 28, rx: 14, class: 'sw-road' }, gStreets);
      el('text', { x: s.x0 - 20, y: s.y - 82, class: 'sw-street-name' }, gLabels).textContent = s.name;
    });

    // Трубы
    const pipeEls = new Map();
    net.pipes.forEach((p) => {
      const a = net.byId.get(p.from), b = net.byId.get(p.to);
      const w = pipeWidth(p);
      const base = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `sw-pipe sw-pipe-${p.kind}`, 'stroke-width': w, 'data-id': p.id }, gPipes);
      const flow = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'sw-flowline', 'stroke-width': Math.max(0.8, w * 0.42) }, gFlow);
      let valve = null;
      if (p.valve) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        valve = el('g', { class: 'sw-valve', transform: `translate(${mx} ${my})` }, gNodes);
        el('path', { d: 'M-7,-6 L7,6 L7,-6 L-7,6 Z', class: 'sw-valve-body' }, valve);
        valve.addEventListener('click', (e) => { e.stopPropagation(); handlers.onValveClick && handlers.onValveClick(p); });
      }
      base.addEventListener('pointerenter', (e) => handlers.onHover && handlers.onHover({ kind: 'pipe', pipe: p }, e));
      base.addEventListener('pointerleave', () => handlers.onHover && handlers.onHover(null));
      pipeEls.set(p.id, { base, flow, valve, len: Math.hypot(b.x - a.x, b.y - a.y) });
    });

    // Узлы
    const nodeEls = new Map();
    net.nodes.forEach((n) => {
      if (n.type === 'junction') {
        nodeEls.set(n.id, { dot: el('circle', { cx: n.x, cy: n.y, r: 2.2, class: 'sw-junction' }, gNodes) });
        return;
      }
      const g = el('g', { class: `sw-node sw-${n.type}`, transform: `translate(${n.x} ${n.y})`, 'data-id': n.id, tabindex: 0, role: 'button' }, gNodes);
      /* Невидимая площадка попадания: сам домик на общем плане — это 6 пикселей
       * на экране, пальцем в него не попасть. Размер пересчитывается под
       * текущий масштаб в updateHitAreas(). */
      const hit = el('rect', { class: 'sw-hit' }, g);
      hitEls.push(hit);
      let shape, halo, ring, badge;
      if (n.type === 'well') {
        halo = el('circle', { r: 26, class: 'sw-halo' }, g);
        shape = el('path', { d: 'M0,-19 L16.5,-9.5 L16.5,9.5 L0,19 L-16.5,9.5 L-16.5,-9.5 Z', class: 'sw-well-body' }, g);
        el('path', { d: 'M0,-9 C4,-3 6,0 6,3 A6,6 0 1,1 -6,3 C-6,0 -4,-3 0,-9 Z', class: 'sw-well-drop' }, g);
        el('text', { x: 0, y: n.y < 300 ? -30 : 38, class: 'sw-well-name' }, g).textContent = n.name;
        badge = el('text', { x: 0, y: n.y < 300 ? 52 : -36, class: 'sw-well-badge' }, g);
      } else {
        halo = el('circle', { r: 16, class: 'sw-halo' }, g);
        ring = el('rect', { x: -10, y: -10, width: 20, height: 20, rx: 4, class: 'sw-house-ring' }, g);
        shape = el('rect', { x: -7.5, y: -7.5, width: 15, height: 15, rx: 2.5, class: 'sw-house-body' }, g);
        el('text', { x: 0, y: n.side === 0 ? -14 : 20, class: 'sw-house-num' }, g).textContent = n.number;
        badge = el('text', { x: 0, y: 3.2, class: 'sw-house-badge' }, g);
      }
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onNodeClick && handlers.onNodeClick(n); } });
      g.addEventListener('pointerenter', (e) => handlers.onHover && handlers.onHover({ kind: 'node', node: n }, e));
      g.addEventListener('pointerleave', () => handlers.onHover && handlers.onHover(null));
      nodeEls.set(n.id, { g, shape, halo, ring, badge });
    });

    updateHitAreas();   // узлы уже созданы — задаём площадкам размер

    /* ---- Панорамирование и масштаб ---- */
    let drag = null;
    const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return [view.x + (cx - r.left) / r.width * view.w, view.y + (cy - r.top) / r.height * view.h]; };
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const g = e.target.closest && e.target.closest('.sw-node');
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, nodeId: g ? g.getAttribute('data-id') : null };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = svg.getBoundingClientRect();
      const dx = (e.clientX - drag.x) / r.width * view.w, dy = (e.clientY - drag.y) / r.height * view.h;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
      view.x = drag.vx - dx; view.y = drag.vy - dy; applyView();
    });
    /* Нажали и отпустили не двигаясь — это клик. Куда именно, решаем по тому,
     * с чего начали: событие click во время захвата указателя уходит на <svg>,
     * а не на узел, поэтому на него полагаться нельзя. */
    const endDrag = () => {
      if (drag && !drag.moved) {
        const n = drag.nodeId && net.byId.get(drag.nodeId);
        if (n) handlers.onNodeClick && handlers.onNodeClick(n);
        else handlers.onBackgroundClick && handlers.onBackgroundClick();
      }
      drag = null;
    };
    svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1 / 1.15 : 1.15, e.clientX, e.clientY); }, { passive: false });
    function zoomAt(f, cx, cy) {
      const [wx, wy] = cx != null ? toWorld(cx, cy) : [view.x + view.w / 2, view.y + view.h / 2];
      const nw = Math.max(bounds.w / 8, Math.min(bounds.w * 2.5, view.w * f)); const k = nw / view.w;
      view = { x: wx - (wx - view.x) * k, y: wy - (wy - view.y) * k, w: nw, h: view.h * k }; applyView();
    }

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---- Обновление состояния ---- */
    function update(state) {
      const { solution, readingByHouse, mode, norm, deviation, selected, leakNode } = state;
      const C = SW.colors;
      const mid = (norm.min + norm.max) / 2, span = mid - norm.min + 0.5;
      const pressureT = (P) => (P == null ? 0 : (P - mid) / span);
      const neutral = C.theme().neutral;

      net.pipes.forEach((p) => {
        const e = pipeEls.get(p.id);
        const closed = p.closed || (state.closedPipes && state.closedPipes.has(p.id));
        const q = solution.flow.get(p.id) || 0, v = solution.velocity.get(p.id) || 0;
        const Pa = solution.pressure.get(p.from), Pb = solution.pressure.get(p.to);
        let color = neutral;
        if (closed) color = neutral;
        else if (mode === 'pressure' && Pa != null && Pb != null) color = C.diverging(pressureT((Pa + Pb) / 2));
        else if (mode === 'velocity') color = C.sequential(Math.min(1, Math.abs(v) / 1.6));
        else if (mode === 'pressure') color = neutral;
        else color = C.diverging(0);
        e.base.style.stroke = color;
        e.base.classList.toggle('is-closed', !!closed);
        const speed = Math.abs(v);
        if (closed || speed < 0.02 || reduced) { e.flow.style.opacity = closed || speed < 0.02 ? 0 : 0.5; e.flow.style.animation = 'none'; }
        else {
          const dur = Math.max(0.5, Math.min(8, 1.4 / speed));
          e.flow.style.opacity = Math.min(0.95, 0.35 + speed * 0.5);
          e.flow.style.animation = `sw-dash ${dur.toFixed(2)}s linear infinite`;
          e.flow.style.animationDirection = q >= 0 ? 'normal' : 'reverse';
        }
        if (e.valve) e.valve.classList.toggle('is-closed', !!closed);
      });

      net.nodes.forEach((n) => {
        const e = nodeEls.get(n.id); if (!e || n.type === 'junction') return;
        const P = solution.pressure.get(n.id);
        const off = solution.noSupply.has(n.id);
        if (n.type === 'well') {
          const on = solution.activeWells.has(n.id);
          const cv = solution.checkValveClosed && solution.checkValveClosed.has(n.id);
          e.g.classList.toggle('is-off', !on && !cv); e.g.classList.toggle('is-cv', !!cv);
          const q = solution.wellFlow.get(n.id) || 0;
          e.badge.textContent = !on && !cv ? 'выключена' : cv ? 'клапан закрыт' : `${(state.wellPressure ? state.wellPressure(n) : n.pressure).toFixed(1)} бар · ${q.toFixed(1)} л/с`;
          e.g.classList.toggle('is-selected', selected === n.id);
          return;
        }
        const rd = readingByHouse && readingByHouse.get(n.id);
        let fill = neutral, badge = '';
        if (off) { fill = 'none'; badge = '✕'; }
        else if (mode === 'pressure') fill = C.diverging(pressureT(P));
        else if (mode === 'deviation') fill = rd ? C.diverging(-(-rd.delta) / deviation.warn) : 'none';
        else fill = 'none';
        e.shape.style.fill = fill;
        e.shape.classList.toggle('is-empty', fill === 'none');
        e.badge.textContent = badge;
        const st = rd ? rd.status : null;
        e.g.classList.toggle('has-reading', !!rd);
        e.g.classList.toggle('is-warn', st === 'warn');
        e.g.classList.toggle('is-alarm', st === 'alarm' || off);
        e.g.classList.toggle('is-selected', selected === n.id);
        e.g.classList.toggle('is-leak', leakNode === n.id);
        e.g.classList.toggle('is-off', off);
        const absSt = C.statusFor(P, norm);
        e.g.dataset.status = off ? 'off' : absSt;
      });
    }

    return {
      svg, update,
      fitView() { view = Object.assign({}, bounds); applyView(); },
      zoomBy(f) { zoomAt(f); },
      focusNode(id) {
        const n = net.byId.get(id); if (!n) return;
        const w = Math.min(view.w, bounds.w / 3); const k = w / view.w;
        view = { x: n.x - w / 2, y: n.y - view.h * k / 2, w, h: view.h * k }; applyView();
      },
    };
  }
  return { create, pipeWidth };
})();
