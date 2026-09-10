/* ============================================================
 *  Сборка приложения: SW.mount(container, options)
 *  options: { config, apiUrl, storageKey, hour, readOnly, refreshMs }
 *    refreshMs — период автообновления журнала с сервера, мс (по умолчанию 25000,
 *                0 — выключить). Работает только при заданном apiUrl.
 * ============================================================ */
window.SW = window.SW || {};

/* Заставка на время запуска. Живёт поверх контейнера, а не всего окна,
 * чтобы модуль, встроенный в чужую страницу, не перекрывал её целиком.
 * splash: false — выключить. */
function showSplash(container, options) {
  if (options && options.splash === false) return;
  const el = document.createElement('div');
  el.className = 'sw-splash';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg class="sw-splash-drop" width="40" height="40" viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">'
    + '<path d="M20 4C25 12 30 17 30 23a10 10 0 0 1-20 0c0-6 5-11 10-19Z"/></svg>'
    + '<div class="sw-splash-t">Стрижи · Водоснабжение</div>'
    + '<div class="sw-splash-s">СХЕМА СЕТИ И ПОКАЗАНИЯ</div>'
    + '<div class="sw-splash-bar"><i></i></div>'
    + '<div class="sw-splash-by">Created by Semen Kuzminov</div>';
  let gone = false;
  const drop = () => { if (gone) return; gone = true; el.classList.add('is-out'); setTimeout(() => el.remove(), 500); };
  el.addEventListener('click', drop);
  const hold = setTimeout(drop, 1400);
  /* Схема готова раньше — всё равно даём заставке долежать около секунды,
   * иначе она мигает и выглядит сбоем. */
  container.__swSplashDone = () => { clearTimeout(hold); setTimeout(drop, 1000); };
  /* Во вкладке, открытой в фоне, таймеры притормаживаются, и заставка может
   * задержаться. Как только на страницу посмотрели — убираем. */
  document.addEventListener('visibilitychange', function onVis() {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVis);
    setTimeout(drop, 600);
  });
  container.appendChild(el);
}

