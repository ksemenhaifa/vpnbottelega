/* ============================================================
 *  Стрижи · Водоснабжение — модель посёлка
 *  Все размеры — в метрах, давление — в барах, расход — в л/с.
 *  Файл описывает демонстрационную сеть; для реального посёлка
 *  подставьте свои координаты, диаметры, длины и адреса.
 * ============================================================ */
window.SW = window.SW || {};

SW.defaultConfig = {
  title: 'Водоснабжение посёлка Стрижи',

  /* Нормативный диапазон давления у потребителя, бар */
  norm: { min: 2.0, max: 4.5 },

  /* Допустимое расхождение «показание жителя − расчёт», бар */
  deviation: { ok: 0.3, warn: 0.7 },

  /* Показание жителя считается актуальным столько часов */
  readingTtlHours: 12,

  /* Суточный профиль водоразбора (доля от пикового) по часам 0..23 */
  hourProfile: [0.15,0.10,0.08,0.08,0.10,0.25,0.60,1.00,0.95,0.70,0.55,0.50,
                0.50,0.45,0.45,0.50,0.60,0.80,1.05,1.20,1.15,0.90,0.55,0.30],

  /* Пиковый расход одного домовладения с учётом одновременности, л/с */
  houseDemand: 0.12,

  /* Материал труб → коэффициент Хазена-Вильямса */
  materials: { 'ПЭ': 145, 'ПНД': 145, 'сталь': 110, 'чугун': 95, 'ПВХ': 145 },

  /* Наружный диаметр → внутренний (SDR17 ПЭ), мм */
  innerDiameter: { 160: 141, 110: 96.8, 90: 79.2, 63: 55.4, 50: 44, 40: 35.2, 32: 28, 25: 21 },

  /* Подложка — план посёлка (необязательно): url картинки и её положение
   * в координатах схемы (метры). Позволяет расставить дома по реальному плану.
   * background: { url: 'plan.png', x: -100, y: -50, width: 1200, height: 600, opacity: 0.5 } */
  background: null,

  /* Скважины: координаты, отметка земли z, давление на выходе P0 (бар),
   * curveK — снижение напора насоса с расходом, м / (л/с)² */
  wells: [
    { id: 'W1', name: 'Скважина №1', x: -80,  y: 120, z: 3.0, pressure: 4.0, curveK: 0.04, connectTo: 'A0',  pipe: { d: 110, length: 45, material: 'ПЭ' } },
    { id: 'W2', name: 'Скважина №2', x: 1040, y: 420, z: 5.5, pressure: 3.8, curveK: 0.04, connectTo: ['B24', 'C24'], pipe: { d: 110, length: 45, material: 'ПЭ' } },
    { id: 'W3', name: 'Скважина №3', x: 480,  y: 270, z: 4.0, pressure: 4.0, curveK: 0.06, connectTo: ['A12', 'B12'], pipe: { d: 90, length: 150, material: 'ПЭ' } },
  ],

  /* Улицы: магистраль идёт вдоль оси y, узлы через step метров.
   * sides — смещение домов от оси (минус — верхняя сторона, плюс — нижняя).
   * numbering: нечётные дома на верхней стороне, чётные — на нижней. */
  streets: [
    { id: 'A', name: 'ул. Сиреневая', y: 120, x0: 0, x1: 960, step: 40,
      main: { d: 110, material: 'ПЭ' }, branch: { d: 32, material: 'ПЭ', length: 22 },
      sides: [-55, 55], skipSlots: [3, 14, 21, 38, 47], elevation: [3.0, 9.5] },
    { id: 'B', name: 'ул. Вишнёвая',     y: 420, x0: 0, x1: 960, step: 40,
      main: { d: 90, material: 'ПЭ' },  branch: { d: 32, material: 'ПЭ', length: 22 },
      sides: [-55, 55], skipSlots: [0, 9, 26, 33, 44], elevation: [4.0, 6.0] },
    /* ВНИМАНИЕ: геометрия Каштановой — заглушка по образцу соседних улиц.
     * Подставьте реальные длину, шаг, диаметр магистрали и отметки земли. */
    { id: 'C', name: 'ул. Каштановая',   y: 720, x0: 0, x1: 960, step: 40,
      main: { d: 90, material: 'ПЭ' },  branch: { d: 32, material: 'ПЭ', length: 22 },
      sides: [-55, 55], skipSlots: [5, 17, 30, 41], elevation: [4.5, 7.5] },
  ],

  /* Перемычки между улицами. valve: true — можно закрыть в сценариях */
  links: [
    { id: 'L-end', name: 'Перемычка (восток)', from: 'A24', to: 'B24', d: 63, material: 'ПЭ', length: 300, valve: true, open: true },
    { id: 'L-bc', name: 'Перемычка Вишнёвая–Каштановая', from: 'B12', to: 'C12', d: 63, material: 'ПЭ', length: 300, valve: true, open: true },
  ],
};

