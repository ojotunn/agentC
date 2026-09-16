// Prova do site num Chrome headless: sobe o servidor numa porta livre com um
// DATA_DIR (por padrao o da ultima prova e2e, para a tela ter conteudo), abre
// a pagina publica e o painel, conta erros de JS e pixels acesos, e salva as
// fotos em scratch/. Nao abre janela nenhuma.
//
//   node scripts/prova-site.mjs [dataDir] [outDir]
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const dataDir = process.argv[2] || fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('warden-prova-')).map((d) => path.join(os.tmpdir(), d, 'data')).filter((d) => fs.existsSync(path.join(d, 'state.json'))).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || path.join(ROOT, 'data');
const outDir = process.argv[3] || path.join(ROOT, 'scratch');
fs.mkdirSync(outDir, { recursive: true });
const PORT = 8490 + Math.floor(Math.random() * 100);
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

console.log(`[site] data=${dataDir} port=${PORT}`);
const srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: 'prova-token', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
const up = async () => { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; };
if (!(await up())) { console.error('server did not start'); srv.kill(); process.exit(2); }

let failed = false;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
try {
  for (const [name, url, w] of [['index', `http://127.0.0.1:${PORT}/`, 1280], ['index-mobile', `http://127.0.0.1:${PORT}/`, 390], ['admin', `http://127.0.0.1:${PORT}/admin`, 1280]]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
    if (name === 'admin') await page.evaluateOnNewDocument(() => localStorage.setItem('warden_admin', 'prova-token'));
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3500)); // dois ticks do /api/state
    const file = path.join(outDir, `site-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const text = await page.evaluate(() => document.body.innerText);
    const checks = name === 'admin'
      ? ['Engine', 'status', 'Contests', 'Ledger'].map((k) => [k, text.toLowerCase().includes(k.toLowerCase())])
      : ['WARDEN', 'files read', 'hypotheses', 'How it works', 'Ledger'].map((k) => [k, text.toLowerCase().includes(k.toLowerCase())]);
    const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
    const png = fs.statSync(file).size;
    console.log(`[site] ${name}: ${errors.length} js errors, ${text.length} chars of text, png ${(png / 1024).toFixed(0)} KB, missing: ${bad.join(',') || 'none'} -> ${file}`);
    errors.forEach((e) => console.log('   ' + e));
    if (errors.length || bad.length || png < 5000 || text.length < 200) failed = true;
    await page.close();
  }
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? '[site] FAILED' : '[site] OK');
process.exit(failed ? 1 : 0);
