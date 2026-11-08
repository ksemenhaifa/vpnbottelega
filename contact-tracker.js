/*!
 * contact-tracker.js — единое отслеживание обращений для всех сайтов.
 *
 * Задача: на каждом сайте одни и те же события с одинаковыми именами и
 * параметрами, чтобы статистику можно было сравнивать между проектами.
 *
 * Отслеживает клики: WhatsApp, Telegram, телефон, почта, отправка форм.
 * Отправляет в Google Analytics 4 и Яндекс.Метрику — в те, что есть на сайте.
 *
 * Установка: один тег перед </body>, ПОСЛЕ счётчика аналитики.
 *   <script>window.CT = { site: 'veliora.clinic' };</script>
 *   <script src="/contact-tracker.js" defer></script>
 *
 * Без зависимостей.
 */
(function () {
  'use strict';

  if (window.__contactTracker) return; // защита от двойного подключения
  window.__contactTracker = true;

  var USER = window.CT || {};

  var CONFIG = {
    // Имя сайта в отчётах. Критично, пока несколько сайтов пишут в один счётчик:
    // по этому параметру их можно разделить. По умолчанию — домен.
    site: location.hostname.replace(/^www\./, ''),

    // Номер счётчика Яндекс.Метрики. null — определить автоматически.
    yandexCounterId: null,

    // Имена событий. Менять не рекомендуется: одинаковые имена на всех
    // сайтах — весь смысл этого скрипта.
    events: {
      whatsapp: 'whatsapp_click',
      telegram: 'telegram_click',
      phone: 'phone_click',
      email: 'email_click',
      form: 'lead_form_submit'
    },

    // Если на сайте УЖЕ стоит свой обработчик, шлющий такое же событие
    // (так сделано на 3dlab.co.il и yallapro.co.il) — включите, чтобы
    // не задвоить: скрипт не будет слать своё событие для WhatsApp.
    skipWhatsApp: false,

    trackForms: true,
    attributionDays: 30,
    watchDom: true,
    debug: false
  };

  for (var k in USER) if (Object.prototype.hasOwnProperty.call(USER, k)) {
    if (k === 'events') { for (var e in USER.events) CONFIG.events[e] = USER.events[e]; }
    else CONFIG[k] = USER[k];
  }

  var STORE = 'ct_attribution';
  var MARK = 'ctBound';

  function log() {
    if (CONFIG.debug && window.console) console.log.apply(console, ['[contact-tracker]'].concat([].slice.call(arguments)));
  }

  function clean(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // ───────────────────────── источник перехода ──────────────────────────

  function readStore() {
    try {
      var d = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!d || !d.ts || Date.now() - d.ts > CONFIG.attributionDays * 864e5) return null;
      return d;
    } catch (err) { return null; }
  }

  function writeStore(d) {
    try { localStorage.setItem(STORE, JSON.stringify(d)); } catch (err) { /* приватный режим */ }
  }

  function source() {
    var q = new URLSearchParams(location.search);
    var us = q.get('utm_source'), um = q.get('utm_medium'), uc = q.get('utm_campaign');
    var saved = readStore();

    if (us) {
      var fresh = { ts: Date.now(), id: saved && saved.id, src: us + (um ? ' / ' + um : '') + (uc ? ' / ' + uc : '') };
      writeStore(fresh);
      return fresh.src;
    }
    if (saved && saved.src) return saved.src;

    var ref = document.referrer;
    if (!ref) return 'прямой заход';
    try {
      var h = new URL(ref).hostname.replace(/^www\./, '');
      if (h === location.hostname.replace(/^www\./, '')) return 'прямой заход';
      if (/yandex\./.test(h)) return 'поиск Яндекс';
      if (/google\./.test(h)) return 'поиск Google';
      if (/bing\./.test(h)) return 'поиск Bing';
      if (/(instagram|facebook|vk\.com|t\.me|telegram)/.test(h)) return 'соцсети (' + h + ')';
      return h;
    } catch (err) { return 'прямой заход'; }
  }

  /** Короткий номер посетителя — удобно сверять с перепиской. */
  function visitorId() {
    var s = readStore() || {};
    if (!s.id) { s.id = String(Date.now()).slice(-6); s.ts = s.ts || Date.now(); writeStore(s); }
    return s.id;
  }

  // ───────────────────────── контекст клика ─────────────────────────────

  /** Раздел страницы: data-section → ближайший заголовок → h1 → title. */
  function section(el) {
    var tagged = el && el.closest && el.closest('[data-section]');
    if (tagged) return clean(tagged.getAttribute('data-section'));

    var box = el && el.closest && el.closest('section, article, .section, footer, header');
    var hops = 0;
    while (box && hops++ < 4) {
      var h = box.querySelector('h1, h2, h3');
      var t = h && clean(h.textContent);
      if (t && t.length > 2 && t.length < 90) return t;
      box = box.parentElement && box.parentElement.closest('section, article, .section');
    }
    var h1 = document.querySelector('h1');
    return clean(h1 && h1.textContent) || clean(document.title).split(/\s[|—–]\s/)[0] || '—';
  }

  // ───────────────────────── отправка событий ───────────────────────────

  function counters() {
    if (CONFIG.yandexCounterId) return [].concat(CONFIG.yandexCounterId);
    var ids = [];
    try {
      var reg = (window.Ya && window.Ya._metrika && window.Ya._metrika.counters) || {};
      for (var key in reg) if (Object.prototype.hasOwnProperty.call(reg, key)) ids.push(reg[key].id || key);
    } catch (err) { /* Метрики нет */ }
    return ids;
  }

  function send(name, params) {
    var payload = {
      site: CONFIG.site,
      page_path: location.pathname,
      page_title: clean(document.title).slice(0, 100),
      traffic_source: source(),
      visitor_id: visitorId()
    };
    for (var p in params) payload[p] = params[p];

    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, payload);

      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name }, payload));

      if (typeof window.ym === 'function') {
        counters().forEach(function (id) { window.ym(id, 'reachGoal', name, payload); });
      }

      document.dispatchEvent(new CustomEvent('ct:' + name, { detail: payload }));
    } catch (err) { log('ошибка отправки', err); }

    log(name, payload);
  }

  // ───────────────────────── определение типа ссылки ────────────────────

  function kind(href) {
    if (!href) return null;
    if (/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:)/i.test(href)) return 'whatsapp';
    if (/(?:t\.me|telegram\.me|tg:\/\/)/i.test(href)) return 'telegram';
    if (/^tel:/i.test(href)) return 'phone';
    if (/^mailto:/i.test(href)) return 'email';
    return null;
  }

  /** Куда ведёт: номер или адрес, без текста сообщения. */
  function destination(href, type) {
    if (type === 'phone') return href.replace(/^tel:/i, '').replace(/\s/g, '');
    if (type === 'email') return href.replace(/^mailto:/i, '').split('?')[0];
    try {
      var u = new URL(href, location.href);
      return (u.pathname || '').replace(/^\/+/, '') || u.hostname;
    } catch (err) { return href.split('?')[0]; }
  }

  // ───────────────────────── привязка ───────────────────────────────────

  function bind(a) {
    if (!a || a.dataset[MARK]) return;
    var href = a.getAttribute('href');
    var type = kind(href);
    if (!type) return;
    if (type === 'whatsapp' && CONFIG.skipWhatsApp) return;

    a.dataset[MARK] = '1';
    a.addEventListener('click', function () {
      send(CONFIG.events[type], {
        section: section(a),
        link_text: clean(a.textContent || a.getAttribute('aria-label')).slice(0, 60),
        destination: destination(a.getAttribute('href'), type)
      });
    });
  }

  function bindAll() {
    var sel = 'a[href*="wa.me"],a[href*="whatsapp"],a[href*="t.me"],a[href*="telegram"],a[href^="tel:"],a[href^="mailto:"]';
    var list = document.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) bind(list[i]);
    log('отслеживается ссылок:', list.length);
  }

  function bindForms() {
    if (!CONFIG.trackForms) return;
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      (function (f) {
        if (f.dataset[MARK] || f.closest('[data-ct-ignore]')) return;
        f.dataset[MARK] = '1';
        f.addEventListener('submit', function () {
          send(CONFIG.events.form, {
            section: section(f),
            form_id: f.getAttribute('id') || f.getAttribute('name') || '—'
          });
        });
      })(forms[i]);
    }
  }

  // ───────────────────────── публичный API ──────────────────────────────

  window.ContactTracker = {
    config: CONFIG,
    /** Ручная отправка: ContactTracker.track('whatsapp', 'Баннер в шапке') */
    track: function (type, sectionName) {
      var name = CONFIG.events[type] || type;
      send(name, { section: sectionName || section(null), destination: 'вручную' });
    },
    refresh: function () { bindAll(); bindForms(); }
  };

  function init() {
    bindAll();
    bindForms();
    if (CONFIG.watchDom && window.MutationObserver) {
      var t = null;
      new MutationObserver(function () {
        clearTimeout(t);
        t = setTimeout(function () { bindAll(); bindForms(); }, 300);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