/* Детерминированный генератор для мелкого «шума» отметок земли */
SW.seeded = function (seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/* ------------------------------------------------------------
 *  buildNetwork(config) → { nodes, pipes, houses, wells, streets }
 *  node: { id, type: 'well'|'junction'|'house', x, y, z, label, address,
 *          street, side, demand(л/с при пике), well? }
 *  pipe: { id, from, to, length, d, dInner, C, kind: 'main'|'branch'|'well'|'link',
 *          street?, closed }
 * ------------------------------------------------------------ */
SW.buildNetwork = function (cfg) {
  cfg = cfg || SW.defaultConfig;
  const rnd = SW.seeded(20260906);
  const nodes = [], pipes = [], houses = [], wells = [], streets = [];
  const byId = new Map();
  const add = (n) => { byId.set(n.id, n); nodes.push(n); return n; };
  const inner = (d) => cfg.innerDiameter[d] || d * 0.88;
  const cval = (m) => cfg.materials[m] || 140;

  cfg.streets.forEach((s) => {
    const n = Math.round((s.x1 - s.x0) / s.step);
    const junctions = [];
    const streetHouses = [];
    let odd = 1, even = 2;
    for (let i = 0; i <= n; i++) {
      const x = s.x0 + i * s.step;
      const t = (x - s.x0) / (s.x1 - s.x0);
      const z = s.elevation[0] + (s.elevation[1] - s.elevation[0]) * t + (rnd() - 0.5) * 0.8;
      const j = add({ id: `${s.id}${i}`, type: 'junction', x, y: s.y, z, street: s.id, dist: x - s.x0, demand: 0 });
      junctions.push(j);
      if (i > 0) {
        pipes.push({ id: `${s.id}m${i}`, from: `${s.id}${i - 1}`, to: `${s.id}${i}`, length: s.step,
          d: s.main.d, dInner: inner(s.main.d), C: cval(s.main.material), material: s.main.material,
          kind: 'main', street: s.id, closed: false });
      }
      s.sides.forEach((dy, sideIdx) => {
        const slot = i * 2 + sideIdx;
        if ((s.skipSlots || []).includes(slot)) return;
        const num = sideIdx === 0 ? odd : even;
        if (sideIdx === 0) odd += 2; else even += 2;
        const hid = `${s.id}h${num}`;
        const hz = z + (rnd() - 0.5) * 0.6 + (dy < 0 ? 0.3 : -0.2);
        const h = add({ id: hid, type: 'house', x, y: s.y + dy, z: hz, street: s.id, side: sideIdx,
          number: num, address: `${s.name}, ${num}`, junction: j.id, dist: x - s.x0,
          demand: cfg.houseDemand });
        houses.push(h); streetHouses.push(h);
        pipes.push({ id: `${hid}p`, from: j.id, to: hid, length: s.branch.length,
          d: s.branch.d, dInner: inner(s.branch.d), C: cval(s.branch.material), material: s.branch.material,
          kind: 'branch', street: s.id, closed: false });
      });
    }
    streets.push({ id: s.id, name: s.name, y: s.y, x0: s.x0, x1: s.x1, junctions, houses: streetHouses, main: s.main });
  });

  cfg.wells.forEach((w) => {
    const node = add({ id: w.id, type: 'well', x: w.x, y: w.y, z: w.z, label: w.name, name: w.name,
      pressure: w.pressure, curveK: w.curveK || 0, demand: 0, on: true });
    wells.push(node);
    const targets = Array.isArray(w.connectTo) ? w.connectTo : [w.connectTo];
    targets.forEach((tid, k) => {
      pipes.push({ id: `${w.id}p${k}`, from: w.id, to: tid, length: w.pipe.length,
        d: w.pipe.d, dInner: inner(w.pipe.d), C: cval(w.pipe.material), material: w.pipe.material,
        kind: 'well', closed: false });
    });
  });

  (cfg.links || []).forEach((l) => {
    pipes.push({ id: l.id, from: l.from, to: l.to, length: l.length, d: l.d, dInner: inner(l.d),
      C: cval(l.material), material: l.material, kind: 'link', name: l.name, valve: !!l.valve,
      closed: l.open === false });
  });

  const pipeById = new Map(pipes.map((p) => [p.id, p]));
  return { cfg, nodes, pipes, houses, wells, streets, byId, pipeById };
};
