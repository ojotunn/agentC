// Marca do Warden para o X: avatar 400x400 e capa 1500x500, desenhados em HTML
// com a mesma fonte e o mesmo escudo do site, renderizados no Chrome headless
// em 2x. Saida em brand/.
//
//   node scripts/brand.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const out = path.join(ROOT, 'brand');
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MARK = (color, w) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" aria-hidden="true"><path d="M12 2.5l7 3v6c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9v-6l7-3z" fill="none" stroke="${color}" stroke-width="1.7"/><path d="M8.4 12l2.6 2.6 4.6-5.1" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const HEAD = `<meta charset="utf-8"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet"><style>html,body{margin:0}body{font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}.d{font-family:"Space Grotesk",Inter,sans-serif}</style>`;

// Avatar: fundo grafite, escudo branco grande. Le bem no circulo pequeno do X.
const avatar = `<!doctype html><html><head>${HEAD}</head><body style="width:400px;height:400px;background:#111318;display:flex;align-items:center;justify-content:center"><div class="d" style="font-size:250px;font-weight:700;color:#ffffff;letter-spacing:-0.04em;line-height:1;margin-top:-14px">W</div></body></html>`;

// Capa: branco, escudo + wordmark grande, tagline e linha do token; a direita um
// trecho de log em cinza bem claro, como textura.
const banner = `<!doctype html><html><head>${HEAD}</head><body style="width:1500px;height:500px;background:#ffffff;position:relative;overflow:hidden;color:#111318">
<div style="position:absolute;left:96px;top:104px;display:flex;align-items:center;gap:26px"><div class="d" style="font-size:96px;font-weight:700;letter-spacing:-0.03em;line-height:1">Warden</div></div>
<div style="position:absolute;left:96px;top:236px;width:900px;font-size:29px;color:#3f4650;font-weight:500;letter-spacing:-0.01em;line-height:1.3">An AI agent working as a security researcher. Every finding proven by a running exploit.</div>
<div style="position:absolute;left:96px;top:300px;width:900px;font-size:22px;color:#6b7280;line-height:1.4">Works audit contests and bug bounties. Prizes buy back and burn $WARDEN on Robinhood Chain.</div>
<div style="position:absolute;right:0;top:0;width:440px;height:500px;background:#fafafa;border-left:1px solid #e6e8eb;padding:40px 40px;font:15px/1.85 ui-monospace,'Cascadia Mono',Consolas,monospace;color:#9aa1ab;white-space:pre">00:30:22  reading src/Controller.sol
00:31:02  4 hypotheses (High)
00:31:27  writing PoC for W1
00:31:39  forge test W1 ... PASS
00:31:48  judge: High, genuine
00:32:18  report written
00:32:54  writing PoC for W2
00:33:15  forge test W2 ... FAIL
00:33:31  attempt 2/4
00:33:56  forge test W2 ... PASS
00:34:22  2 findings ready_</div>
<div style="position:absolute;left:96px;bottom:46px;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#9aa1ab;font-weight:600">contests · bounties · foundry proofs · buyback &amp; burn</div>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
try {
  for (const [name, html, w, h] of [['x-avatar', avatar, 400, 400], ['x-banner', banner, 1500, 500]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 400));
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    console.log(`[brand] ${name}: ${w}x${h} @2x -> ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
    await page.close();
  }
} finally { await browser.close(); }
