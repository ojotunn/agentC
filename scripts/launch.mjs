// Largada: cadastra o contest de launch/<nome>.json no servidor que ja esta no
// ar (START-Windows.bat) e da o start. Um comando so, na hora do lancamento.
//
//   node scripts/launch.mjs tenbin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const name = process.argv[2] || 'tenbin';
const file = path.join(ROOT, 'launch', `${name}.json`);
if (!fs.existsSync(file)) { console.error(`no launch/${name}.json`); process.exit(2); }
const contest = JSON.parse(fs.readFileSync(file, 'utf8'));
const port = process.env.PORT || 8441;
const base = `http://127.0.0.1:${port}`;
const token = process.env.ADMIN_TOKEN || fs.readFileSync(path.join(ROOT, process.env.DATA_DIR || 'data', 'admin.token'), 'utf8').trim();
const H = { 'content-type': 'application/json', 'x-admin-token': token };

const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) { console.error(`server not running on ${base}. Start it first (START-Windows.bat).`); process.exit(2); }
const state = await fetch(`${base}/api/admin/state`, { headers: H }).then((r) => r.json());
if (state.contests?.length) { console.error(`the site is not zero: ${state.contests.length} contest(s) already registered. Delete them in /admin or wipe data/state.json.`); process.exit(2); }
if (!state.tools?.claude) { console.error('ANTHROPIC_API_KEY missing in .env'); process.exit(2); }
if (!state.tools?.forge) { console.error('forge not found (tools/foundry/forge.exe)'); process.exit(2); }

const added = await fetch(`${base}/api/admin/contests`, { method: 'POST', headers: H, body: JSON.stringify(contest) }).then((r) => r.json());
if (!added.id) { console.error('add failed', added); process.exit(1); }
const started = await fetch(`${base}/api/admin/contests/${added.id}/start`, { method: 'POST', headers: H }).then((r) => r.json());
if (!started.ok) { console.error('start failed', started); process.exit(1); }
console.log(`launched: ${contest.title} (${added.id}). Watch it at ${base}`);
