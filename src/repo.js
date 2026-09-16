// Repositorio do contest: clone, checkout do commit, submodulos, escopo.
// O escopo vem (nesta ordem) do texto colado no painel, de scope.txt no repo,
// ou de todo .sol fora de test/script/lib/node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WORK_DIR, TOOLS, LIMITS } from './config.js';

export function sh(cmd, args, { cwd, timeoutMs = 600_000, env = {}, onProgress = null } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let out = '', err = '', lastProgress = 0;
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 4_000_000) out = out.slice(-2_000_000); });
    p.stderr.on('data', (d) => {
      err += d; if (err.length > 2_000_000) err = err.slice(-1_000_000);
      // git --progress escreve "Receiving objects: 45% ..." separado por \r; uma linha a cada 8 s no log
      if (onProgress && Date.now() - lastProgress > 8000) {
        const line = String(d).split(/[\r\n]/).filter((l) => /objects|Cloning into|Submodule/.test(l)).pop();
        if (line) { lastProgress = Date.now(); onProgress(line.trim()); }
      }
    });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + '\n' + e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

export function workDir(contestId) { return path.join(WORK_DIR, contestId); }

// Clona (ou reaproveita) o repo. `repoUrl` pode ser uma pasta local (fixture/prova).
export async function prepare(contest, onLog = () => {}) {
  const dir = workDir(contest.id);
  const src = contest.repoUrl.trim();
  const isLocal = fs.existsSync(src) && fs.statSync(src).isDirectory();
  if (fs.existsSync(path.join(dir, '.warden-ready'))) { onLog(`repo already prepared at ${dir}`); return dir; }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (isLocal) {
    onLog(`copying local repo ${src}`);
    fs.cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](out|cache|node_modules|\.git)$/.test(p) });
  } else {
    onLog(`cloning ${src}`);
    const args = contest.commit ? ['clone', '--progress', '--filter=blob:none', src, dir] : ['clone', '--progress', '--depth', '1', src, dir];
    if (contest.branch && !contest.commit) args.splice(1, 0, '--branch', contest.branch);
    let r = await sh(TOOLS.git, args, { timeoutMs: LIMITS.cloneTimeoutMs, onProgress: onLog });
    if (r.code !== 0) throw new Error(`git clone failed: ${r.err.slice(-500)}`);
    if (contest.commit) {
      r = await sh(TOOLS.git, ['checkout', '--quiet', contest.commit], { cwd: dir, timeoutMs: LIMITS.cloneTimeoutMs });
      if (r.code !== 0) throw new Error(`git checkout ${contest.commit} failed: ${r.err.slice(-500)}`);
    }
    onLog('fetching submodules');
    await sh(TOOLS.git, ['submodule', 'update', '--init', '--recursive', '--depth', '1', '--progress'], { cwd: dir, timeoutMs: LIMITS.cloneTimeoutMs, onProgress: onLog });
  }
  fs.writeFileSync(path.join(dir, '.warden-ready'), new Date().toISOString());
  return dir;
}

export function listSol(dir) {
  const out = [];
  const skip = /(^|[\\/])(test|tests|script|scripts|lib|node_modules|out|cache|mocks?|\.git)([\\/]|$)/i;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (skip.test(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sol')) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

// Escopo: lista de caminhos relativos (com barra normal). Aceita o texto do painel
// (um por linha, tolera "- ", prefixos de URL do GitHub e colunas de nSLOC).
export function parseScopeText(text, dir) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const paths = [];
  for (let l of lines) {
    l = l.replace(/^[-*|\s]+/, '').replace(/\s*\|.*$/, '').replace(/\s+\d+\s*$/, '').trim();
    const gh = l.match(/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)/);
    if (gh) l = gh[1];
    l = l.replace(/^\.?\//, '');
    if (!l.endsWith('.sol')) continue;
    if (fs.existsSync(path.join(dir, l))) paths.push(l);
    else {
      // tenta achar pelo sufixo (escopo escrito sem a pasta raiz)
      const all = listSolAll(dir);
      const hit = all.find((p) => p.endsWith('/' + l) || p === l);
      if (hit) paths.push(hit);
    }
  }
  return [...new Set(paths)];
}

function listSolAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/^(node_modules|\.git|out|cache)$/.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.sol')) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

export function resolveScope(contest, dir) {
  let files = [];
  if (contest.scopeText) files = parseScopeText(contest.scopeText, dir);
  if (!files.length) {
    for (const cand of ['scope.txt', 'SCOPE.txt', 'scope.md']) {
      const f = path.join(dir, cand);
      if (fs.existsSync(f)) { files = parseScopeText(fs.readFileSync(f, 'utf8'), dir); if (files.length) break; }
    }
  }
  if (!files.length) files = listSol(dir);
  return files.map((p) => ({ path: p, lines: fs.readFileSync(path.join(dir, p), 'utf8').split('\n').length, status: 'pending' }));
}

// Codigo do escopo concatenado com cabecalho por arquivo (o que o modelo le).
export function bundle(dir, files) {
  let total = 0;
  const parts = [];
  for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f.path), 'utf8');
    total += code.length;
    if (total > LIMITS.maxScopeChars) { parts.push(`\n// ===== ${f.path} (omitted: scope too large) =====\n`); continue; }
    parts.push(`\n// ===== FILE: ${f.path} =====\n${code}`);
  }
  return parts.join('\n');
}

// Um teste existente do repo, como exemplo de setup (imports, remappings, fixtures).
export function sampleTest(dir) {
  const cands = [];
  const walk = (d, depth) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.t\.sol$/.test(e.name)) cands.push(p);
    }
  };
  walk(path.join(dir, 'test'), 0);
  walk(path.join(dir, 'tests'), 0);
  cands.sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  const pick = cands.find((p) => fs.statSync(p).size > 800) || cands[0];
  if (!pick) return null;
  return { path: path.relative(dir, pick).split(path.sep).join('/'), code: fs.readFileSync(pick, 'utf8').slice(0, 12000) };
}

export function readmeHead(dir) {
  for (const n of ['README.md', 'readme.md', 'README']) {
    const f = path.join(dir, n);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').slice(0, 8000);
  }
  return '';
}

export function foundryConfig(dir) {
  const f = path.join(dir, 'foundry.toml');
  const cfg = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, 3000) : '';
  const r = path.join(dir, 'remappings.txt');
  const remap = fs.existsSync(r) ? fs.readFileSync(r, 'utf8').slice(0, 2000) : '';
  return { hasFoundry: !!cfg, config: cfg, remappings: remap };
}
