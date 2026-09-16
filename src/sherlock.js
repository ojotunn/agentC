// Sherlock tem API publica de contests. Code4rena, Cantina e CodeHawks nao tem
// (paginas dinamicas), entao esses entram pelo cadastro manual no painel.
const BASE = 'https://mainnet-contest.sherlock.xyz';
let cache = { at: 0, data: null };

export async function list() {
  if (Date.now() - cache.at < 5 * 60_000 && cache.data) return cache.data;
  // A API e paginada ({page, items, has_next}) e aceita ?status=; 301 contests em 15/09/2026, nenhum aberto.
  const all = [];
  for (const status of ['RUNNING', 'CREATED']) {
    const res = await fetch(`${BASE}/contests?status=${status}&per_page=50`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`sherlock ${res.status}`);
    const body = await res.json();
    all.push(...(Array.isArray(body) ? body : body.items || []));
  }
  const keep = all.filter((c) => !c.private && ['CREATED', 'RUNNING'].includes(c.status));
  const data = keep.map((c) => ({
    sherlockId: c.id, title: c.title, status: c.status, startsAt: c.starts_at * 1000, endsAt: c.ends_at * 1000,
    prizePool: c.prize_pool ? `${Number(c.prize_pool).toLocaleString('en-US')} ${c.token || 'USDC'}` : null,
    short: c.short_description || '', url: `https://audits.sherlock.xyz/contests/${c.id}`,
  })).sort((a, b) => a.endsAt - b.endsAt);
  cache = { at: Date.now(), data };
  return data;
}

export async function detail(sherlockId) {
  const res = await fetch(`${BASE}/contests/${sherlockId}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`sherlock ${res.status}`);
  const c = await res.json();
  const scope = Array.isArray(c.scope) ? c.scope : [];
  return {
    sherlockId: c.id, title: c.title, status: c.status, startsAt: c.starts_at * 1000, endsAt: c.ends_at * 1000,
    prizePool: c.prize_pool ? `${Number(c.prize_pool).toLocaleString('en-US')} ${c.token || 'USDC'}` : null,
    description: c.description || c.short_description || '',
    templateRepo: c.template_repo_name ? `https://github.com/${c.template_repo_name}` : null,
    scopeRepos: scope.map((s) => ({ repo: s.repo_name || s.name || null, branch: s.branch_name || null, commit: s.commit_hash || null, files: s.files || null })),
    requiresKyc: !!c.requires_kyc, nsloc: c.nsloc || null, url: `https://audits.sherlock.xyz/contests/${c.id}`,
  };
}
