/* ============================================================
 *  Профиль давления вдоль улиц: расчётная линия по магистрали,
 *  нормативная полоса и точки показаний жителей.
 * ============================================================ */
window.SW = window.SW || {};

SW.profile = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const fmt = (v) => (v == null ? '—' : v.toFixed(2).replace('.', ','));

  function create(host, net, handlers) {
    handlers = handlers || {};
    host.classList.add('sw-profile');
    const charts = net.streets.map((s) => {
      const wrap = document.createElement('div'); wrap.className = 'sw-profile-chart'; host.appendChild(wrap);
      const title = document.createElement('div'); title.className = 'sw-profile-title'; wrap.appendChild(title);
      const svg = el('svg', { class: 'sw-profile-svg' }, wrap);
      return { s, wrap, title, svg };
    });
    const tip = document.createElement('div'); tip.className = 'sw-chart-tip'; tip.hidden = true; host.appendChild(tip);
    let last = null;

    function render() {
      if (!last) return;
      const { solution, readingByHouse, norm } = last;
      const M = { l: 44, r: 16, t: 12, b: 24 }, H = 150;
      // общая шкала y для всех улиц
      let lo = norm.min - 0.5, hi = norm.max + 0.5;
      net.houses.forEach((h) => { const P = solution.pressure.get(h.id); if (P != null) { lo = Math.min(lo, P); hi = Math.max(hi, P); } const r = readingByHouse.get(h.id); if (r) { lo = Math.min(lo, r.reading.pressure); hi = Math.max(hi, r.reading.pressure); } });
      lo = Math.floor(lo * 2) / 2 - 0.5; hi = Math.ceil(hi * 2) / 2;
      lo = Math.max(lo, 0);

      charts.forEach(({ s, title, svg }) => {
        const W = Math.max(280, svg.clientWidth || 600);
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        const x = (d) => M.l + (d - s.x0) / (s.x1 - s.x0) * (W - M.l - M.r);
        const y = (p) => M.t + (hi - p) / (hi - lo) * (H - M.t - M.b);
        const ps = s.junctions.map((j) => solution.pressure.get(j.id)).filter((p) => p != null);
        const minP = ps.length ? Math.min(...ps) : null, maxP = ps.length ? Math.max(...ps) : null;
        title.innerHTML = `<span class="sw-profile-name">${s.name}</span><span class="sw-profile-meta">магистраль Ø${s.main.d} · ${s.houses.length} домов · <span class="num">${fmt(minP)}–${fmt(maxP)} бар</span></span>`;

        // норма
        el('rect', { x: M.l, y: y(norm.max), width: W - M.l - M.r, height: y(norm.min) - y(norm.max), class: 'sw-norm-band' }, svg);
        // сетка y
        const step = hi - lo > 4 ? 1 : 0.5;
        for (let p = Math.ceil(lo / step) * step; p <= hi + 1e-9; p += step) {
          el('line', { x1: M.l, x2: W - M.r, y1: y(p), y2: y(p), class: 'sw-grid' }, svg);
          el('text', { x: M.l - 8, y: y(p) + 3.5, class: 'sw-tick', 'text-anchor': 'end' }, svg).textContent = p.toFixed(1).replace('.', ',');
        }
        el('line', { x1: M.l, x2: W - M.r, y1: y(lo), y2: y(lo), class: 'sw-axis' }, svg);
        for (let d = s.x0; d <= s.x1; d += 200) el('text', { x: x(d), y: H - 8, class: 'sw-tick', 'text-anchor': 'middle' }, svg).textContent = d + ' м';

        // расчётная линия
        const pts = s.junctions.map((j) => [x(j.dist), solution.pressure.get(j.id)]).filter((p) => p[1] != null);
        if (pts.length > 1) el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + y(p[1]).toFixed(1)).join(' '), class: 'sw-model-line' }, svg);
        // дома без воды
        s.houses.forEach((h) => { if (solution.noSupply.has(h.id)) el('text', { x: x(h.dist), y: y(lo) - 4, class: 'sw-nosupply', 'text-anchor': 'middle' }, svg).textContent = '✕'; });
        // показания
        s.houses.forEach((h) => {
          const r = readingByHouse.get(h.id); if (!r) return;
          const cx = x(h.dist), cy = y(r.reading.pressure), ey = r.expected != null ? y(r.expected) : cy;
          const col = SW.colors.diverging(r.delta / last.deviation.warn);
          el('line', { x1: cx, x2: cx, y1: ey, y2: cy, class: 'sw-stem' }, svg);
          const g = el('g', { class: 'sw-reading-pt sw-st-' + r.status, tabindex: 0 }, svg);
          el('circle', { cx, cy, r: 5, style: `fill:${col}`, class: 'sw-reading-dot' }, g);
          el('circle', { cx, cy, r: 12, class: 'sw-hit' }, g);
          const show = (e) => { tip.hidden = false; tip.innerHTML = `<b>${h.address}</b><br>показание <span class="num">${fmt(r.reading.pressure)}</span> бар · расчёт <span class="num">${fmt(r.expected)}</span><br>Δ <span class="num">${(r.delta >= 0 ? '+' : '−') + fmt(Math.abs(r.delta))}</span> бар`; place(e); };
          g.addEventListener('pointerenter', show); g.addEventListener('pointermove', place); g.addEventListener('focus', show);
          g.addEventListener('pointerleave', () => { tip.hidden = true; }); g.addEventListener('blur', () => { tip.hidden = true; });
          g.addEventListener('click', () => handlers.onHouseClick && handlers.onHouseClick(h));
        });
        // курсор по узлам
        const cross = el('line', { y1: M.t, y2: H - M.b, class: 'sw-cross' }, svg); cross.style.display = 'none';
        const cdot = el('circle', { r: 4, class: 'sw-cross-dot' }, svg); cdot.style.display = 'none';
        svg.addEventListener('pointermove', (e) => {
          const r = svg.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W;
          if (e.target.closest && e.target.closest('.sw-reading-pt')) return;
          let best = null; s.junctions.forEach((j) => { const dx = Math.abs(x(j.dist) - px); if (!best || dx < best.dx) best = { j, dx }; });
          if (!best || best.dx > 30) { cross.style.display = 'none'; cdot.style.display = 'none'; tip.hidden = true; return; }
          const P = solution.pressure.get(best.j.id); const jx = x(best.j.dist);
          cross.setAttribute('x1', jx); cross.setAttribute('x2', jx); cross.style.display = '';
          if (P != null) { cdot.setAttribute('cx', jx); cdot.setAttribute('cy', y(P)); cdot.style.display = ''; }
          const hs = s.houses.filter((h) => h.junction === best.j.id).map((h) => h.number).join(', ');
          tip.hidden = false; tip.innerHTML = `<b>${s.name}, ${best.j.dist} м</b>${hs ? ' · дома ' + hs : ''}<br>расчёт <span class="num">${fmt(P)}</span> бар · отметка <span class="num">${best.j.z.toFixed(1)}</span> м`;
          place(e);
        });
        svg.addEventListener('pointerleave', () => { cross.style.display = 'none'; cdot.style.display = 'none'; tip.hidden = true; });
      });
    }
    function place(e) {
      const r = host.getBoundingClientRect();
      let left = e.clientX - r.left + 14, top = e.clientY - r.top - 10;
      if (left + 240 > r.width) left = e.clientX - r.left - 250;
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    }
    if (window.ResizeObserver) new ResizeObserver(() => render()).observe(host);
    return { update(state) { last = state; render(); } };
  }
  return { create };
})();
