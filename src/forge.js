// Foundry: build do repo e execucao de um teste de prova (PoC).
// Um teste que PASSA e a unica prova que o Warden aceita para um finding.
import fs from 'node:fs';
import path from 'node:path';
import { sh } from './repo.js';
import { TOOLS, LIMITS } from './config.js';

const env = { FOUNDRY_DISABLE_NIGHTLY_WARNING: '1', NO_COLOR: '1' };

export async function version() {
  const r = await sh(TOOLS.forge, ['--version'], { timeoutMs: 20_000, env });
  return r.code === 0 ? r.out.split('\n')[0].trim() : null;
}

export async function build(dir) {
  const r = await sh(TOOLS.forge, ['build', '--quiet'], { cwd: dir, timeoutMs: LIMITS.forgeTimeoutMs, env });
  return { ok: r.code === 0, out: (r.out + '\n' + r.err).trim().slice(-6000) };
}

// Grava o teste em test/warden/<name>.t.sol e roda so ele.
export async function runPoc(dir, name, code) {
  const rel = `test/warden/${name}.t.sol`;
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
  const r = await sh(TOOLS.forge, ['test', '--match-path', rel, '-vvv', '--json'], { cwd: dir, timeoutMs: LIMITS.forgeTimeoutMs, env });
  return { ...parse(r), file: rel };
}

// Le a saida do `forge test --json`. Erro de compilacao nao vem em JSON.
export function parse(r) {
  const text = (r.out || '').trim();
  const jsonStart = text.indexOf('{');
  let results = null;
  if (jsonStart >= 0) {
    try { results = JSON.parse(text.slice(jsonStart)); } catch {}
  }
  const tests = [];
  if (results && typeof results === 'object') {
    for (const [file, suite] of Object.entries(results)) {
      for (const [tname, t] of Object.entries(suite.test_results || {})) {
        tests.push({ file, name: tname, status: t.status, reason: t.reason || null, logs: (t.decoded_logs || []).slice(0, 40) });
      }
    }
  }
  const passed = tests.length > 0 && tests.every((t) => t.status === 'Success');
  const output = (r.out + '\n' + r.err).trim();
  return {
    passed, compiled: results !== null, tests,
    // o que volta para o modelo quando falha: o fim da saida, sem o JSON gigante
    feedback: passed ? '' : summarize(tests, output),
  };
}

function summarize(tests, output) {
  const parts = [];
  for (const t of tests) {
    if (t.status !== 'Success') parts.push(`${t.name}: ${t.status}${t.reason ? ' - ' + t.reason : ''}${t.logs.length ? '\nlogs:\n' + t.logs.join('\n') : ''}`);
  }
  if (!tests.length) {
    // erro de compilacao: fica so com as linhas de erro
    const lines = output.split('\n').filter((l) => /error|Error|-->|warning: unused|Compiler run failed/.test(l));
    parts.push((lines.length ? lines : output.split('\n').slice(-60)).join('\n'));
  }
  return parts.join('\n\n').slice(-8000);
}

export function removePoc(dir, name) {
  try { fs.rmSync(path.join(dir, 'test', 'warden', `${name}.t.sol`), { force: true }); } catch {}
}