SW.mount = function (container, options) {
  options = options || {};
  const cfg = options.config || SW.defaultConfig;
  const net = SW.buildNetwork(cfg);
  const store = SW.reports.create({ apiUrl: options.apiUrl, key: options.storageKey });
  const H = SW.hydraulics;
  const fmt = (v, d) => (v == null || !isFinite(v) ? '—' : v.toFixed(d == null ? 2 : d).replace('.', ','));
  const sgn = (v) => (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 2);
  const hhmm = (h) => { const m = Math.round(((h % 24) + 24) % 24 * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const when = (ts) => new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const now = new Date();
  const state = {
    hour: options.hour != null ? options.hour : now.getHours() + now.getMinutes() / 60,
    playing: false, mode: 'pressure', selected: null,
    demandScale: 1, wellState: {}, closedPipes: new Set(), leak: { node: '', q: 3 },
    tab: 'report',
  };
  let solution = null, readingByHouse = new Map();

  /* ---------- Разметка ---------- */
  container.classList.add('sw-app');
  container.innerHTML = `
  <header class="sw-head">
    <div class="sw-title">
      <h1>${esc(cfg.title)}</h1>
      <div class="sw-sub">${net.wells.length} скважины · ${net.streets.length} магистрали · ${net.houses.length} домовладений · расчётная схема по Хазену-Вильямсу</div>
      <button type="button" class="sw-sync" id="sw-sync" hidden></button>
    </div>
    <div class="sw-stats" id="sw-stats"></div>
  </header>
  <div class="sw-body">
    <section class="sw-main">
      <div class="sw-toolbar">
        <div class="sw-seg" role="group" aria-label="Раскраска схемы">
          <button data-mode="pressure" class="is-on">Давление</button>
          <button data-mode="deviation">Отклонение</button>
          <button data-mode="velocity">Поток</button>
        </div>
        <div class="sw-time">
          <button class="sw-btn sw-play" id="sw-play" aria-label="Проиграть сутки" title="Проиграть сутки">▶</button>
          <input type="range" id="sw-hour" min="0" max="24" step="0.25" aria-label="Час суток">
          <output id="sw-hour-out" class="num"></output>
          <button class="sw-btn sw-ghost" id="sw-now" title="Текущее время">сейчас</button>
        </div>
        <div class="sw-zoom">
          <button class="sw-btn" id="sw-zin" aria-label="Приблизить">+</button>
          <button class="sw-btn" id="sw-zout" aria-label="Отдалить">−</button>
          <button class="sw-btn sw-ghost" id="sw-fit">вся схема</button>
          <button class="sw-btn sw-ghost" id="sw-theme" aria-label="Цветовая схема"></button>
        </div>
      </div>
      <div class="sw-canvas" id="sw-canvas">
        <div class="sw-legend" id="sw-legend"></div>
        <div class="sw-tip" id="sw-tip" hidden></div>
      </div>
      <div id="sw-profile"></div>
    </section>
    <aside class="sw-side">
      <nav class="sw-tabs" role="tablist">
        <button role="tab" data-tab="report">Показание</button>
        <button role="tab" data-tab="log">Журнал</button>
        <button role="tab" data-tab="scenario">Сценарий</button>
        <button role="tab" data-tab="diag">Диагностика</button>
      </nav>
      <div class="sw-panel" data-panel="report">
        <form id="sw-form" class="sw-form" autocomplete="off">
          <p class="sw-lead">Сообщите давление на вводе в дом — схема сравнит его с расчётным и покажет, где в сети перекос.</p>
          <label>Адрес
            <input name="address" list="sw-addr" placeholder="с17 или Сиреневая 17" required>
            <span class="sw-opt">можно коротко: первая буква улицы и номер дома — «с17», «в12»</span>
            <datalist id="sw-addr">${net.houses.map((h) => `<option value="${esc(h.address)}">`).join('')}</datalist>
          </label>
          <label>Давление по манометру, бар
            <input name="pressure" type="number" min="0" max="10" step="0.1" inputmode="decimal" placeholder="3,2" required>
          </label>
          <label>Комментарий <span class="sw-opt">необязательно</span>
            <input name="comment" maxlength="200" placeholder="напор слабый вечером">
          </label>
          <button type="submit" class="sw-btn sw-primary">Отправить показание</button>
          <div class="sw-form-msg" id="sw-form-msg" aria-live="polite"></div>
          <details class="sw-howto"><summary>Как правильно измерить</summary>
            <ul><li>Манометр на вводе после счётчика, все краны в доме закрыты.</li><li>Подождите 10–15 секунд, пока стрелка успокоится.</li><li>Показание считается актуальным ${cfg.readingTtlHours} ч; вечерний и утренний пики сравниваются со своим расчётом.</li></ul>
          </details>
        </form>
      </div>
      <div class="sw-panel" data-panel="log" hidden>
        <div class="sw-log-head"><span id="sw-log-count"></span>
          <span class="sw-log-actions"><button class="sw-btn sw-ghost" id="sw-demo">демо-показания</button><button class="sw-btn sw-ghost" id="sw-clear">очистить</button></span></div>
        <div class="sw-table-wrap"><table class="sw-table" id="sw-log"><thead><tr><th>Адрес</th><th>Когда</th><th class="num">Изм.</th><th class="num">Расч.</th><th class="num">Δ</th><th></th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="sw-panel" data-panel="scenario" hidden>
        <h3>Скважины</h3>
        <div id="sw-wells"></div>
        <h3>Водоразбор</h3>
        <label class="sw-range">Множитель потребления <output id="sw-demand-out" class="num"></output>
          <input type="range" id="sw-demand" min="0.3" max="2.5" step="0.1"></label>
        <p class="sw-hint">1,0 — обычный день; 1,8–2,5 — вечерний полив в жару.</p>
        <h3>Перемычки</h3>
        <div id="sw-links"></div>
        <h3>Имитация порыва</h3>
        <label>Место утечки
          <select id="sw-leak"><option value="">нет</option>${net.streets.map((s) => `<optgroup label="${esc(s.name)}">${s.junctions.filter((j, i) => i % 2 === 0).map((j) => `<option value="${j.id}">${esc(s.name)}, ${j.dist} м</option>`).join('')}</optgroup>`).join('')}</select>
        </label>
        <label class="sw-range">Расход утечки, л/с <output id="sw-leakq-out" class="num"></output>
          <input type="range" id="sw-leakq" min="0.5" max="12" step="0.5"></label>
        <button class="sw-btn sw-ghost" id="sw-reset">Сбросить сценарий</button>
      </div>
      <div class="sw-panel" data-panel="diag" hidden><div id="sw-diag"></div></div>
    </aside>
  </div>
  <div class="sw-toast" id="sw-toast" role="status" aria-live="polite" hidden></div>`;

  showSplash(container, options);

  const $ = (sel) => container.querySelector(sel);
  const canvas = $('#sw-canvas'), tip = $('#sw-tip');

  /* ---------- Схема и профиль ---------- */
  const scheme = SW.scheme.create(canvas, net, {
    onNodeClick(n) {
      if (n.type === 'house') { selectHouse(n.id); }
      else if (n.type === 'well') { showTab('scenario'); }
      render();
    },
    onValveClick(p) { toggleClosed(p.id); },
    onBackgroundClick() { if (state.selected) { state.selected = null; render(); } },
    onHover(info, e) {
      if (!info) { tip.hidden = true; return; }
      tip.innerHTML = tooltipHtml(info); tip.hidden = false;
      const r = canvas.getBoundingClientRect();
      let left = e.clientX - r.left + 14, top = e.clientY - r.top + 14;
      if (left + 260 > r.width) left = Math.max(4, e.clientX - r.left - 270);
      if (top + 120 > r.height) top = Math.max(4, e.clientY - r.top - 130);
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    },
  });
  const profile = SW.profile.create($('#sw-profile'), net, { onHouseClick(h) { selectHouse(h.id); scheme.focusNode(h.id); } });

  function tooltipHtml(info) {
    if (info.kind === 'pipe') {
      const p = info.pipe; const v = solution.velocity.get(p.id) || 0, q = (solution.flow.get(p.id) || 0) * 1000;
      const name = p.name || (p.kind === 'main' ? 'Магистраль, ' + streetName(p.street) : p.kind === 'branch' ? 'Ввод в дом' : p.kind === 'well' ? 'Водовод от скважины' : 'Перемычка');
      return `<b>${esc(name)}</b><br>Ø${p.d} ${esc(p.material)} · ${p.length} м<br>расход <span class="num">${fmt(Math.abs(q), 2)}</span> л/с · скорость <span class="num">${fmt(Math.abs(v), 2)}</span> м/с${p.closed || state.closedPipes.has(p.id) ? '<br><em>перекрыта</em>' : ''}`;
    }
    const n = info.node; const P = solution.pressure.get(n.id);
    if (n.type === 'well') {
      const q = solution.wellFlow.get(n.id) || 0;
      const cv = solution.checkValveClosed.has(n.id);
      return `<b>${esc(n.name)}</b><br>на выходе <span class="num">${fmt(wellPressure(n), 1)}</span> бар · отметка <span class="num">${n.z.toFixed(1)}</span> м<br>подача <span class="num">${fmt(q, 2)}</span> л/с${cv ? '<br><em>обратный клапан закрыт: напор сети выше напора скважины</em>' : ''}`;
    }
    const rd = readingByHouse.get(n.id);
    const st = solution.noSupply.has(n.id) ? 'нет подачи' : statusLabel(SW.colors.statusFor(P, cfg.norm));
    return `<b>${esc(n.address)}</b><br>расчёт <span class="num">${fmt(P)}</span> бар · ${st}<br>отметка <span class="num">${n.z.toFixed(1)}</span> м` +
      (rd ? `<br>показание <span class="num">${fmt(rd.reading.pressure)}</span> бар (${when(rd.reading.ts)}) · Δ <span class="num">${sgn(rd.delta)}</span> — ${devLabel(rd.status)}` : '<br><em>показаний нет — нажмите, чтобы ввести</em>');
  }
  const streetName = (id) => (net.streets.find((s) => s.id === id) || {}).name || id;
  const statusLabel = (s) => ({ good: 'норма', warning: 'на границе нормы', serious: 'вне нормы', critical: 'критично', none: '—' }[s]);
  const devLabel = (s) => ({ ok: 'совпадает с расчётом', warn: 'заметное отклонение', alarm: 'сильное отклонение' }[s]);
  const wellPressure = (w) => (state.wellState[w.id] && state.wellState[w.id].pressure != null ? state.wellState[w.id].pressure : w.pressure);

  /* ---------- Расчёт ---------- */
  function compute() {
    const extra = {}; if (state.leak.node) extra[state.leak.node] = state.leak.q;
    solution = H.solve(net, { hour: state.hour, demandScale: state.demandScale, wellState: state.wellState, closedPipes: state.closedPipes, extraDemand: extra });
    readingByHouse = evaluateReadings();
  }
  function evaluateReadings() {
    const ttl = cfg.readingTtlHours * 3600e3, cutoff = Date.now() - ttl;
    const map = new Map();
    store.list().forEach((r) => {
      if (r.ts < cutoff || map.has(r.houseId) || !net.byId.get(r.houseId)) return;
      // расчёт берём для часа, когда снято показание
      const d = new Date(r.ts); const hour = d.getHours() + d.getMinutes() / 60;
      const extra = {}; if (state.leak.node) extra[state.leak.node] = state.leak.q;
      const sol = Math.abs(hour - state.hour) < 0.5 ? solution : H.solve(net, { hour, demandScale: state.demandScale, wellState: state.wellState, closedPipes: state.closedPipes, extraDemand: extra });
      const expected = sol.pressure.get(r.houseId);
      const delta = expected == null ? r.pressure : r.pressure - expected;
      map.set(r.houseId, { reading: r, expected, delta, status: SW.colors.deviationStatus(delta, cfg.deviation) });
    });
    return map;
  }

  /* ---------- Диагностика ---------- */
  function diagnostics() {
    const out = [];
    const norm = cfg.norm;
    net.wells.forEach((w) => {
      const q = solution.wellFlow.get(w.id) || 0;
      if (!solution.activeWells.has(w.id) && !solution.checkValveClosed.has(w.id)) out.push({ lvl: 'warning', t: `${w.name} выключена`, d: 'Сеть питается от остальных скважин.' });
      else if (solution.checkValveClosed.has(w.id)) out.push({ lvl: 'info', t: `${w.name} не подаёт воду`, d: `Напор сети выше напора скважины (${fmt(wellPressure(w), 1)} бар) — обратный клапан закрыт. Так бывает при малом водоразборе; при пике она включится в работу.` });
      else out.push({ lvl: 'info', t: `${w.name}: ${fmt(q, 1)} л/с`, d: `Давление на выходе ${fmt(wellPressure(w), 1)} бар.` });
    });
    const off = net.houses.filter((h) => solution.noSupply.has(h.id));
    if (off.length) out.push({ lvl: 'critical', t: `Без подачи: ${off.length} дом.`, d: off.slice(0, 6).map((h) => h.address).join('; ') + (off.length > 6 ? '…' : '') });
    const low = net.houses.filter((h) => !solution.noSupply.has(h.id) && solution.pressure.get(h.id) < norm.min);
    const high = net.houses.filter((h) => solution.pressure.get(h.id) > norm.max);
    if (low.length) out.push({ lvl: low.some((h) => solution.pressure.get(h.id) < norm.min - 0.7) ? 'critical' : 'serious', t: `Ниже нормы (${norm.min.toFixed(1)} бар): ${low.length} дом.`, d: low.slice(0, 6).map((h) => `${h.address} — ${fmt(solution.pressure.get(h.id), 1)}`).join('; ') + (low.length > 6 ? '…' : '') });
    if (high.length) out.push({ lvl: 'serious', t: `Выше нормы (${norm.max.toFixed(1)} бар): ${high.length} дом.`, d: high.slice(0, 6).map((h) => `${h.address} — ${fmt(solution.pressure.get(h.id), 1)}`).join('; ') });
    net.streets.forEach((s) => {
      const ps = s.houses.map((h) => solution.pressure.get(h.id)).filter((p) => p != null);
      if (!ps.length) return;
      const spread = Math.max(...ps) - Math.min(...ps);
      const iMin = s.houses[ps.indexOf(Math.min(...ps))];
      if (spread > 1.0) out.push({ lvl: spread > 1.6 ? 'serious' : 'warning', t: `Перекос по ${s.name}: ${fmt(spread, 1)} бар`, d: `Минимум у дома ${iMin.number} (${fmt(Math.min(...ps), 1)} бар). Причины: удалённость от скважин, перепад высот, диаметр магистрали Ø${s.main.d}.` });
      else out.push({ lvl: 'good', t: `${s.name}: равномерно`, d: `Разброс ${fmt(spread, 1)} бар по ${s.houses.length} домам.` });
    });
    net.pipes.filter((p) => p.kind === 'main').forEach((p) => {
      const v = Math.abs(solution.velocity.get(p.id) || 0);
      if (v > 2.0) out.push({ lvl: 'warning', t: `Скорость ${fmt(v, 1)} м/с в магистрали ${streetName(p.street)}`, d: `Участок ${p.from}–${p.to}: выше рекомендуемых 1,5–2 м/с — большие потери напора, стоит рассмотреть больший диаметр.` });
    });
    // группы отклонений по показаниям
    net.streets.forEach((s) => {
      const bad = s.houses.map((h) => ({ h, r: readingByHouse.get(h.id) })).filter((x) => x.r && x.r.status !== 'ok');
      const lowGrp = bad.filter((x) => x.r.delta < 0), highGrp = bad.filter((x) => x.r.delta > 0);
      const cluster = (grp) => { // соседние дома (в пределах 120 м) — один участок
        const sorted = grp.slice().sort((a, b) => a.h.dist - b.h.dist); const groups = [];
        sorted.forEach((x) => { const g = groups[groups.length - 1]; if (g && x.h.dist - g[g.length - 1].h.dist <= 120) g.push(x); else groups.push([x]); });
        return groups;
      };
      cluster(lowGrp).forEach((g) => {
        const avg = g.reduce((a, x) => a + x.r.delta, 0) / g.length;
        if (g.length >= 2) out.push({ lvl: 'critical', t: `${s.name}, участок ${g[0].h.dist}–${g[g.length - 1].h.dist} м: показания ниже расчёта на ${fmt(-avg, 1)} бар`, d: `${g.length} дома (${g.map((x) => x.h.number).join(', ')}). Похоже на порыв, засор или прикрытую задвижку на магистрали перед участком.` });
        else out.push({ lvl: g[0].r.status === 'alarm' ? 'serious' : 'warning', t: `${g[0].h.address}: ниже расчёта на ${fmt(-avg, 1)} бар`, d: 'Соседи в норме — вероятна проблема на вводе дома: фильтр, счётчик, кран, ввод малого диаметра.' });
      });
      cluster(highGrp).forEach((g) => {
        const avg = g.reduce((a, x) => a + x.r.delta, 0) / g.length;
        out.push({ lvl: 'warning', t: `${g.length > 1 ? s.name + ', дома ' + g.map((x) => x.h.number).join(', ') : g[0].h.address}: выше расчёта на ${fmt(avg, 1)} бар`, d: g.length > 1 ? 'Скважина работает на большем давлении, чем задано в модели, либо в модели занижен диаметр — уточните параметры в «Сценарии».' : 'Проверьте манометр или снимите показание ещё раз при закрытых кранах.' });
      });
    });
    const order = { critical: 0, serious: 1, warning: 2, info: 3, good: 4 };
    return out.sort((a, b) => order[a.lvl] - order[b.lvl]);
  }

  /* ---------- Рендер ---------- */
  function readTheme() {
    const cs = getComputedStyle(container);
    SW.colors.setTheme({ mid: cs.getPropertyValue('--div-mid').trim() || '#f0efec', blue: cs.getPropertyValue('--blue').trim() || '#2a78d6', red: cs.getPropertyValue('--red').trim() || '#e34948',
      seqLo: cs.getPropertyValue('--seq-lo').trim() || '#cde2fb', seqHi: cs.getPropertyValue('--seq-hi').trim() || '#0d366b', neutral: cs.getPropertyValue('--neutral').trim() || '#c3c2b7' });
  }
  function render() {
    readTheme(); compute();
    const st = { solution, readingByHouse, mode: state.mode, norm: cfg.norm, deviation: cfg.deviation, selected: state.selected, closedPipes: state.closedPipes, leakNode: state.leak.node, wellPressure };
    scheme.update(st); profile.update(st);
    renderStats(); renderLegend(); renderLog(); renderScenario(); renderDiag();
    $('#sw-hour').value = state.hour; $('#sw-hour-out').textContent = hhmm(state.hour);
  }
  function renderStats() {
    let supply = 0; solution.wellFlow.forEach((q) => { supply += q; });
    const ps = net.houses.map((h) => solution.pressure.get(h.id)).filter((p) => p != null);
    const actual = readingByHouse.size, alarms = [...readingByHouse.values()].filter((r) => r.status !== 'ok').length;
    const lowN = net.houses.filter((h) => solution.noSupply.has(h.id) || solution.pressure.get(h.id) < cfg.norm.min).length;
    $('#sw-stats').innerHTML = [
      ['Подача', fmt(supply, 1), 'л/с', 'info'],
      ['Давление у домов', `${fmt(Math.min(...ps), 1)}–${fmt(Math.max(...ps), 1)}`, 'бар', lowN ? 'serious' : 'good'],
      ['Ниже нормы', String(lowN), 'дом.', lowN ? 'serious' : 'good'],
      ['Показаний', String(actual), `за ${cfg.readingTtlHours} ч`, 'info'],
      ['Отклонений', String(alarms), 'от расчёта', alarms ? 'critical' : 'good'],
    ].map(([l, v, u, lvl]) => `<div class="sw-stat sw-lvl-${lvl}"><span class="sw-stat-l">${l}</span><span class="sw-stat-v num">${v}<small>${u}</small></span></div>`).join('');
  }
  function renderLegend() {
    const C = SW.colors; const n = cfg.norm;
    const bar = (fn, labels) => `<div class="sw-lg-bar" style="background:linear-gradient(90deg,${Array.from({ length: 9 }, (_, i) => fn(i / 8)).join(',')})"></div><div class="sw-lg-lab">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
    let html = '';
    if (state.mode === 'pressure') html = `<div class="sw-lg-title">Расчётное давление, бар</div>` + bar((t) => C.diverging(t * 2 - 1), [`< ${(n.min - 0.5).toFixed(1)}`, `${((n.min + n.max) / 2).toFixed(1)}`, `> ${(n.max + 0.5).toFixed(1)}`]) + `<div class="sw-lg-note">норма ${n.min.toFixed(1)}–${n.max.toFixed(1)} · красное — проседает, синее — завышено</div>`;
    else if (state.mode === 'deviation') html = `<div class="sw-lg-title">Показание жителя − расчёт, бар</div>` + bar((t) => C.diverging(t * 2 - 1), [`−${cfg.deviation.warn.toFixed(1)}`, '0', `+${cfg.deviation.warn.toFixed(1)}`]) + `<div class="sw-lg-note">окрашены только дома с актуальными показаниями</div>`;
    else html = `<div class="sw-lg-title">Скорость в трубе, м/с</div>` + bar((t) => C.sequential(t), ['0', '0,8', '1,6+']) + `<div class="sw-lg-note">бегущие штрихи — направление и скорость потока</div>`;
    html += `<div class="sw-lg-keys"><span><i class="sw-k sw-k-well"></i>скважина</span><span><i class="sw-k sw-k-house"></i>дом</span><span><i class="sw-k sw-k-read"></i>есть показание</span><span><i class="sw-k sw-k-alarm"></i>сильное отклонение</span><span><i class="sw-k sw-k-off"></i>нет подачи</span></div>`;
    $('#sw-legend').innerHTML = html;
  }
  function renderLog() {
    const cutoff = Date.now() - cfg.readingTtlHours * 3600e3;
    const list = store.list().slice().sort((a, b) => b.ts - a.ts);
    const fresh = list.filter((r) => r.ts >= cutoff).length;
    $('#sw-log-count').innerHTML = `актуальных <b class="num">${fresh}</b> · всего <b class="num">${list.length}</b>${store.mode === 'api' ? ' · общий журнал' : ' · этот браузер'}`;
    const tb = $('#sw-log tbody');
    tb.innerHTML = list.length ? list.map((r) => {
      const ev = readingByHouse.get(r.houseId); const isCur = ev && ev.reading.id === r.id;
      let expected = isCur ? ev.expected : null, delta = isCur ? ev.delta : null, st = isCur ? ev.status : null;
      if (!isCur && r.ts >= cutoff) { const d = new Date(r.ts); const sol = H.solve(net, { hour: d.getHours() + d.getMinutes() / 60, demandScale: state.demandScale, wellState: state.wellState, closedPipes: state.closedPipes }); expected = sol.pressure.get(r.houseId); if (expected != null) { delta = r.pressure - expected; st = SW.colors.deviationStatus(delta, cfg.deviation); } }
      return `<tr class="${r.ts < cutoff ? 'is-old' : ''} ${state.selected === r.houseId ? 'is-selected' : ''}" data-house="${r.houseId}">
        <td>${esc(r.address)}${r.demo ? ' <span class="sw-tag">пример</span>' : ''}${r.comment ? `<div class="sw-comment">${esc(r.comment)}</div>` : ''}</td>
        <td class="num sw-dim">${when(r.ts)}</td><td class="num">${fmt(r.pressure, 1)}</td><td class="num sw-dim">${fmt(expected, 1)}</td>
        <td class="num">${delta == null ? '—' : `<span class="sw-chip sw-chip-${st}">${sgn(delta)}</span>`}</td>
        <td><button class="sw-x" data-del="${r.id}" aria-label="Удалить">✕</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="sw-empty">Показаний пока нет. Введите своё на вкладке «Показание» или загрузите демо-показания.</td></tr>';
  }
  function renderScenario() {
    const wells = $('#sw-wells');
    if (!wells.dataset.built) {
      wells.innerHTML = net.wells.map((w) => `<div class="sw-well-row" data-well="${w.id}">
        <label class="sw-switch"><input type="checkbox" data-on="${w.id}" checked><span>${esc(w.name)}</span></label>
        <span class="sw-well-q num" data-q="${w.id}"></span>
        <label class="sw-range">на выходе <output class="num" data-pout="${w.id}"></output> бар<input type="range" data-p="${w.id}" min="0" max="7" step="0.1" value="${w.pressure}"></label></div>`).join('');
      wells.dataset.built = 1;
      wells.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.p) { state.wellState[t.dataset.p] = Object.assign({}, state.wellState[t.dataset.p], { pressure: Number(t.value) }); render(); }
        if (t.dataset.on) { state.wellState[t.dataset.on] = Object.assign({}, state.wellState[t.dataset.on], { on: t.checked }); render(); }
      });
      const links = net.pipes.filter((p) => p.valve);
      $('#sw-links').innerHTML = links.length ? links.map((p) => `<label class="sw-switch"><input type="checkbox" data-link="${p.id}" ${p.closed ? '' : 'checked'}><span>${esc(p.name || p.id)} <small>Ø${p.d}, ${p.length} м</small></span></label>`).join('') : '<p class="sw-hint">Перемычек нет.</p>';
      $('#sw-links').addEventListener('change', (e) => { if (e.target.dataset.link) toggleClosed(e.target.dataset.link, !e.target.checked); });
    }
    net.wells.forEach((w) => {
      const q = solution.wellFlow.get(w.id) || 0; const cv = solution.checkValveClosed.has(w.id);
      wells.querySelector(`[data-q="${w.id}"]`).textContent = !solution.activeWells.has(w.id) && !cv ? 'выкл.' : cv ? 'клапан закрыт' : fmt(q, 1) + ' л/с';
      wells.querySelector(`[data-pout="${w.id}"]`).textContent = fmt(wellPressure(w), 1);
      wells.querySelector(`[data-p="${w.id}"]`).value = wellPressure(w);
      wells.querySelector(`[data-on="${w.id}"]`).checked = !(state.wellState[w.id] && state.wellState[w.id].on === false);
    });
    net.pipes.filter((p) => p.valve).forEach((p) => { const cb = $(`[data-link="${p.id}"]`); if (cb) cb.checked = !(p.closed || state.closedPipes.has(p.id)); });
    $('#sw-demand').value = state.demandScale; $('#sw-demand-out').textContent = '×' + fmt(state.demandScale, 1);
    $('#sw-leak').value = state.leak.node; $('#sw-leakq').value = state.leak.q; $('#sw-leakq-out').textContent = fmt(state.leak.q, 1);
  }
  function renderDiag() {
    const items = diagnostics();
    const icon = { critical: '⨯', serious: '!', warning: '△', info: 'i', good: '✓' };
    $('#sw-diag').innerHTML = `<p class="sw-lead">Выводы для ${hhmm(state.hour)} с учётом сценария и актуальных показаний.</p>` + items.map((it) => `<div class="sw-diag-item sw-lvl-${it.lvl}"><span class="sw-diag-ic" aria-hidden="true">${icon[it.lvl]}</span><div><div class="sw-diag-t">${esc(it.t)}</div><div class="sw-diag-d">${esc(it.d)}</div></div></div>`).join('');
  }

  /* ---------- Управление ---------- */
  /* Единственная точка выбора дома: откуда бы ни кликнули — по схеме,
   * по высотному разрезу или по строке журнала — адрес сразу оказывается
   * в форме ввода показания. */
  function selectHouse(id, opts) {
    const h = net.byId.get(id);
    if (!h || h.type !== 'house') return;
    state.selected = id;
    const field = $('#sw-form [name=address]');
    if (field) field.value = h.address;
    if (!(opts && opts.keepTab)) { showTab('report'); revealForm(); }
    render();
  }

  /* На узком экране панель уезжает под схему, и клик по дому выглядит как
   * «ничего не произошло». Подводим форму к глазам и ставим курсор в поле. */
  function revealForm() {
    const side = container.querySelector('.sw-side');
    if (!side || side.getBoundingClientRect().top < window.innerHeight - 80) {
      const f = $('#sw-form [name=pressure]'); if (f) f.focus({ preventScroll: true });
      return;
    }
    side.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => { const f = $('#sw-form [name=pressure]'); if (f) f.focus({ preventScroll: true }); }, 350);
  }

  /* Цветовая схема: ночь по умолчанию, дальше по кругу день и «как в системе». */
  const THEMES = [
    { id: 'dark',  label: 'ночь',  title: 'Тёмная схема' },
    { id: 'light', label: 'день',  title: 'Светлая схема' },
    { id: 'auto',  label: 'авто',  title: 'Цвета как в системе' },
  ];
  function readTheme() {
    try { return localStorage.getItem('sw-theme') || 'dark'; } catch (e) { return 'dark'; }
  }
  function applyTheme(id) {
    const t = THEMES.find((x) => x.id === id) || THEMES[0];
    if (t.id === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t.id;
    try { localStorage.setItem('sw-theme', t.id); } catch (e) { /* приватный режим */ }
    const b = $('#sw-theme');
    if (b) { b.textContent = t.label; b.title = t.title; }
  }

  function showTab(id) {
    state.tab = id;
    container.querySelectorAll('.sw-tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === id));
    container.querySelectorAll('.sw-panel').forEach((p) => { p.hidden = p.dataset.panel !== id; });
  }
  function toggleClosed(id, closed) {
    const p = net.pipeById.get(id); if (!p) return;
    const willClose = closed == null ? !(p.closed || state.closedPipes.has(id)) : closed;
    p.closed = false; if (willClose) state.closedPipes.add(id); else state.closedPipes.delete(id);
    toast(`${p.name || 'Труба ' + id}: ${willClose ? 'перекрыта' : 'открыта'}`); render();
  }
  let toastTimer;
  function toast(msg) { const t = $('#sw-toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }

  container.querySelectorAll('.sw-tabs [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  applyTheme(readTheme());
  $('#sw-theme').addEventListener('click', () => {
    const i = THEMES.findIndex((t) => t.id === readTheme());
    applyTheme(THEMES[(i + 1) % THEMES.length].id);
  });
  container.querySelectorAll('.sw-seg [data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; container.querySelectorAll('.sw-seg [data-mode]').forEach((x) => x.classList.toggle('is-on', x === b)); render(); }));
  $('#sw-hour').addEventListener('input', (e) => { state.hour = Number(e.target.value); render(); });
  $('#sw-now').addEventListener('click', () => { const d = new Date(); state.hour = d.getHours() + d.getMinutes() / 60; render(); });
  $('#sw-zin').addEventListener('click', () => scheme.zoomBy(1 / 1.3));
  $('#sw-zout').addEventListener('click', () => scheme.zoomBy(1.3));
  $('#sw-fit').addEventListener('click', () => scheme.fitView());
  let timer = null;
  $('#sw-play').addEventListener('click', () => {
    state.playing = !state.playing; $('#sw-play').textContent = state.playing ? '❚❚' : '▶'; $('#sw-play').classList.toggle('is-on', state.playing);
    clearInterval(timer);
    if (state.playing) timer = setInterval(() => { state.hour = (state.hour + 0.125) % 24; render(); }, 160);
  });
  $('#sw-demand').addEventListener('input', (e) => { state.demandScale = Number(e.target.value); render(); });
  $('#sw-leak').addEventListener('change', (e) => { state.leak.node = e.target.value; render(); });
  $('#sw-leakq').addEventListener('input', (e) => { state.leak.q = Number(e.target.value); render(); });
  $('#sw-reset').addEventListener('click', () => { state.wellState = {}; state.closedPipes = new Set(); state.leak = { node: '', q: 3 }; state.demandScale = 1; net.pipes.forEach((p) => { if (p.valve) p.closed = false; }); toast('Сценарий сброшен'); render(); });

  $('#sw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const msg = $('#sw-form-msg');
    const parsed = SW.parseAddress(f.address.value, net.houses);
    const house = parsed.house;
    const pressure = Number(String(f.pressure.value).replace(',', '.'));
    if (!house) { msg.className = 'sw-form-msg is-err'; msg.textContent = SW.addressError(parsed); return; }
    if (!isFinite(pressure) || pressure < 0 || pressure > 10) { msg.className = 'sw-form-msg is-err'; msg.textContent = 'Давление укажите в барах, от 0 до 10.'; return; }
    const r = await store.add({ houseId: house.id, address: house.address, pressure, comment: f.comment.value.trim() });
    state.selected = house.id; render();
    const ev = readingByHouse.get(house.id);
    msg.className = 'sw-form-msg is-ok';
    msg.innerHTML = `Принято: ${esc(house.address)} — <span class="num">${fmt(pressure, 1)}</span> бар. Расчёт <span class="num">${fmt(ev && ev.expected, 1)}</span>, Δ <span class="num">${ev ? sgn(ev.delta) : '—'}</span> — ${ev ? devLabel(ev.status) : ''}.`;
    f.pressure.value = ''; f.comment.value = '';
    toast('Показание сохранено'); void r;
  });
  $('#sw-log').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]'); if (del) { store.remove(del.dataset.del); return; }
    const row = e.target.closest('tr[data-house]'); if (row) { selectHouse(row.dataset.house, { keepTab: true }); scheme.focusNode(row.dataset.house); }
  });
  $('#sw-clear').addEventListener('click', () => { if (confirm('Удалить все показания?')) store.clear(); });
  $('#sw-demo').addEventListener('click', seedDemo);
  /* ---------- Автообновление журнала ---------- */
  const syncEl = $('#sw-sync');
  let knownIds = null, syncTicker = null;

  const agoText = (ts) => {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 15) return 'только что';
    if (sec < 60) return sec + ' с назад';
    const min = Math.round(sec / 60);
    return min < 60 ? min + ' мин назад' : Math.round(min / 60) + ' ч назад';
  };
  function renderSync() {
    if (store.mode !== 'api') return;
    const st = store.status();
    let cls = 'ok', text;
    if (!st.polling) { cls = 'off'; text = 'автообновление выключено'; }
    else if (st.state === 'error') { cls = 'err'; text = 'нет связи с сервером'; }
    else if (st.state === 'loading' || !st.lastSync) { cls = 'load'; text = 'обновление…'; }
    else text = 'обновлено ' + agoText(st.lastSync);
    if (st.pending) { cls = cls === 'ok' ? 'warn' : cls; text += ` · ${st.pending} не отправлено`; }
    syncEl.className = 'sw-sync is-' + cls;
    syncEl.textContent = text;
    syncEl.title = st.polling ? 'Выключить автообновление' : 'Включить автообновление';
    syncEl.setAttribute('aria-label', 'Состояние связи с сервером: ' + text);
  }

  store.onChange((list, reason) => {
    if (reason === 'remote' && knownIds) {
      const fresh = list.filter((r) => !knownIds.has(r.id) && !r.demo);
      if (fresh.length === 1) toast(`Новое показание: ${fresh[0].address} — ${fmt(fresh[0].pressure, 1)} бар`);
      else if (fresh.length > 1) toast(`Новых показаний: ${fresh.length}`);
    }
    knownIds = new Set(list.map((r) => r.id));
    render();
  });

  /* Демонстрационные показания: помечены как «пример» */
  async function seedDemo() {
    await store.clear((r) => r.demo);
    const pick = (id) => net.byId.get(id);
    const t = Date.now(); const d = new Date(t); const hour = d.getHours() + d.getMinutes() / 60;
    const base = H.solve(net, { hour, demandScale: state.demandScale, wellState: state.wellState, closedPipes: state.closedPipes });
    const rows = [
      ['Ah3', 0.05, 'манометр на вводе'], ['Ah12', -0.1, ''], ['Ah21', 0.0, ''], ['Ah30', -0.15, ''],
      ['Bh6', 0.1, ''], ['Bh15', -0.9, 'вечером еле течёт'], ['Bh17', -1.1, 'напор упал со вчера'], ['Bh18', -0.8, ''],
      ['Bh29', -0.05, ''], ['Bh39', 0.1, ''], ['Ah41', -0.6, 'после замены фильтра стало хуже'], ['Ah46', 0.55, ''],
    ];
    for (const [id, dlt, c] of rows) {
      const h = pick(id); if (!h) continue;
      const P = base.pressure.get(id); if (P == null) continue;
      await store.add({ houseId: id, address: h.address, pressure: Math.round((P + dlt) * 10) / 10, comment: c, demo: true, ts: t - Math.floor(Math.random() * 5 * 3600e3) });
    }
    showTab('log'); toast('Загружены демо-показания (помечены как «пример»)');
  }

  /* ---------- Старт ---------- */
  showTab(state.tab);
  render();
  store.refresh()
    .then(() => { if (!store.list().length && options.seedDemo !== false) seedDemo(); })
    .finally(() => { if (container.__swSplashDone) container.__swSplashDone(); });

  const refreshMs = options.refreshMs != null ? Number(options.refreshMs) : 25000;
  if (store.mode === 'api' && refreshMs > 0) {
    syncEl.hidden = false;
    store.onStatus(renderSync);
    syncEl.addEventListener('click', () => {
      if (store.status().polling) { store.stopPolling(); toast('Автообновление выключено'); }
      else { store.startPolling(refreshMs); store.refresh(); toast('Автообновление включено'); }
      renderSync();
    });
    store.startPolling(refreshMs);
    syncTicker = setInterval(renderSync, 10000);   // «N мин назад» без обращений к сети
    renderSync();
  }
  if (window.matchMedia) { const mq = window.matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener || mq.addListener).call(mq, mq.addEventListener ? 'change' : render, render); }
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    net, state, store, render, solve: () => solution, showTab,
    destroy() { clearInterval(syncTicker); store.destroy(); },
  };
};
