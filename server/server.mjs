/* ============================================================
 *  Минимальный сервер без зависимостей:
 *   · раздаёт статику проекта (index.html, assets/…)
 *   · API показаний: GET/POST /api/readings, DELETE /api/readings/:id
 *   · API модели сети: GET/PUT/DELETE /api/config
 *  Данные — в server/data/readings.json и config.json.
 *  ВНИМАНИЕ: сервер не проверяет права. Запись в /api/config должен
 *  закрывать обратный прокси (см. deploy/nginx.conf, limit_except GET).
 *  Запуск:  node server/server.mjs  [порт, по умолчанию 8080]
 *  Переменные окружения:
 *    PORT         порт (по умолчанию 8080)
 *    HOST         интерфейс (по умолчанию 0.0.0.0; за nginx можно 127.0.0.1)
 *    DATA_DIR     каталог хранения показаний
 *    TRUST_PROXY  1 — брать IP клиента из X-Forwarded-For (за обратным прокси)
 *    CORS_ORIGIN  разрешённый источник для API (по умолчанию * )
 *    RATE_LIMIT   записей с одного IP за 10 минут (по умолчанию 30, 0 — без лимита)
 * ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'server', 'data'));
const DATA = path.join(DATA_DIR, 'readings.json');
const CONFIG = path.join(DATA_DIR, 'config.json');
const CONFIG_LOG = path.join(DATA_DIR, 'config-log.jsonl');
const MAX_LOG = 500;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const RATE_LIMIT = process.env.RATE_LIMIT === undefined ? 30 : Number(process.env.RATE_LIMIT);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_READINGS = 5000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return []; } }
function save(list) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(list, null, 1)); }
/* Модель сети. Пустой ответ — значит правка не сохранялась и работает
 * встроенная модель из assets/js/config.js. */
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return null; } }
function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, CONFIG + '.bak');   // прошлая версия на случай ошибки
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 1));
}
/* Разворачиваем модель в плоские пути вида streets.0.main.d — так видно,
 * что именно поменялось, без хранения копии всего конфига на каждую правку. */
function flat(o, prefix, out) {
  out = out || {}; prefix = prefix || '';
  if (o === null || typeof o !== 'object') { out[prefix] = o; return out; }
  if (Array.isArray(o) && o.every((v) => v === null || typeof v !== 'object')) { out[prefix] = o.join(', '); return out; }
  Object.keys(o).forEach((k) => flat(o[k], prefix ? prefix + '.' + k : k, out));
  return out;
}
function diff(before, after) {
  const a = flat(before || {}), b = flat(after || {});
  const changes = [];
  Object.keys(b).forEach((k) => { if (String(a[k]) !== String(b[k])) changes.push({ path: k, was: a[k] === undefined ? null : a[k], now: b[k] }); });
  Object.keys(a).forEach((k) => { if (!(k in b)) changes.push({ path: k, was: a[k], now: null }); });
  return changes;
}
function logAction(req, action, changes) {
  const rec = {
    ts: new Date().toISOString(),
    user: String(req.headers['x-auth-user'] || '').slice(0, 64) || 'неизвестно',
    ip: clientIp(req),
    action,
    changes: (changes || []).slice(0, 200),
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(CONFIG_LOG, JSON.stringify(rec) + '\n');
    /* Файл не должен расти без предела: держим последние MAX_LOG записей. */
    const lines = fs.readFileSync(CONFIG_LOG, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LOG) fs.writeFileSync(CONFIG_LOG, lines.slice(-MAX_LOG).join('\n') + '\n');
  } catch (e) { console.error('log:', e.message); }
}
function readLog() {
  try {
    return fs.readFileSync(CONFIG_LOG, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}

/* Проверяем ровно то, без чего расчёт развалится или выдаст бесконечность. */
function validateConfig(c) {
  if (!c || typeof c !== 'object') return 'не объект';
  if (!Array.isArray(c.streets) || !c.streets.length) return 'нет улиц';
  if (!Array.isArray(c.wells) || !c.wells.length) return 'нет скважин';
  if (!c.norm || !(c.norm.min < c.norm.max)) return 'норма давления';
  for (const s of c.streets) {
    if (!s.id || !s.name) return 'улица без имени';
    if (!(s.step > 0)) return `улица ${s.name}: шаг между вводами`;
    if (!(s.x1 > s.x0)) return `улица ${s.name}: длина`;
    if (!(s.main && s.main.d > 0)) return `улица ${s.name}: диаметр магистрали`;
    if (!(s.branch && s.branch.d > 0 && s.branch.length > 0)) return `улица ${s.name}: ввод в дом`;
    if (!Array.isArray(s.elevation) || s.elevation.length !== 2) return `улица ${s.name}: отметки`;
    if ((s.x1 - s.x0) / s.step > 400) return `улица ${s.name}: слишком много узлов`;
  }
  for (const w of c.wells) {
    if (!w.id) return 'скважина без имени';
    if (!(w.pressure > 0 && w.pressure < 16)) return `скважина ${w.name || w.id}: давление 0–16 бар`;
    if (!(w.pipe && w.pipe.d > 0 && w.pipe.length > 0)) return `скважина ${w.name || w.id}: водовод`;
  }
  return null;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
// ── простой лимит записи с одного IP: публичный сервер не должен принимать поток мусора
const hits = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}
function rateLimited(req) {
  if (!RATE_LIMIT) return false;
  const now = Date.now(), ip = clientIp(req);
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.size > 5000) hits.clear();
  if (list.length >= RATE_LIMIT) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list); return false;
}

