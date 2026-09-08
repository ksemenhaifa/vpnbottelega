/* ============================================================
 *  Хранилище показаний жителей
 *  mode: 'local' — localStorage браузера (по умолчанию)
 *        'api'   — REST: GET/POST {apiUrl}, DELETE {apiUrl}/{id}
 *  При недоступности API данные кэшируются локально.
 *
 *  Автообновление (только в режиме 'api'):
 *    store.startPolling(ms) / store.stopPolling()
 *  Опрос останавливается на скрытой вкладке, при ошибках интервал
 *  удваивается до 5 минут, при возврате на вкладку — немедленный запрос.
 *  Показания, отправленные из этого браузера, не пропадают из списка,
 *  пока сервер их не подтвердит; неудачная отправка повторяется.
 * ============================================================ */
window.SW = window.SW || {};

SW.reports = (function () {
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  const POLL_MS = 25000;        // базовый интервал опроса
  const POLL_MAX_MS = 300000;   // потолок при повторных ошибках
  const SEND_TRIES = 3;         // попыток отправить показание на сервер
  const TOMBSTONE_MS = 120000;  // сколько помним об удалении, чтобы строка не вернулась
  const CONFIRM_MS = 10000;     // запас на пересечение отправки и опроса

  function create(opts) {
    opts = opts || {};
    const key = opts.key || 'strizhi.water.readings.v1';
    const mode = opts.apiUrl ? 'api' : 'local';
    const listeners = new Set();
    const statusListeners = new Set();
    let cache = readLocal();

    // отправленные отсюда, но ещё не подтверждённые сервером: id -> { reading, sent, tries }
    const pendingAdds = new Map();
    // удалённые отсюда: id -> до какого момента игнорировать их в ответе сервера
    const tombstones = new Map();

    const status = { state: 'idle', lastSync: 0, error: null, pending: 0, polling: false };

    function readLocal() {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
    }
    function writeLocal() {
      try { localStorage.setItem(key, JSON.stringify(cache)); } catch (e) { /* приватный режим и т.п. */ }
    }
    // reason: 'local' — изменение из этого браузера, 'remote' — пришло с сервера или из другой вкладки
    function emit(reason) { listeners.forEach((fn) => { try { fn(cache.slice(), reason || 'local'); } catch (e) { console.error(e); } }); }
    function setStatus(patch) {
      let unsent = 0;
      pendingAdds.forEach((p) => { if (!p.sent) unsent += 1; });
      Object.assign(status, patch, { pending: unsent });
      statusListeners.forEach((fn) => { try { fn(Object.assign({}, status)); } catch (e) { console.error(e); } });
    }

    async function api(method, path, body) {
      const res = await fetch(opts.apiUrl + (path || ''), {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error('API ' + res.status);
      return res.status === 204 ? null : res.json();
    }

    /* ---------- слияние ответа сервера с местными изменениями ---------- */
    function merge(server) {
      const now = Date.now();
      tombstones.forEach((exp, id) => { if (exp < now) tombstones.delete(id); });

      const seen = new Set();
      const byId = new Map();
      server.forEach((r) => { seen.add(r.id); if (!tombstones.has(r.id)) byId.set(r.id, r); });

      pendingAdds.forEach((p, id) => {
        if (seen.has(id)) { pendingAdds.delete(id); return; }   // сервер принял — вести учёт больше не нужно
        // отправка и опрос могли пересечься: ждём CONFIRM_MS, прежде чем считать запись потерянной
        if (p.sent && now - p.sentAt > CONFIRM_MS) { p.sent = false; p.tries += 1; }
        if (!tombstones.has(id)) byId.set(id, p.reading);       // из списка не убираем
      });

      return Array.from(byId.values()).sort((a, b) => b.ts - a.ts);
    }

    async function flushPending() {
      for (const p of Array.from(pendingAdds.values())) {
        if (p.sent || p.tries >= SEND_TRIES) continue;
        try { await api('POST', '', p.reading); p.sent = true; p.sentAt = Date.now(); }
        catch (e) { p.tries += 1; }
      }
    }

    /* ---------- опрос сервера ---------- */
    let pollTimer = null, pollDelay = POLL_MS, baseDelay = POLL_MS, stopped = true, busy = false;

    function schedule() {
      clearTimeout(pollTimer);
      if (stopped) return;
      pollTimer = setTimeout(tick, pollDelay);
    }
    async function tick() {
      if (typeof document !== 'undefined' && document.hidden) { schedule(); return; }
      await store.refresh();
      pollDelay = status.state === 'error' ? Math.min(pollDelay * 2, POLL_MAX_MS) : baseDelay;
      schedule();
    }
    function onVisible() {
      if (stopped || document.hidden) return;
      pollDelay = baseDelay;          // вернулись на вкладку — показываем свежее сразу
      clearTimeout(pollTimer);
      tick();
    }

    const store = {
      mode,
      status() { return Object.assign({}, status); },
      list() { return cache.slice(); },

      async refresh() {
        if (mode !== 'api') { cache = readLocal(); emit('remote'); return cache.slice(); }
        if (busy) return cache.slice();
        busy = true;
        setStatus({ state: 'loading' });
        try {
          await flushPending();
          cache = merge(await api('GET'));
          writeLocal();
          setStatus({ state: 'ok', lastSync: Date.now(), error: null });
        } catch (e) {
          console.warn('Показания: API недоступен, используем локальную копию', e);
          setStatus({ state: 'error', error: String(e && e.message || e) });
        } finally { busy = false; }
        emit('remote');
        return cache.slice();
      },

      async add(r) {
        const reading = Object.assign({ id: uid(), ts: Date.now() }, r);
        cache = [reading].concat(cache);
        writeLocal(); emit();
        if (mode === 'api') {
          const p = { reading, sent: false, sentAt: 0, tries: 0 };
          pendingAdds.set(reading.id, p);
          try { await api('POST', '', reading); p.sent = true; p.sentAt = Date.now(); setStatus({}); }
          catch (e) { p.tries += 1; console.warn('Показание не отправлено на сервер', e); setStatus({ state: 'error', error: 'отправка' }); }
        }
        return reading;
      },

      async remove(id) {
        cache = cache.filter((r) => r.id !== id);
        pendingAdds.delete(id);
        if (mode === 'api') tombstones.set(id, Date.now() + TOMBSTONE_MS);
        writeLocal(); emit();
        if (mode === 'api') { try { await api('DELETE', '/' + encodeURIComponent(id)); } catch (e) { console.warn(e); } }
      },

      async clear(filter) {
        const gone = filter ? cache.filter(filter) : cache.slice();
        cache = filter ? cache.filter((r) => !filter(r)) : [];
        gone.forEach((r) => { pendingAdds.delete(r.id); if (mode === 'api') tombstones.set(r.id, Date.now() + TOMBSTONE_MS); });
        writeLocal(); emit();
        if (mode === 'api') { for (const r of gone) { try { await api('DELETE', '/' + encodeURIComponent(r.id)); } catch (e) { /* ignore */ } } }
      },

      startPolling(ms) {
        if (mode !== 'api') return false;
        baseDelay = Math.max(5000, Number(ms) || POLL_MS);
        pollDelay = baseDelay;
        stopped = false;
        setStatus({ polling: true });
        if (typeof document !== 'undefined' && !store._visBound) {
          store._visBound = () => onVisible();
          document.addEventListener('visibilitychange', store._visBound);
        }
        schedule();
        return true;
      },
      stopPolling() {
        stopped = true;
        clearTimeout(pollTimer);
        setStatus({ polling: false });
      },
      destroy() {
        store.stopPolling();
        if (store._visBound) { document.removeEventListener('visibilitychange', store._visBound); store._visBound = null; }
        listeners.clear(); statusListeners.clear();
      },

      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    };

    // локальный режим: синхронизация между вкладками одного браузера
    if (mode === 'local' && typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key !== key) return;
        cache = readLocal(); emit('remote');
      });
    }

    return store;
  }

  return { create };
})();
