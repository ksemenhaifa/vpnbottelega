/* ============================================================
 *  Хранилище показаний жителей
 *  mode: 'local' — localStorage браузера (по умолчанию)
 *        'api'   — REST: GET/POST {apiUrl}, DELETE {apiUrl}/{id}
 *  При недоступности API данные кэшируются локально.
 * ============================================================ */
window.SW = window.SW || {};

SW.reports = (function () {
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function create(opts) {
    opts = opts || {};
    const key = opts.key || 'strizhi.water.readings.v1';
    const mode = opts.apiUrl ? 'api' : 'local';
    const listeners = new Set();
    let cache = readLocal();

    function readLocal() {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
    }
    function writeLocal() {
      try { localStorage.setItem(key, JSON.stringify(cache)); } catch (e) { /* приватный режим и т.п. */ }
    }
    function emit() { listeners.forEach((fn) => { try { fn(cache.slice()); } catch (e) { console.error(e); } }); }

    async function api(method, path, body) {
      const res = await fetch(opts.apiUrl + (path || ''), {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error('API ' + res.status);
      return res.status === 204 ? null : res.json();
    }

    const store = {
      mode,
      list() { return cache.slice(); },
      async refresh() {
        if (mode === 'api') {
          try { cache = await api('GET'); writeLocal(); } catch (e) { console.warn('Показания: API недоступен, используем локальную копию', e); }
        } else cache = readLocal();
        emit();
        return cache.slice();
      },
      async add(r) {
        const reading = Object.assign({ id: uid(), ts: Date.now() }, r);
        cache = [reading].concat(cache);
        writeLocal(); emit();
        if (mode === 'api') { try { await api('POST', '', reading); } catch (e) { console.warn('Показание не отправлено на сервер', e); } }
        return reading;
      },
      async remove(id) {
        cache = cache.filter((r) => r.id !== id);
        writeLocal(); emit();
        if (mode === 'api') { try { await api('DELETE', '/' + encodeURIComponent(id)); } catch (e) { console.warn(e); } }
      },
      async clear(filter) {
        const gone = filter ? cache.filter(filter) : cache.slice();
        cache = filter ? cache.filter((r) => !filter(r)) : [];
        writeLocal(); emit();
        if (mode === 'api') { for (const r of gone) { try { await api('DELETE', '/' + encodeURIComponent(r.id)); } catch (e) { /* ignore */ } } }
      },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    return store;
  }

  return { create };
})();
