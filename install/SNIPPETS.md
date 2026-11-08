# Код для вставки на сайты

По одному блоку на сайт. Вставлять **перед закрывающим `</body>`**.

Файл `contact-tracker.js` из корня репозитория положите в корень каждого сайта,
чтобы он открывался по адресу `https://<сайт>/contact-tracker.js`.

Пять сайтов (veliora, 3dlab, yallapro, web1, tonyateddy) лежат на одном сервере
nginx — туда файл достаточно положить один раз в каталог каждого сайта.

---

## veliora.clinic

Счётчик меняется: сейчас стоит `G-72QJ6FFJ6N` (чужой, от web1), нужен свой.
**Найдите в коде `G-72QJ6FFJ6N` и замените весь блок на этот.**

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-26EE1W3M11"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-26EE1W3M11');
</script>

<script>window.CT = { site: 'veliora.clinic' };</script>
<script src="/contact-tracker.js" defer></script>
```

---

## 3dlab.co.il

Счётчик меняется с `G-72QJ6FFJ6N` на свой.
`skipWhatsApp` — потому что на сайте уже есть собственное событие
`whatsapp_click`, без этого обращения посчитаются дважды.

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-X3G7R5T6QC"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-X3G7R5T6QC');
</script>

<script>window.CT = { site: '3dlab.co.il', skipWhatsApp: true };</script>
<script src="/contact-tracker.js" defer></script>
```

---

## yallapro.co.il

Счётчик меняется с `G-72QJ6FFJ6N` на свой. Своё событие `whatsapp_click`
тоже есть — `skipWhatsApp` обязателен.

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-8V67G93M83"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-8V67G93M83');
</script>

<script>window.CT = { site: 'yallapro.co.il', skipWhatsApp: true };</script>
<script src="/contact-tracker.js" defer></script>
```

---

## web1.co.il

Счётчик **остаётся прежним** — `G-72QJ6FFJ6N` теперь принадлежит только этому
сайту. Трогать код счётчика не нужно, добавьте только трекер.

```html
<script>window.CT = { site: 'web1.co.il' };</script>
<script src="/contact-tracker.js" defer></script>
```

---

## tonyateddy.art

Ресурс GA4 существует, но кода счётчика на странице не нашлось — только
Яндекс.Метрика. Поставьте целиком.

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-535MXNJEKG"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-535MXNJEKG');
</script>

<script>window.CT = { site: 'tonyateddy.art' };</script>
<script src="/contact-tracker.js" defer></script>
```

---

## gruzhaifa.co.il (Nethouse + GTM)

Счётчик свой и работает — не трогайте. Нужен только трекер.

Сайт на Nethouse, прямого доступа к файлам нет. Два пути:

**Через Tag Manager** (контейнер `GTM-M94RVPG9` уже на сайте) — предпочтительно:
Теги → Создать → Пользовательский HTML, вставить код ниже, триггер
«All Pages», Опубликовать.

**Или** в панели Nethouse: Настройки → Реклама и счётчики → поле для кода в футер.

```html
<script>window.CT = { site: 'gruzhaifa.co.il' };</script>
<script src="https://gruzhaifa.co.il/contact-tracker.js" defer></script>
```

Если положить файл в корень Nethouse нельзя, вставьте содержимое
`contact-tracker.js` целиком между `<script>` и `</script>` вместо ссылки.

---

## aqualit63.ru (Next.js)

GA4 не было вообще. В корневой layout (`app/layout.tsx` или `pages/_app.tsx`):

```jsx
import Script from 'next/script';

// внутри <body>, перед закрывающим тегом:
<Script
  src="https://www.googletagmanager.com/gtag/js?id=G-J26LH5D278"
  strategy="afterInteractive"
/>
<Script id="ga4" strategy="afterInteractive">
  {`window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-J26LH5D278');`}
</Script>

<Script id="ct-config" strategy="afterInteractive">
  {`window.CT = { site: 'aqualit63.ru' };`}
</Script>
<Script src="/contact-tracker.js" strategy="afterInteractive" />
```

Файл `contact-tracker.js` кладётся в папку `public/`.

---

## газтехника-самара.рф

Сайт из этой среды не открывался — кириллические домены не пропускает
сетевая политика, платформу определить не удалось. Счётчик создан,
вставьте по образцу статических сайтов выше.

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-H9JVGQZ2SR"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-H9JVGQZ2SR');
</script>

<script>window.CT = { site: 'газтехника-самара.рф' };</script>
<script src="/contact-tracker.js" defer></script>
```

---

## Проверка после установки

На каждом сайте: откройте страницу, нажмите кнопку WhatsApp, затем в GA4
того же ресурса → **Отчёты → В реальном времени**.

Должны появиться:
- `page_view` — счётчик работает
- `whatsapp_click` с параметрами `site`, `section`, `destination` — трекер работает

Если `page_view` есть, а `whatsapp_click` нет — не подключился
`contact-tracker.js`: откройте `https://<сайт>/contact-tracker.js` в браузере
и убедитесь, что файл отдаётся, а не выдаёт 404.

Специальные параметры в обычных отчётах появятся через 24–48 часов.
В «Реальном времени» — сразу.
