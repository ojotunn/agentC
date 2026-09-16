// Estado do Warden: um JSON so, em DATA_DIR/state.json, gravado de forma atomica.
// Tudo que o motor faz passa por aqui; o site le uma versao publica (redigida).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, SPLIT_DEFAULT, ADMIN_TOKEN_ENV } from './config.js';

const FILE = path.join(DATA_DIR, 'state.json');
const LOG_MAX = 400;

function empty() {
  return {
    version: 1,
    contests: [],          // cadastro dos contests (manual ou Sherlock)
    runs: {},              // por contest: progresso, hipoteses, findings
    ledger: { split: { ...SPLIT_DEFAULT }, entries: [] },
    log: [],               // log publico (redigido na leitura)
    engine: { status: 'idle', current: null, since: null, error: null },
    spend: { usd: 0, inputTokens: 0, outputTokens: 0 },
  };
}

let state = null;

export function load() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { ...empty(), ...state };
    state.ledger = { ...empty().ledger, ...(state.ledger || {}) };
  } catch {
    state = empty();
  }
  return state;
}

let saveTimer = null;
export function save(now = false) {
  const s = load();
  const write = () => {
    saveTimer = null;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, FILE);
  };
  if (now) { if (saveTimer) clearTimeout(saveTimer); return write(); }
  if (!saveTimer) saveTimer = setTimeout(write, 250);
}

// Token do painel: vem do env ou e gerado uma vez e gravado em DATA_DIR/admin.token.
export function adminToken() {
  if (ADMIN_TOKEN_ENV) return ADMIN_TOKEN_ENV;
  const f = path.join(DATA_DIR, 'admin.token');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t);
  console.log(`[warden] ADMIN_TOKEN generated at ${f}`);
  return t;
}

export const id = (p = 'c') => p + '_' + crypto.randomBytes(5).toString('hex');

// Log: `secret` marca linhas que o publico so ve depois do resultado do contest.
export function log(line, { contestId = null, secret = false, kind = 'info' } = {}) {
  const s = load();
  s.log.push({ t: Date.now(), line: String(line).slice(0, 600), contestId, secret, kind });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  console.log(`[warden]${secret ? ' [secret]' : ''} ${line}`);
  save();
}

export function contest(cid) { return load().contests.find((c) => c.id === cid) || null; }
export function run(cid) {
  const s = load();
  if (!s.runs[cid]) {
    s.runs[cid] = {
      startedAt: null, finishedAt: null, phase: 'queued', currentFile: null,
      files: [], stats: { files: 0, linesRead: 0, hypotheses: 0, tests: 0, testsPassed: 0, testsFailed: 0, confirmed: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      hypotheses: [], findings: [], error: null,
    };
  }
  return s.runs[cid];
}

// O que o mundo ve. Conteudo das hipoteses/findings so sai com status 'results' ou 'paid'.
export function publicView() {
  const s = load();
  const open = (c) => ['results', 'paid'].includes(c.status);
  const contests = s.contests.map((c) => {
    const r = s.runs[c.id] || null;
    const visible = open(c);
    return {
      id: c.id, platform: c.platform, title: c.title, url: c.url, repoUrl: c.repoUrl, commit: c.commit,
      startsAt: c.startsAt, endsAt: c.endsAt, prizePool: c.prizePool, status: c.status, createdAt: c.createdAt,
      resultNote: c.resultNote || null,
      run: r ? {
        phase: r.phase, startedAt: r.startedAt, finishedAt: r.finishedAt, currentFile: r.currentFile,
        files: r.files.map((f) => ({ path: f.path, lines: f.lines, status: f.status })),
        stats: r.stats,
        hypotheses: visible ? r.hypotheses.map(pubHypothesis) : r.hypotheses.map((h) => ({ id: h.id, status: h.status, severity: h.severity, file: h.file })),
        findings: visible ? r.findings.map(pubFinding) : r.findings.map((f) => ({ id: f.id, severity: f.severity, submitted: !!f.submitted, duplicateOf: f.duplicateOf || null })),
      } : null,
    };
  });
  const log = s.log.filter((l) => !l.secret || (l.contestId && open(contest(l.contestId)))).slice(-200);
  return { agent: undefined, contests, log, engine: s.engine, spend: s.spend, ledger: s.ledger, generatedAt: Date.now() };
}

function pubHypothesis(h) {
  return { id: h.id, title: h.title, severity: h.severity, file: h.file, fn: h.fn, status: h.status, description: h.description, attackPath: h.attackPath, iterations: h.iterations, verdict: h.verdict || null };
}
function pubFinding(f) {
  return { id: f.id, title: f.title, severity: f.severity, file: f.file, report: f.report, test: f.test, submitted: !!f.submitted, outcome: f.outcome || null, duplicateOf: f.duplicateOf || null, mergedIds: f.mergedIds || [] };
}

// Substitui o estado inteiro (usado pelo site no ar quando recebe o espelho).
let mirrored = null;
export function setMirrored(v) { mirrored = v; }
export function getMirrored() { return mirrored; }
