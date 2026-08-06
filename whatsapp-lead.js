/*!
 * whatsapp-lead.js — все контакты сайта ведут в WhatsApp с готовым сообщением.
 *
 * Зачем: владелец сайта должен видеть, что сайт работает. Каждый клиент пишет
 * в WhatsApp сам, первым сообщением, с указанием страницы и услуги, откуда пришёл.
 *
 * Установка: один тег перед </body>
 *   <script src="/whatsapp-lead.js" defer></script>
 * Настройка: либо правьте CONFIG ниже, либо задайте window.WA_LEAD = {...} ДО подключения скрипта.
 *
 * Без зависимостей. IE11 не поддерживается (нужен ES5+ и Element.closest).
 */
(function () {
  'use strict';

  var USER = (typeof window !== 'undefined' && window.WA_LEAD) || {};

  var CONFIG = {
    // ── ОБЯЗАТЕЛЬНОЕ ────────────────────────────────────────────────────────
    // Номер WhatsApp в международном формате, только цифры. Пример: '79991234567'.
    // Если оставить пустым — скрипт возьмёт первый номер из tel:/wa.me ссылок на странице.
    phone: '',

    // ── ТЕКСТ СООБЩЕНИЯ ─────────────────────────────────────────────────────
    // Плейсхолдеры: {{service}} {{page}} {{title}} {{url}} {{source}} {{id}}
    // Пустые плейсхолдеры и лишние пробелы/знаки препинания вычищаются автоматически.
    message: 'Здравствуйте! Пишу с вашего сайта — {{service}}. Можете рассказать подробнее?',

    // Готовые варианты текста, см. INSTALL.md. Выбирается через messagePreset.
    messagePresets: {
      neutral: 'Здравствуйте! Пишу с вашего сайта — {{service}}. Можете рассказать подробнее?',
      found: 'Здравствуйте! Нашёл вас на вашем сайте — {{service}}. Можете рассказать подробнее?',
      short: 'Здравствуйте! Интересует {{service}}. Расскажите подробнее?',
      // Максимум контекста для владельца: страница + источник трафика + номер обращения.
      detailed: 'Здравствуйте! Пишу с вашего сайта — {{service}} ({{page}}). Можете рассказать подробнее?\n\n— источник: {{source}}, обращение №{{id}}'
    },
    messagePreset: null, // 'neutral' | 'found' | 'short' | 'detailed'

    // Подставляется в {{service}}, если на странице не удалось определить услугу.
    defaultService: 'консультация',

    // ── ЧТО ПЕРЕХВАТЫВАТЬ ───────────────────────────────────────────────────
    convertTel: true, // ссылки tel:
    convertMailto: true, // ссылки mailto:
    convertExistingWhatsApp: true, // wa.me / api.whatsapp.com — добавить текст сообщения
    convertCtaByText: true, // кнопки по тексту (ctaTextPattern)
    // Свои селекторы CTA, например: '.t-btn, .booking-button'
    extraSelectors: '',
    // Ничего не трогать внутри этих элементов (и на самих элементах).
    ignoreSelector: '[data-wa-ignore], [data-wa-ignore] *, .no-wa, .no-wa *',

    // Текст кнопок, которые считаем заявкой. Осознанно узкий список:
    // сюда не должны попадать пункты меню и ссылки «читать далее».
    ctaTextPattern:
      /(записаться|запись на|запишитесь|оставить заявку|оставьте заявку|заказать звонок|обратный звонок|перезвоните|связаться с нами|бесплатн\w* консультаци|получить консультаци|записаться на приём|записаться на прием|узнать (?:цену|стоимость)|book|appointment)/i,

    // ── ФОРМЫ ───────────────────────────────────────────────────────────────
    // false — не трогать формы (по умолчанию: формы часто уже уходят в CRM).
    // 'replace' — вместо отправки открыть WhatsApp с данными из формы.
    // 'after'   — отправить форму как обычно И открыть WhatsApp.
    forms: false,
    formSelector: 'form',

    // ── ПЛАВАЮЩАЯ КНОПКА ────────────────────────────────────────────────────
    floatingButton: true,
    floatingButtonText: 'Написать в WhatsApp',
    floatingButtonPosition: 'right', // 'right' | 'left'
    floatingButtonOffset: 20, // px от края
    floatingButtonDelay: 0, // мс до появления
    floatingButtonHideOnScrollUp: false,

    // ── АНАЛИТИКА ───────────────────────────────────────────────────────────
    // Идентификатор цели. Заводится в Метрике как цель типа «JavaScript-событие».
    goalName: 'whatsapp_lead',
    // Номер счётчика Метрики. null — определить автоматически (обычно работает).
    yandexCounterId: null,

    // ── ПРОЧЕЕ ──────────────────────────────────────────────────────────────
    openInNewTab: true,
    attributionDays: 30, // сколько дней помним utm-метки первого визита
    watchDom: true, // следить за динамически добавленными элементами
    debug: false
  };

  for (var k in USER) {
    if (Object.prototype.hasOwnProperty.call(USER, k)) CONFIG[k] = USER[k];
  }
  if (CONFIG.messagePreset && CONFIG.messagePresets[CONFIG.messagePreset]) {
    CONFIG.message = CONFIG.messagePresets[CONFIG.messagePreset];
  }

  var MARK = 'waLeadBound'; // dataset-флаг, чтобы не привязываться дважды
  var STORE_KEY = 'wa_lead_attribution';

  function log() {
    if (CONFIG.debug && window.console) console.log.apply(console, ['[wa-lead]'].concat([].slice.call(arguments)));
  }

  // ───────────────────────────── номер телефона ─────────────────────────────

  function digits(s) {
    return String(s || '').replace(/\D+/g, '');
  }

  /** Нормализует номер к международному формату без плюса. */
  function normalizePhone(raw) {
    var d = digits(raw);
    if (!d) return '';
    // 8XXXXXXXXXX → 7XXXXXXXXXX (частый российский формат)
    if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
    // 9XXXXXXXXX без кода страны
    if (d.length === 10 && d.charAt(0) === '9') d = '7' + d;
    return d.length >= 10 && d.length <= 15 ? d : '';
  }

  /** Ищет номер на странице, если он не задан в конфиге. */
  function detectPhone() {
    var links = document.querySelectorAll('a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="web.whatsapp.com"], a[href^="tel:"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var m = href.match(/(?:wa\.me\/|phone=)(\+?\d[\d\s\-()]*)/i) || href.match(/^tel:(.+)$/i);
      var p = m && normalizePhone(m[1]);
      if (p) return p;
    }
    return '';
  }

  var PHONE = normalizePhone(CONFIG.phone) || detectPhone();

  // ───────────────────────────── атрибуция ──────────────────────────────────

  function readStore() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.ts) return null;
      if (Date.now() - data.ts > CONFIG.attributionDays * 864e5) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function writeStore(data) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      /* приватный режим — просто работаем без сохранения */
    }
  }

  /** Человекочитаемый источник трафика: utm-метка или реферер. */
  function resolveSource() {
    var params = new URLSearchParams(window.location.search);
    var utmSource = params.get('utm_source');
    var utmMedium = params.get('utm_medium');
    var utmCampaign = params.get('utm_campaign');
    var stored = readStore();

    if (utmSource) {
      // Сохраняем метки первого визита, но НЕ теряем уже выданный номер обращения.
      var fresh = {
        ts: Date.now(),
        id: stored && stored.id,
        source: utmSource + (utmMedium ? ' / ' + utmMedium : '') + (utmCampaign ? ' / ' + utmCampaign : '')
      };
      writeStore(fresh);
      return fresh.source;
    }
    if (stored && stored.source) return stored.source;

    var ref = document.referrer;
    if (!ref) return 'прямой заход';
    try {
      var host = new URL(ref).hostname.replace(/^www\./, '');
      if (host === window.location.hostname.replace(/^www\./, '')) return stored ? stored.source : 'прямой заход';
      if (/yandex\./.test(host)) return 'поиск Яндекс';
      if (/google\./.test(host)) return 'поиск Google';
      if (/(instagram|facebook|vk\.com|t\.me|telegram)/.test(host)) return 'соцсети (' + host + ')';
      return host;
    } catch (e) {
      return 'прямой заход';
    }
  }

  /** Короткий номер обращения — владельцу удобно сверять заявки. */
  function leadId() {
    var s = readStore() || {};
    if (!s.id) {
      s.id = String(Date.now()).slice(-6);
      s.ts = s.ts || Date.now();
      s.source = s.source || null;
      writeStore(s);
    }
    return s.id;
  }

  // ───────────────────────────── контекст клика ─────────────────────────────

  function clean(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s—–\-·|•]+|[\s—–\-·|•]+$/g, '')
      .trim();
  }

  /** Заголовок страницы без хвоста «| Клиника ...». */
  function pageName() {
    var h1 = document.querySelector('h1');
    var t = (h1 && clean(h1.textContent)) || clean(document.title).split(/\s[|—–]\s/)[0];
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  /**
   * Определяет услугу для сообщения. Приоритет:
   * data-wa-service → ближайший заголовок секции → текст кнопки → H1/title.
   */
  function detectService(el) {
    var explicit = el && el.closest('[data-wa-service]');
    if (explicit) return clean(explicit.getAttribute('data-wa-service'));

    var section = el && el.closest('section, article, .section, [id]');
    var hops = 0;
    while (section && hops++ < 4) {
      var heading = section.querySelector('h1, h2, h3');
      var text = heading && clean(heading.textContent);
      if (text && text.length > 2 && text.length < 90) return text;
      section = section.parentElement && section.parentElement.closest('section, article, .section, [id]');
    }

    var own = el && clean(el.textContent);
    if (own && own.length > 2 && own.length < 60 && !CONFIG.ctaTextPattern.test(own)) return own;

    return pageName() || CONFIG.defaultService;
  }

  function buildMessage(el, extra) {
    var values = {
      service: (el && detectService(el)) || CONFIG.defaultService,
      page: pageName(),
      title: clean(document.title),
      url: window.location.origin + window.location.pathname,
      source: resolveSource(),
      id: leadId()
    };
    for (var key in extra || {}) values[key] = extra[key];

    var text = CONFIG.message.replace(/\{\{(\w+)\}\}/g, function (_, name) {
      return values[name] != null ? values[name] : '';
    });

    // Подчищаем следы пустых плейсхолдеров: « — .» → «.», двойные пробелы и т.п.
    return text
      .replace(/[ \t]*[—–-][ \t]*(?=[.,!?])/g, '')
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,!?])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function waUrl(text) {
    return 'https://wa.me/' + PHONE + '?text=' + encodeURIComponent(text);
  }

  // ───────────────────────────── аналитика ──────────────────────────────────

  /** Номера счётчиков Яндекс.Метрики: из конфига или найденные на странице. */
  function metrikaCounters() {
    if (CONFIG.yandexCounterId) return [].concat(CONFIG.yandexCounterId);
    var ids = [];
    try {
      var reg = (window.Ya && window.Ya._metrika && window.Ya._metrika.counters) || {};
      for (var key in reg) if (Object.prototype.hasOwnProperty.call(reg, key)) ids.push(reg[key].id || key);
    } catch (e) {
      /* Метрика не установлена */
    }
    return ids;
  }

  function track(service) {
    var payload = { service: service, page: window.location.pathname, source: resolveSource(), lead_id: leadId() };
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'whatsapp_lead', whatsapp_lead: payload });

      if (typeof window.gtag === 'function') window.gtag('event', 'whatsapp_lead', payload);

      if (typeof window.ym === 'function') {
        var counters = metrikaCounters();
        for (var i = 0; i < counters.length; i++) {
          window.ym(counters[i], 'reachGoal', CONFIG.goalName, payload);
        }
      }

      document.dispatchEvent(new CustomEvent('wa-lead:click', { detail: payload }));
    } catch (e) {
      log('track error', e);
    }
    log('lead', payload);
  }

  // ───────────────────────────── открытие чата ──────────────────────────────

  function openChat(el, extra) {
    if (!PHONE) {
      log('номер WhatsApp не задан и не найден на странице — клик пропущен');
      return false;
    }
    var text = buildMessage(el, extra);
    var url = waUrl(text);
    track(extra && extra.service ? extra.service : detectService(el));

    if (CONFIG.openInNewTab) {
      var win = window.open(url, '_blank', 'noopener,noreferrer');
      if (win) return true; // popup прошёл
    }
    window.location.href = url; // fallback: тот же таб
    return true;
  }

  // ───────────────────────────── привязка элементов ─────────────────────────

  function isIgnored(el) {
    return !!(CONFIG.ignoreSelector && el.closest && el.closest(CONFIG.ignoreSelector));
  }

  function bind(el, extra) {
    if (!el || el.dataset[MARK] || isIgnored(el)) return;
    el.dataset[MARK] = '1';

    // Для ссылок подменяем href — работает средний клик, «открыть в новой вкладке»
    // и корректно выглядит в статус-баре браузера.
    if (el.tagName === 'A' && PHONE) {
      var refresh = function () {
        el.setAttribute('href', waUrl(buildMessage(el, extra)));
        if (CONFIG.openInNewTab) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      };
      refresh();
      el.addEventListener('pointerenter', refresh); // текст секции мог измениться
      el.addEventListener('click', function () {
        refresh();
        track(extra && extra.service ? extra.service : detectService(el));
      });
      return;
    }

    el.addEventListener('click', function (e) {
      e.preventDefault();
      openChat(el, extra);
    });
  }

  function collectTargets() {
    var selectors = [];
    if (CONFIG.convertTel) selectors.push('a[href^="tel:"]');
    if (CONFIG.convertMailto) selectors.push('a[href^="mailto:"]');
    if (CONFIG.convertExistingWhatsApp) {
      selectors.push('a[href*="wa.me"]', 'a[href*="api.whatsapp.com"]', 'a[href*="web.whatsapp.com"]');
    }
    selectors.push('[data-wa]'); // ручная разметка: <button data-wa data-wa-service="Ботокс">
    if (CONFIG.extraSelectors) selectors.push(CONFIG.extraSelectors);

    var found = [];
    try {
      found = [].slice.call(document.querySelectorAll(selectors.join(',')));
    } catch (e) {
      log('плохой селектор в extraSelectors', e);
    }

    if (CONFIG.convertCtaByText) {
      var clickable = document.querySelectorAll('a, button, [role="button"]');
      for (var i = 0; i < clickable.length; i++) {
        var node = clickable[i];
        var label = clean(node.textContent) || node.getAttribute('aria-label') || node.value || '';
        if (label && label.length < 60 && CONFIG.ctaTextPattern.test(label) && found.indexOf(node) === -1) {
          found.push(node);
        }
      }
    }
    return found;
  }

  function bindAll() {
    var targets = collectTargets();
    for (var i = 0; i < targets.length; i++) bind(targets[i]);
    log('привязано элементов:', targets.length, '| номер:', PHONE || 'НЕ НАЙДЕН');
  }

  // ───────────────────────────── формы ──────────────────────────────────────

  function formData(form) {
    var out = { name: '', phone: '', comment: '' };
    var fields = form.querySelectorAll('input, textarea, select');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var hint = ((f.name || '') + ' ' + (f.placeholder || '') + ' ' + (f.type || '')).toLowerCase();
      var val = clean(f.value);
      if (!val || f.type === 'hidden' || f.type === 'submit' || f.type === 'checkbox') continue;
      if (!out.name && /(name|имя|фио)/.test(hint)) out.name = val;
      else if (!out.phone && /(phone|tel|телефон)/.test(hint)) out.phone = val;
      else if (!out.comment && /(message|comment|текст|вопрос|коммент)/.test(hint)) out.comment = val;
    }
    return out;
  }

  function bindForms() {
    if (!CONFIG.forms) return;
    var forms = document.querySelectorAll(CONFIG.formSelector);
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        if (form.dataset[MARK] || isIgnored(form)) return;
        form.dataset[MARK] = '1';
        form.addEventListener('submit', function (e) {
          var d = formData(form);
          var extra = {
            service: detectService(form),
            page: pageName()
          };
          var suffix = [];
          if (d.name) suffix.push('Меня зовут ' + d.name + '.');
          if (d.phone) suffix.push('Мой телефон: ' + d.phone + '.');
          if (d.comment) suffix.push(d.comment);

          if (CONFIG.forms === 'replace') e.preventDefault();
          var base = buildMessage(form, extra);
          var text = suffix.length ? base + '\n\n' + suffix.join(' ') : base;
          track(extra.service);
          var url = waUrl(text);
          if (CONFIG.forms === 'replace') {
            if (CONFIG.openInNewTab && window.open(url, '_blank', 'noopener,noreferrer')) return;
            window.location.href = url;
          } else {
            window.open(url, '_blank', 'noopener,noreferrer'); // 'after': форма уходит как обычно
          }
        });
      })(forms[i]);
    }
  }

  // ───────────────────────────── плавающая кнопка ───────────────────────────

  var STYLES =
    '.wa-lead-fab{position:fixed;bottom:var(--wa-offset,20px);z-index:2147483000;display:inline-flex;align-items:center;gap:10px;' +
    'padding:13px 18px 13px 14px;border-radius:999px;background:#25D366;color:#fff;font:600 15px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;' +
    'text-decoration:none;box-shadow:0 6px 24px rgba(37,211,102,.42);transition:transform .2s ease,opacity .25s ease,box-shadow .2s ease;' +
    '-webkit-tap-highlight-color:transparent;opacity:0;transform:translateY(12px)}' +
    '.wa-lead-fab.is-visible{opacity:1;transform:none}' +
    '.wa-lead-fab.is-hidden{opacity:0;transform:translateY(12px);pointer-events:none}' +
    '.wa-lead-fab:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(37,211,102,.5);color:#fff}' +
    '.wa-lead-fab:focus-visible{outline:3px solid #0b5c2c;outline-offset:3px}' +
    '.wa-lead-fab--right{right:var(--wa-offset,20px)}.wa-lead-fab--left{left:var(--wa-offset,20px)}' +
    '.wa-lead-fab svg{width:26px;height:26px;flex:none;fill:currentColor}' +
    '.wa-lead-fab__label{white-space:nowrap}' +
    '@media (max-width:600px){.wa-lead-fab{padding:14px;border-radius:50%}.wa-lead-fab__label{display:none}}' +
    '@media (prefers-reduced-motion:reduce){.wa-lead-fab{transition:opacity .2s ease}.wa-lead-fab:hover{transform:none}}';

  var WA_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15s-.77.96-.94 1.16c-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.48-1.75-1.65-2.05-.17-.3-.02-.46.13-.6.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35zM12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.02h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24a8.2 8.2 0 0 1 5.83 2.42 8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23z"/></svg>';

  function mountFab() {
    if (!CONFIG.floatingButton || !PHONE || document.querySelector('.wa-lead-fab')) return;

    var style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);

    var a = document.createElement('a');
    a.className = 'wa-lead-fab wa-lead-fab--' + (CONFIG.floatingButtonPosition === 'left' ? 'left' : 'right');
    a.style.setProperty('--wa-offset', CONFIG.floatingButtonOffset + 'px');
    a.setAttribute('aria-label', CONFIG.floatingButtonText);
    a.innerHTML = WA_ICON + '<span class="wa-lead-fab__label">' + CONFIG.floatingButtonText + '</span>';
    a.dataset[MARK] = '1'; // не перепривязывать общим обработчиком

    var refresh = function () {
      a.setAttribute('href', waUrl(buildMessage(null, { service: pageName() || CONFIG.defaultService })));
      if (CONFIG.openInNewTab) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    };
    refresh();
    a.addEventListener('pointerenter', refresh);
    a.addEventListener('click', function () {
      refresh();
      track(pageName());
    });

    document.body.appendChild(a);
    window.setTimeout(function () {
      a.classList.add('is-visible');
    }, Math.max(CONFIG.floatingButtonDelay, 30));

    if (CONFIG.floatingButtonHideOnScrollUp) {
      var last = window.pageYOffset;
      window.addEventListener(
        'scroll',
        function () {
          var y = window.pageYOffset;
          a.classList.toggle('is-hidden', y < last && y > 200);
          last = y;
        },
        { passive: true }
      );
    }
  }

  // ───────────────────────────── публичный API ──────────────────────────────

  window.WhatsAppLead = {
    config: CONFIG,
    phone: function () {
      return PHONE;
    },
    /** Открыть чат вручную: WhatsAppLead.open('Лазерная эпиляция') */
    open: function (service) {
      return openChat(null, service ? { service: service } : null);
    },
    /** Ссылка для вставки куда угодно: WhatsAppLead.link('Консультация') */
    link: function (service) {
      return PHONE ? waUrl(buildMessage(null, service ? { service: service } : null)) : '';
    },
    /** Перепривязать после подгрузки контента вручную. */
    refresh: function () {
      bindAll();
      bindForms();
    }
  };

  // ───────────────────────────── запуск ─────────────────────────────────────

  function init() {
    if (!PHONE) {
      log('ВНИМАНИЕ: не задан CONFIG.phone и на странице нет tel:/wa.me ссылок. Скрипт не активен.');
      return;
    }
    bindAll();
    bindForms();
    mountFab();

    if (CONFIG.watchDom && window.MutationObserver) {
      var pending = null;
      new MutationObserver(function () {
        window.clearTimeout(pending);
        pending = window.setTimeout(function () {
          bindAll();
          bindForms();
        }, 300);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
