/* ============================================================
 *  Гидравлический расчёт сети (установившийся режим)
 *  Потери напора — формула Хазена-Вильямса:
 *      h = 10.67 · L · Q^1.852 / (C^1.852 · D^4.87)   [м, Q в м³/с, D в м]
 *  Решение — метод линеаризации сопротивлений (linear theory):
 *  на каждой итерации h ≈ K·Q, K = r·|Q|^0.852, затем решается
 *  линейная система узловых балансов. Работает и для колец,
 *  и для нескольких источников с фиксированным напором.
 * ============================================================ */
window.SW = window.SW || {};

SW.hydraulics = (function () {
  const BAR_M = 10.197;          // метров водяного столба в 1 баре
  const N_HW = 1.852;

  function resistance(pipe) {
    const D = pipe.dInner / 1000;
    return 10.67 * pipe.length / (Math.pow(pipe.C, N_HW) * Math.pow(D, 4.87));
  }

  function headloss(pipe, Q) {           // Q м³/с, знак сохраняется
    return Math.sign(Q) * resistance(pipe) * Math.pow(Math.abs(Q), N_HW);
  }

  /* Решение плотной СЛАУ методом Гаусса с выбором главного элемента */
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-14) { M[piv][c] = 1; M[piv][n] = 0; }
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const p = M[c][c];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / p;
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /* Доля пикового расхода в момент hour (дробный час) */
  function hourFactor(profile, hour) {
    const h = ((hour % 24) + 24) % 24;
    const i = Math.floor(h), f = h - i;
    return profile[i] * (1 - f) + profile[(i + 1) % 24] * f;
  }

  /**
   * solve(net, opts)
   *   opts.hour            — час суток (0..24, дробный)
   *   opts.demandScale     — множитель водоразбора (1 — обычный день)
   *   opts.wellState[id]   — { on, pressure } переопределения скважин
   *   opts.closedPipes     — Set id закрытых труб
   *   opts.extraDemand[id] — дополнительный отбор в узле, л/с (утечка/полив)
   * → { head, pressure, flow, velocity, noSupply, wellFlow, factor }
   */
  function solve(net, opts) {
    opts = opts || {};
    const factor = hourFactor(net.cfg.hourProfile, opts.hour == null ? 8 : opts.hour) * (opts.demandScale || 1);
    const closed = opts.closedPipes || new Set();
    const wellState = opts.wellState || {};
    const extra = opts.extraDemand || {};

    const pipes = net.pipes.filter((p) => !p.closed && !closed.has(p.id));
    const activeWells = new Set();
    net.wells.forEach((w) => { const st = wellState[w.id] || {}; if (st.on !== false && w.on !== false) activeWells.add(w.id); });

    // Обратные клапаны: скважина, в которую вода «затекает» из сети,
    // фактически отключается — исключаем её и пересчитываем.
    for (let guard = 0; guard <= net.wells.length; guard++) {
      const res = solveOnce(net, pipes, activeWells, wellState, extra, factor);
      let worst = null;
      res.wellFlow.forEach((q, id) => { if (activeWells.has(id) && q < -1e-3 && (!worst || q < res.wellFlow.get(worst))) worst = id; });
      if (!worst) { res.checkValveClosed = new Set(net.wells.filter((w) => { const st = wellState[w.id] || {}; return st.on !== false && w.on !== false && !activeWells.has(w.id); }).map((w) => w.id)); return res; }
      activeWells.delete(worst);
    }
  }

  function solveOnce(net, pipes, activeWells, wellState, extra, factor) {

    // Расход в узлах, м³/с
    const demand = new Map();
    net.nodes.forEach((n) => demand.set(n.id, ((n.demand || 0) * factor + (extra[n.id] || 0)) / 1000));

    // Степень узлов и последовательное «сворачивание» листьев
    const deg = new Map(); const adj = new Map();
    net.nodes.forEach((n) => { deg.set(n.id, 0); adj.set(n.id, []); });
    pipes.forEach((p) => { deg.set(p.from, deg.get(p.from) + 1); deg.set(p.to, deg.get(p.to) + 1); adj.get(p.from).push(p); adj.get(p.to).push(p); });

    const removedNode = new Set(), removedPipe = new Set(), leaves = [];
    const agg = new Map(demand);
    const queue = net.nodes.filter((n) => n.type !== 'well' && deg.get(n.id) === 1).map((n) => n.id);
    while (queue.length) {
      const id = queue.pop();
      if (removedNode.has(id) || deg.get(id) !== 1) continue;
      const p = adj.get(id).find((q) => !removedPipe.has(q.id));
      if (!p) continue;
      const other = p.from === id ? p.to : p.from;
      leaves.push({ id, pipe: p, other });
      removedNode.add(id); removedPipe.add(p.id);
      agg.set(other, agg.get(other) + agg.get(id));
      deg.set(other, deg.get(other) - 1);
      if (net.byId.get(other).type !== 'well' && deg.get(other) === 1) queue.push(other);
    }

    // Узлы редуцированной системы
    const core = net.nodes.filter((n) => !removedNode.has(n.id));
    const corePipes = pipes.filter((p) => !removedPipe.has(p.id));
    const unknown = core.filter((n) => !(n.type === 'well' && activeWells.has(n.id)) && deg.get(n.id) > 0);
    const idx = new Map(unknown.map((n, i) => [n.id, i]));
    const head = new Map();
    const wellHead0 = new Map();
    net.wells.forEach((w) => {
      const st = wellState[w.id] || {};
      const P = st.pressure != null ? st.pressure : w.pressure;
      wellHead0.set(w.id, w.z + P * BAR_M);
      if (activeWells.has(w.id)) head.set(w.id, wellHead0.get(w.id));
    });

    const r = corePipes.map(resistance);
    let totalDemand = 0; demand.forEach((q) => { totalDemand += q; });
    let Q = corePipes.map(() => 0.002);
    const n = unknown.length;
    let converged = false;

    for (let iter = 0; iter < 60 && !converged; iter++) {
      const K = corePipes.map((p, i) => r[i] * Math.pow(Math.max(Math.abs(Q[i]), 2e-5), N_HW - 1));
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const b = new Array(n).fill(0);
      unknown.forEach((u, j) => { b[j] = -agg.get(u.id); });
      corePipes.forEach((p, i) => {
        const g = 1 / K[i];
        const a = idx.get(p.from), c = idx.get(p.to);
        if (a != null) { A[a][a] += g; if (c != null) A[a][c] -= g; else b[a] += g * head.get(p.to); }
        if (c != null) { A[c][c] += g; if (a != null) A[c][a] -= g; else b[c] += g * head.get(p.from); }
      });
      const H = n ? solveLinear(A, b) : [];
      unknown.forEach((u, j) => head.set(u.id, H[j]));
      let maxChange = 0;
      const Qn = corePipes.map((p, i) => {
        const q = (head.get(p.from) - head.get(p.to)) / K[i];
        const mixed = 0.5 * (q + Q[i]);
        maxChange = Math.max(maxChange, Math.abs(mixed - Q[i]));
        return mixed;
      });
      Q = Qn;
      // Характеристика насоса: напор падает с расходом
      net.wells.forEach((w) => {
        if (!activeWells.has(w.id) || !w.curveK) return;
        let q = 0;
        corePipes.forEach((p, i) => { if (p.from === w.id) q += Q[i]; else if (p.to === w.id) q -= Q[i]; });
        const qls = Math.max(q, 0) * 1000;
        head.set(w.id, 0.5 * head.get(w.id) + 0.5 * (wellHead0.get(w.id) - w.curveK * qls * qls));
      });
      if (iter > 3 && maxChange < Math.max(1e-6, 1e-4 * totalDemand)) converged = true;
    }

    // Результаты по трубам ядра
    const flow = new Map(), velocity = new Map();
    corePipes.forEach((p, i) => { flow.set(p.id, Q[i]); });

    // Обратная подстановка листьев
    for (let i = leaves.length - 1; i >= 0; i--) {
      const { id, pipe, other } = leaves[i];
      const q = agg.get(id);
      const Hother = head.get(other);
      if (Hother == null) { continue; }
      head.set(id, Hother - headloss(pipe, q));
      flow.set(pipe.id, pipe.from === other ? q : -q);
    }

    net.pipes.forEach((p) => {
      const q = flow.get(p.id);
      if (q == null) { flow.set(p.id, 0); velocity.set(p.id, 0); return; }
      const area = Math.PI * Math.pow(p.dInner / 2000, 2);
      velocity.set(p.id, q / area);
    });

    // Давление в узлах; узлы без напора — «нет подачи»
    const pressure = new Map(), noSupply = new Set();
    net.nodes.forEach((nd) => {
      const H = head.get(nd.id);
      if (H == null || !isFinite(H)) { noSupply.add(nd.id); pressure.set(nd.id, null); return; }
      const P = (H - nd.z) / BAR_M;
      if (nd.type !== 'well' && P < 0.05) noSupply.add(nd.id);
      pressure.set(nd.id, P);
    });

    const wellFlow = new Map();
    net.wells.forEach((w) => {
      let q = 0;
      net.pipes.forEach((p) => { const f = flow.get(p.id) || 0; if (p.from === w.id) q += f; else if (p.to === w.id) q -= f; });
      wellFlow.set(w.id, activeWells.has(w.id) ? q * 1000 : 0);
    });

    return { head, pressure, flow, velocity, noSupply, wellFlow, factor, converged, activeWells };
  }

  return { BAR_M, resistance, headloss, hourFactor, solve };
})();
