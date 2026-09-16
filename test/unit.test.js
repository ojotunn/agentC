// Testes sem modelo: escopo, leitura do forge --json, redacao da vista publica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.WORK_DIR = path.join(tmp, 'work');
process.env.WARDEN_NO_LISTEN = '1';
process.env.ADMIN_TOKEN = 'test-token';

const { ROOT } = await import('../src/config.js');
const repo = await import('../src/repo.js');
const forge = await import('../src/forge.js');
const S = await import('../src/state.js');

const fixture = path.join(ROOT, 'fixtures', 'vault');

test('scope: default lists src .sol only, skipping test and lib', () => {
  const files = repo.listSol(fixture);
  assert.deepEqual(files, ['src/Vault.sol']);
});

test('scope: parses pasted text with bullets, github urls and nSLOC columns', () => {
  const text = `- src/Vault.sol\nhttps://github.com/x/y/blob/main/src/Vault.sol\n| src/Vault.sol | 55 |\nsrc/Missing.sol\nREADME.md\nVault.sol 55`;
  assert.deepEqual(repo.parseScopeText(text, fixture), ['src/Vault.sol']);
});

test('forge: parses --json output and compile errors', () => {
  const out = JSON.stringify({ 'test/warden/W1.t.sol:W1Test': { test_results: { 'test_W1_exploit()': { status: 'Success', reason: null, decoded_logs: [] } } } });
  const ok = forge.parse({ code: 0, out, err: '' });
  assert.equal(ok.passed, true); assert.equal(ok.tests.length, 1);
  const fail = forge.parse({ code: 1, out: JSON.stringify({ 'a': { test_results: { 't()': { status: 'Failure', reason: 'assertion failed', decoded_logs: ['x'] } } } }), err: '' });
  assert.equal(fail.passed, false); assert.match(fail.feedback, /assertion failed/);
  const comp = forge.parse({ code: 1, out: '', err: 'Error: Compiler run failed\n  --> test/warden/W1.t.sol:3:1\n error: unknown type' });
  assert.equal(comp.compiled, false); assert.match(comp.feedback, /Compiler run failed/);
});

test('public view hides hypotheses and secret log until results', () => {
  const s = S.load();
  const c = { id: 'c_test', platform: 'local', title: 'T', repoUrl: '.', status: 'running', createdAt: 1 };
  s.contests.push(c);
  const r = S.run(c.id);
  r.hypotheses.push({ id: 'W1', title: 'SECRET TITLE', severity: 'High', file: 'src/Vault.sol', fn: 'withdraw', description: 'd', attackPath: 'a', status: 'open' });
  r.findings.push({ id: 'W1', title: 'SECRET TITLE', severity: 'High', report: 'SECRET REPORT', test: { code: 'x' } });
  S.log('public line', { contestId: c.id });
  S.log('SECRET LINE', { contestId: c.id, secret: true });
  let pv = JSON.stringify(S.publicView());
  assert.ok(!pv.includes('SECRET'), 'nothing secret before results');
  assert.ok(pv.includes('public line'));
  c.status = 'results';
  pv = JSON.stringify(S.publicView());
  assert.ok(pv.includes('SECRET TITLE') && pv.includes('SECRET REPORT') && pv.includes('SECRET LINE'), 'everything opens after results');
});

test('server: health, public state, admin auth, contest add and ledger split', async () => {
  const { default: app } = await import('../src/server.js');
  const srv = app.listen(0);
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const j = async (p, o = {}) => { const res = await fetch(base + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } }); return { status: res.status, body: await res.json() }; };
  assert.equal((await j('/api/health')).body.ok, true);
  assert.equal((await j('/api/state')).body.agent.name, 'Warden');
  assert.equal((await j('/api/admin/state')).status, 401);
  const H = { 'x-admin-token': 'test-token' };
  const add = await j('/api/admin/contests', { method: 'POST', headers: H, body: JSON.stringify({ platform: 'code4rena', title: 'X', repoUrl: 'https://example.com/r.git' }) });
  assert.equal(add.status, 200); assert.equal(add.body.status, 'queued');
  const bad = await j('/api/admin/ledger/split', { method: 'PATCH', headers: H, body: JSON.stringify({ compute: 50, burn: 50, salary: 50 }) });
  assert.equal(bad.status, 400);
  const good = await j('/api/admin/ledger/split', { method: 'PATCH', headers: H, body: JSON.stringify({ compute: 30, burn: 50, salary: 20 }) });
  assert.equal(good.status, 200);
  const prize = await j('/api/admin/ledger', { method: 'POST', headers: H, body: JSON.stringify({ prizeUsd: 1000, contestTitle: 'X' }) });
  assert.equal(prize.body.burn, 500); assert.equal(prize.body.compute, 300);
  const mirror = await j('/api/mirror', { method: 'POST', body: JSON.stringify({ contests: [] }) });
  assert.equal(mirror.status, 401);
  srv.close();
});