function validate(r) {
  const p = Number(r.pressure);
  if (!r.houseId || typeof r.houseId !== 'string' || r.houseId.length > 32) return 'houseId';
  if (!isFinite(p) || p < 0 || p > 16) return 'pressure';
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204);
  if (url.pathname.startsWith('/api/readings')) {
    const id = decodeURIComponent(url.pathname.slice('/api/readings'.length).replace(/^\//, ''));
    if (req.method === 'GET') return json(res, 200, load());
    if (req.method === 'POST') {
      if (rateLimited(req)) return json(res, 429, { error: 'too many readings' });
      let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const bad = validate(body); if (bad) return json(res, 400, { error: 'invalid ' + bad });
      const reading = { id: body.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: Number(body.ts) || Date.now(),
        houseId: body.houseId, address: String(body.address || '').slice(0, 120), pressure: Number(body.pressure),
        comment: String(body.comment || '').slice(0, 300), demo: !!body.demo };
      const list = [reading].concat(load().filter((r) => r.id !== reading.id)).slice(0, MAX_READINGS);
      save(list); return json(res, 201, reading);
    }
    if (req.method === 'DELETE' && id) {
      if (rateLimited(req)) return json(res, 429, { error: 'too many requests' });
      save(load().filter((r) => r.id !== id)); return json(res, 204);
    }
    return json(res, 405, { error: 'method' });
  }
  /* Модель сети. Читать может кто угодно из-за входа жителя, писать — только
   * админ: доступ к PUT/DELETE ограничивает прокси, не этот код. */
  if (url.pathname === '/api/config/log') {
    if (req.method === 'GET') return json(res, 200, readLog());
    return json(res, 405, { error: 'method' });
  }
  if (url.pathname === '/api/config') {
    if (req.method === 'GET') return json(res, 200, loadConfig() || {});
    if (req.method === 'PUT') {
      let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const bad = validateConfig(body);
      if (bad) return json(res, 400, { error: bad });
      const changes = diff(loadConfig(), body);
      saveConfig(body);
      logAction(req, 'правка модели', changes);
      return json(res, 200, { ok: true, changed: changes.length });
    }
    if (req.method === 'DELETE') {                 // вернуться к встроенной модели
      try { if (fs.existsSync(CONFIG)) { fs.copyFileSync(CONFIG, CONFIG + '.bak'); fs.unlinkSync(CONFIG); } } catch (e) { /* нечего удалять */ }
      logAction(req, 'возврат к демо-модели', []);
      return json(res, 204);
    }
    return json(res, 405, { error: 'method' });
  }

  // статика
  let rel; try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch (e) { res.writeHead(400); return res.end(); }
  let file = path.normalize(path.join(ROOT, rel));
  const hidden = rel.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR) || hidden) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, HOST, () => console.log(`Стрижи · водоснабжение: http://${HOST}:${PORT}  (API: /api/readings)`));
