/* Собирает автономный файл dist/strizhi-water.html (всё встроено, работает с диска).
 *   node tools/build-single.mjs             → полный HTML-документ
 *   node tools/build-single.mjs --fragment  → без <html>/<head>/<body> (для встраивания) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fragment = process.argv.includes('--fragment');
const JS = ['assets/js/config.js', 'assets/js/address.js', 'assets/js/hydraulics.js', 'assets/js/reports.js', 'assets/js/scheme.js', 'assets/js/profile.js', 'assets/js/app.js'];

const body = `<title>Стрижи · Водоснабжение</title>
<style>
${read('assets/css/scheme.css')}
</style>
<div id="water-scheme"></div>
<script>
${JS.map(read).join('\n')}
SW.mount(document.getElementById('water-scheme'), {});
</script>
`;
const out = fragment ? body : `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${body.split('<div id="water-scheme"></div>')[0]}</head>
<body>
<div id="water-scheme"></div>${body.split('<div id="water-scheme"></div>')[1]}</body>
</html>
`;
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const file = path.join(ROOT, 'dist', fragment ? 'strizhi-water.fragment.html' : 'strizhi-water.html');
fs.writeFileSync(file, out);
console.log('written', path.relative(ROOT, file), (out.length / 1024).toFixed(0) + ' KB');
