// Configuracao do Warden: tudo vem do ambiente, com padrao seguro.
// O motor (clone, forge, Claude) roda na maquina do Michel; o site pode rodar
// no Railway recebendo o estado publico pelo espelho (MIRROR_URL).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const str = (k, d = '') => (process.env[k] ?? d).toString().trim() || d;
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d; };
const bool = (k, d = false) => { const v = str(k, ''); return v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()); };

export const APP_NAME = 'Warden';
export const VERSION = '0.1.0';

export const PORT = num('PORT', 8441);
export const PUBLIC_URL = str('PUBLIC_URL', `http://localhost:${PORT}`);
export const CANONICAL_HOST = str('CANONICAL_HOST', '') || null;
export const DATA_DIR = path.resolve(ROOT, str('DATA_DIR', 'data'));
export const WORK_DIR = path.resolve(ROOT, str('WORK_DIR', 'work'));

// Identidade do agente (o site fala em ingles; o nome e o ticker sao do Michel).
export const AGENT = {
  name: str('AGENT_NAME', 'Warden'),
  handle: str('AGENT_HANDLE', 'warden'),          // handle nas plataformas de contest
  symbol: str('TOKEN_SYMBOL', 'WARDEN'),
  tokenAddress: str('TOKEN_ADDRESS', ''),          // CA na pons depois do lancamento
  tokenUrl: str('TOKEN_URL', ''),
  x: str('LINK_X', ''),
  telegram: str('LINK_TELEGRAM', ''),
};

// Modelo. Padrao Opus 5; em recusa (classificador de seguranca) cai para o FALLBACK.
export const MODEL = {
  main: str('AGENT_MODEL', 'claude-opus-5'),
  fallback: str('FALLBACK_MODEL', 'claude-opus-4-8'),
  effort: str('AGENT_EFFORT', 'high'),
  maxTokensRead: num('MAX_TOKENS_READ', 64000),
  maxTokensWrite: num('MAX_TOKENS_WRITE', 32000),
};

// Precos por milhao de tokens (USD) para a conta de custo. Atualizar quando mudar.
export const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Limites do trabalho: o que segura o custo.
export const LIMITS = {
  maxUsdPerContest: num('MAX_USD_PER_CONTEST', 150),
  maxHypothesesPerFile: num('MAX_HYPOTHESES_PER_FILE', 6),
  maxPocIterations: num('MAX_POC_ITERATIONS', 4),
  maxScopeChars: num('MAX_SCOPE_CHARS', 1_500_000),   // ~375k tokens: cabe no contexto de 1M
  forgeTimeoutMs: num('FORGE_TIMEOUT_MS', 600_000),
  cloneTimeoutMs: num('CLONE_TIMEOUT_MS', 600_000),
};

// Ferramentas locais. O forge vem do zip oficial em tools/foundry.
const localForge = path.join(ROOT, 'tools', 'foundry', process.platform === 'win32' ? 'forge.exe' : 'forge');
export const TOOLS = {
  forge: str('FORGE_BIN', fs.existsSync(localForge) ? localForge : 'forge'),
  git: str('GIT_BIN', 'git'),
  slither: str('SLITHER_BIN', path.join(ROOT, 'tools', 'venv', 'Scripts', 'slither.exe')),
  slitherEnabled: bool('SLITHER', false),
};

// Rateio do premio (porcentagens; a soma tem que dar 100). O Michel muda no painel.
export const SPLIT_DEFAULT = {
  compute: num('SPLIT_COMPUTE', 40),
  burn: num('SPLIT_BURN', 60),
  salary: num('SPLIT_SALARY', 0),
};

// Espelho: o motor local empurra o estado publico para o site no ar.
export const MIRROR = {
  url: str('MIRROR_URL', ''),
  token: str('MIRROR_TOKEN', ''),
  intervalMs: num('MIRROR_INTERVAL_MS', 5000),
};

export const ADMIN_TOKEN_ENV = str('ADMIN_TOKEN', '');
export const TICK_MS = num('TICK_MS', 3000);
