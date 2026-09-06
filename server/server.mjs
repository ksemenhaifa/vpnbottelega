/* ============================================================
 *  Минимальный сервер без зависимостей:
 *   · раздаёт статику проекта (index.html, assets/…)
 *   · API показаний: GET/POST /api/readings, DELETE /api/readings/:id
 *  Данные — в server/data/readings.json.
 *  Запуск:  node server/server.mjs  [порт, по умолчанию 8080]
 * ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'server', 'data');
const DATA = path.join(DATA_DIR, 'readings.json');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MAX_READINGS = 5000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function load() { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return []; } }
function save(list) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(list, null, 1)); }
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
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
      let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const bad = validate(body); if (bad) return json(res, 400, { error: 'invalid ' + bad });
      const reading = { id: body.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: Number(body.ts) || Date.now(),
        houseId: body.houseId, address: String(body.address || '').slice(0, 120), pressure: Number(body.pressure),
        comment: String(body.comment || '').slice(0, 300), demo: !!body.demo };
      const list = [reading].concat(load().filter((r) => r.id !== reading.id)).slice(0, MAX_READINGS);
      save(list); return json(res, 201, reading);
    }
    if (req.method === 'DELETE' && id) { save(load().filter((r) => r.id !== id)); return json(res, 204); }
    return json(res, 405, { error: 'method' });
  }
  // статика
  let file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT) || file.startsWith(DATA_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Стрижи · водоснабжение: http://localhost:${PORT}  (API: /api/readings)`));
