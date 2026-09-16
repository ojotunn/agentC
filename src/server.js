// Servidor do Warden: site publico, painel do criador (token) e API do motor.
// Uma porta so. No Railway o mesmo servidor roda sem motor, servindo o estado
// que o motor local empurra em POST /api/mirror.
import path from 'node:path';
import express from 'express';
import { ROOT, PORT, PUBLIC_URL, CANONICAL_HOST, AGENT, MODEL, LIMITS, MIRROR, VERSION, APP_NAME } from './config.js';
import * as S from './state.js';
import * as engine from './engine.js';
import * as sherlock from './sherlock.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (req.method === 'GET' && host && host !== CANONICAL_HOST && !req.path.startsWith('/api')) return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    next();
  });
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const ADMIN = S.adminToken();
const auth = (req, res, next) => {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== ADMIN) return res.status(401).json({ error: 'admin token required' });
  next();
};

const agentInfo = () => ({ name: AGENT.name, handle: AGENT.handle, symbol: AGENT.symbol, tokenAddress: AGENT.tokenAddress, tokenUrl: AGENT.tokenUrl, x: AGENT.x, telegram: AGENT.telegram, model: MODEL.main, maxUsdPerContest: LIMITS.maxUsdPerContest, version: VERSION });

// -------------------------------------------------------------------- publico
app.get('/api/health', (_req, res) => res.json({ ok: true, app: APP_NAME, version: VERSION, mirror: !!S.getMirrored(), engine: engine.status().busy || null }));

app.get('/api/state', (_req, res) => {
  const m = S.getMirrored();
  const v = m || S.publicView();
  res.json({ ...v, agent: agentInfo(), mirrored: !!m });
});

