Задача: установить на сайты Google Analytics 4 и трекер обращений. У тебя есть SSH-доступ к серверу, где лежат сайты. Сделай всё сам и пришли отчёт.

## Что известно

Статические сайты veliora.clinic, 3dlab.co.il, yallapro.co.il, web1.co.il и tonyateddy.art лежат на одном сервере: nginx/1.18.0 на Ubuntu. Сейчас veliora, 3dlab и yallapro по ошибке шлют данные в счётчик web1 (G-72QJ6FFJ6N). Для каждого из них уже создан свой счётчик, его надо поставить вместо чужого.

| Сайт | Что сделать | Счётчик | skipWhatsApp |
|---|---|---|---|
| veliora.clinic | заменить G-72QJ6FFJ6N на свой + трекер | G-26EE1W3M11 | нет |
| 3dlab.co.il | заменить G-72QJ6FFJ6N на свой + трекер | G-X3G7R5T6QC | да |
| yallapro.co.il | заменить G-72QJ6FFJ6N на свой + трекер | G-8V67G93M83 | да |
| web1.co.il | счётчик НЕ менять, только трекер | G-72QJ6FFJ6N | нет |
| tonyateddy.art | поставить счётчик (на странице его нет) + трекер | G-535MXNJEKG | нет |
| газтехника-самара.рф | найти на сервере; если статика — счётчик + трекер | G-H9JVGQZ2SR | нет |
| aqualit63.ru | Next.js за Cloudflare; если на этом сервере — счётчик + трекер | G-J26LH5D278 | нет |
| gruzhaifa.co.il | НЕ ТРОГАТЬ: это Nethouse, на сервере его нет | — | — |

skipWhatsApp=да: на 3dlab и yallapro уже есть своё событие whatsapp_click, без этой опции обращения посчитаются дважды.

Punycode для газтехника-самара.рф: xn----7sbabaaprrlw1ah3clj6c.xn--p1ai

## Шаги

### 1. Найти каталоги сайтов

```bash
grep -rE "server_name|root " /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
```

Сопоставь каждый домен с его root. **Проверь, что у разных сайтов разные каталоги.** Если какой-то каталог общий для нескольких сайтов — остановись и спроси: замена счётчика тогда заденет чужой сайт.

### 2. Сделать бэкап каждого каталога

```bash
tar czf /root/backup-<домен>-$(date +%F-%H%M).tgz -C <root> .
```

### 3. Положить трекер в корень каждого сайта (кроме gruzhaifa)

```bash
curl -fsSL -o <root>/contact-tracker.js \
  https://raw.githubusercontent.com/ksemenhaifa/vpnbottelega/b7da01f65d4448c02081ed2b73a4734f122ef7a9/contact-tracker.js
sha256sum <root>/contact-tracker.js
```

Контрольная сумма должна быть ровно такой:
`49e031e1664efae2f8e35ae5d5529e31a8f9643a90571705fb5d986f2fed6110`

Не совпала — файл не использовать, остановиться и сообщить. Права и владельца выставить как у соседних файлов сайта (`ls -l <root>`).

### 4. Заменить счётчик — только veliora, 3dlab, yallapro

Сначала посмотреть, где он встречается:

```bash
grep -rl 'G-72QJ6FFJ6N' <root>
```

Потом заменить **только в каталоге этого сайта**:

```bash
grep -rl 'G-72QJ6FFJ6N' <root> | xargs sed -i 's/G-72QJ6FFJ6N/<НОВЫЙ_ID>/g'
```

**В каталоге web1.co.il эту замену не делать** — G-72QJ6FFJ6N остаётся за ним.

### 5. Поставить счётчик там, где его нет — tonyateddy, газтехника, aqualit

Сначала убедиться, что gtag действительно нет: `grep -rl 'googletagmanager.com/gtag' <root>`. Если уже есть — не дублировать, сообщить, какой ID там стоит.

Если нет — вставить перед `</head>` на каждой HTML-странице:

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=<ID>"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '<ID>');
</script>
```

### 6. Вставить трекер перед `</body>` на всех страницах

Скрипт вставляет блок один раз и пропускает страницы, где трекер уже есть. Сохрани его как `/root/add_tracker.py`:

```python
import sys, pathlib
root, site, skip = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
cfg = "{ site: '%s'%s }" % (site, ", skipWhatsApp: true" if skip else "")
snippet = ('<script>window.CT = %s;</script>\n'
           '<script src="/contact-tracker.js" defer></script>\n') % cfg
for p in pathlib.Path(root).rglob('*'):
    if not p.is_file() or p.suffix.lower() not in ('.html', '.htm'):
        continue
    if any(part in ('.git', 'node_modules') for part in p.parts):
        continue
    s = p.read_text(encoding='utf-8', errors='surrogateescape')
    if 'contact-tracker.js' in s:
        print('уже есть:', p); continue
    i = s.lower().rfind('</body>')
    if i < 0:
        print('НЕТ </body>:', p); continue
    p.write_text(s[:i] + snippet + s[i:], encoding='utf-8', errors='surrogateescape')
    print('вставлено:', p)
```

Запуск: `python3 /root/add_tracker.py <root> <домен> <1 если skipWhatsApp иначе 0>`

Примеры:

```bash
python3 /root/add_tracker.py /var/www/veliora.clinic veliora.clinic 0
python3 /root/add_tracker.py /var/www/3dlab.co.il 3dlab.co.il 1
```

Пути подставь реальные из шага 1. Если страницы сайта — `.php` или шаблоны, а не `.html`, остановись и спроси.

### 7. aqualit63.ru (Next.js)

Если проект на этом сервере: положи `contact-tracker.js` в `public/`, в корневой layout (`app/layout.tsx` или `pages/_app.tsx`) добавь внутри `<body>`:

```jsx
<Script src="https://www.googletagmanager.com/gtag/js?id=G-J26LH5D278" strategy="afterInteractive" />
<Script id="ga4" strategy="afterInteractive">{`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-J26LH5D278');`}</Script>
<Script id="ct-config" strategy="afterInteractive">{`window.CT={site:'aqualit63.ru'};`}</Script>
<Script src="/contact-tracker.js" strategy="afterInteractive" />
```

с `import Script from 'next/script'`. Пересобери и перезапусти так, как он запущен (выясни: pm2, systemd или docker). Если проекта на сервере нет — пропусти и напиши об этом в отчёте.

### 8. nginx не перезапускать

Для статики это не нужно. Если всё же правишь конфиг — сначала `nginx -t`, потом `systemctl reload nginx`.

## Проверка

Для каждого сайта:

```bash
curl -s https://<домен>/ | grep -oE 'G-[A-Z0-9]{8,}' | sort -u
curl -s https://<домен>/ | grep -c 'contact-tracker.js'
curl -s -o /dev/null -w '%{http_code}\n' https://<домен>/contact-tracker.js
```

Ожидается: только новый ID (у web1 — G-72QJ6FFJ6N), трекер найден, файл отдаёт 200. aqualit63.ru за Cloudflare — если видна старая версия, это кэш.

## Отчёт

Пришли таблицу: домен → путь к каталогу → какой счётчик стоит теперь → сколько страниц получили трекер → результат проверки. Отдельно — что пропущено и почему, и пути к бэкапам.

## Ограничения

- Менять только то, что описано выше. Остальной код сайтов не трогать.
- gruzhaifa.co.il не трогать.
- Если что-то не совпадает с описанием — общий каталог у нескольких сайтов, нет `</body>`, сайт на шаблонизаторе или CMS, счётчик уже стоит другой — остановись и спроси, не угадывай.