// ---------------------------------------------------------------------- espelho
app.post('/api/mirror', (req, res) => {
  if (!MIRROR.token || req.headers['x-mirror-token'] !== MIRROR.token) return res.status(401).json({ error: 'mirror token' });
  if (!req.body || !Array.isArray(req.body.contests)) return res.status(400).json({ error: 'bad body' });
  S.setMirrored({ ...req.body, receivedAt: Date.now() });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------- painel
app.get('/api/admin/state', auth, async (_req, res) => {
  const s = S.load();
  res.json({ ...s, agent: agentInfo(), engine: { ...s.engine, ...engine.status() }, tools: await engine.toolsReport(), limits: LIMITS });
});

app.get('/api/admin/sherlock', auth, async (_req, res) => {
  try { res.json({ contests: await sherlock.list() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/admin/sherlock/:id', auth, async (req, res) => {
  try { res.json(await sherlock.detail(req.params.id)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Cadastro manual (qualquer plataforma) ou importado da Sherlock.
app.post('/api/admin/contests', auth, (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.repoUrl) return res.status(400).json({ error: 'title and repoUrl required' });
  const s = S.load();
  const c = {
    id: S.id('c'), platform: String(b.platform || 'code4rena').toLowerCase(), title: String(b.title).slice(0, 200),
    url: b.url || '', repoUrl: String(b.repoUrl).trim(), commit: (b.commit || '').trim() || null, branch: (b.branch || '').trim() || null,
    scopeText: b.scopeText || '', description: (b.description || '').slice(0, 4000), knownIssues: (b.knownIssues || '').slice(0, 4000),
    startsAt: b.startsAt ? Number(b.startsAt) : null, endsAt: b.endsAt ? Number(b.endsAt) : null, prizePool: b.prizePool || null,
    status: 'queued', createdAt: Date.now(), resultNote: null,
  };
  s.contests.push(c);
  S.log(`contest added: ${c.title} (${c.platform})`, { contestId: c.id });
  S.save(true);
  res.json(c);
});

app.patch('/api/admin/contests/:id', auth, (req, res) => {
  const c = S.contest(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  for (const k of ['title', 'url', 'scopeText', 'description', 'knownIssues', 'prizePool', 'resultNote', 'commit', 'branch', 'platform']) if (k in b) c[k] = b[k];
  for (const k of ['startsAt', 'endsAt']) if (k in b) c[k] = b[k] ? Number(b[k]) : null;
  if (b.status && ['queued', 'submitted', 'judging', 'results', 'paid', 'stopped'].includes(b.status) && c.status !== 'running') {
    c.status = b.status;
    S.log(`${c.title}: status ${b.status}`, { contestId: c.id });
  }
  S.save(true);
  res.json(c);
});

app.delete('/api/admin/contests/:id', auth, (req, res) => {
  const s = S.load();
  const c = S.contest(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  if (c.status === 'running') return res.status(409).json({ error: 'stop it first' });
  s.contests = s.contests.filter((x) => x.id !== c.id);
  delete s.runs[c.id];
  S.save(true);
  res.json({ ok: true });
});

app.post('/api/admin/contests/:id/start', auth, async (req, res) => {
  try { await engine.start(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/admin/contests/:id/pause', auth, (req, res) => { engine.pause(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/contests/:id/stop', auth, (req, res) => { engine.stop(req.params.id); res.json({ ok: true }); });

// Findings: marcar como enviado (o envio e manual, pela plataforma) e o resultado.
app.patch('/api/admin/findings/:cid/:fid', auth, (req, res) => {
  const r = S.load().runs[req.params.cid];
  const f = r?.findings.find((x) => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if ('submitted' in b) f.submitted = !!b.submitted;
  if ('outcome' in b) f.outcome = b.outcome ? String(b.outcome).slice(0, 300) : null;
  S.save(true);
  res.json(f);
});

// Livro-caixa: premio recebido e o que foi feito com ele.
app.patch('/api/admin/ledger/split', auth, (req, res) => {
  const b = req.body || {};
  const split = { compute: Number(b.compute), burn: Number(b.burn), salary: Number(b.salary) };
  if (Object.values(split).some((v) => !Number.isFinite(v) || v < 0) || Math.round(split.compute + split.burn + split.salary) !== 100) return res.status(400).json({ error: 'split must add up to 100' });
  S.load().ledger.split = split;
  S.save(true);
  res.json(split);
});
app.post('/api/admin/ledger', auth, (req, res) => {
  const b = req.body || {};
  const usd = Number(b.prizeUsd);
  if (!Number.isFinite(usd) || usd <= 0) return res.status(400).json({ error: 'prizeUsd' });
  const s = S.load();
  const split = s.ledger.split;
  const e = {
    id: S.id('p'), contestId: b.contestId || null, contestTitle: b.contestTitle || '', prizeUsd: usd, receivedAt: b.receivedAt ? Number(b.receivedAt) : Date.now(),
    payoutTx: b.payoutTx || '', burnTx: b.burnTx || '', burnTokens: b.burnTokens || null,
    split: { ...split }, compute: usd * split.compute / 100, burn: usd * split.burn / 100, salary: usd * split.salary / 100, note: (b.note || '').slice(0, 500),
  };
  s.ledger.entries.push(e);
  S.log(`prize recorded: $${usd} from ${e.contestTitle || 'a contest'} -> $${e.burn.toFixed(2)} to buyback & burn, $${e.compute.toFixed(2)} to compute, $${e.salary.toFixed(2)} salary`, { contestId: e.contestId, kind: 'ok' });
  S.save(true);
  res.json(e);
});
app.patch('/api/admin/ledger/:id', auth, (req, res) => {
  const e = S.load().ledger.entries.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  for (const k of ['payoutTx', 'burnTx', 'burnTokens', 'note']) if (k in req.body) e[k] = req.body[k];
  S.save(true);
  res.json(e);
});

// ------------------------------------------------------------------------ site
const pub = path.join(ROOT, 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: '1m' }));
app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.use((_req, res) => res.status(404).sendFile(path.join(pub, 'index.html')));

// -------------------------------------------------------------- espelho (push)
if (MIRROR.url && MIRROR.token) {
  setInterval(async () => {
    try {
      await fetch(`${MIRROR.url.replace(/\/$/, '')}/api/mirror`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mirror-token': MIRROR.token }, body: JSON.stringify(S.publicView()), signal: AbortSignal.timeout(10_000) });
    } catch (e) { console.error('[mirror]', e.message); }
  }, MIRROR.intervalMs).unref();
}

if (process.env.NODE_ENV !== 'test' && !process.env.WARDEN_NO_LISTEN) {
  app.listen(PORT, () => {
    console.log(`[warden] ${AGENT.name} v${VERSION} on ${PUBLIC_URL} (port ${PORT}); model ${MODEL.main}; admin token ${ADMIN.slice(0, 6)}...`);
    engine.resumeOnBoot();
  });
}

export default app;
