// Site publico do Warden: le /api/state a cada 3 s e desenha. Sem framework.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const hhmmss = (t) => new Date(t).toISOString().slice(11, 19);
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's'; const m = Math.round(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; };
const left = (endsAt) => { if (!endsAt) return ''; const d = endsAt - Date.now(); return d > 0 ? 'ends in ' + ago(d) : 'ended ' + ago(-d) + ' ago'; };
const PLATFORM = { code4rena: 'Code4rena', sherlock: 'Sherlock', cantina: 'Cantina', codehawks: 'CodeHawks', local: 'local' };
const STATUS = { queued: 'queued', running: 'working', paused: 'paused', stopped: 'stopped', budget: 'budget cap', error: 'error', done: 'no finding', ready: 'findings ready', submitted: 'submitted', judging: 'judging', results: 'results out', paid: 'paid' };

let lastLogKey = '';

async function tick() {
  let s;
  try { s = await (await fetch('/api/state', { cache: 'no-store' })).json(); }
  catch { return; }
  const a = s.agent || {};
  $('agentName').textContent = a.name || 'Warden';
  $('sym').textContent = '$' + (a.symbol || 'WARDEN');
  $('model').textContent = a.model || '';
  $('budget').textContent = a.maxUsdPerContest ?? '';
  $('ver').textContent = 'warden v' + (a.version || '');
  $('updated').textContent = 'updated ' + hhmmss(s.generatedAt || Date.now()) + ' UTC';
  $('mirror').textContent = s.mirrored ? 'engine runs on the creator machine, mirrored here' : '';
  if (a.tokenUrl || a.tokenAddress) { const l = $('tokenLink'); l.hidden = false; l.href = a.tokenUrl || '#'; l.textContent = '$' + (a.symbol || 'WARDEN') + (a.tokenAddress ? ' ' + a.tokenAddress.slice(0, 6) + '…' + a.tokenAddress.slice(-4) : ''); }
  if (a.x) { $('xLink').hidden = false; $('xLink').href = a.x; }

  const working = s.engine && s.engine.status === 'running';
  $('pill').classList.toggle('on', !!working);
  $('pillText').textContent = working ? 'working' : 'idle';
  $('termState').textContent = working ? 'running' : 'idle';
  $('termState').classList.toggle('on', !!working);

  // contest atual: o que roda, senao o ultimo com run
  const cur = s.contests.find((c) => c.id === s.engine?.current) || [...s.contests].reverse().find((c) => c.run) || null;
  $('nowEmpty').hidden = !!cur; $('nowBody').hidden = !cur;
  const st = cur?.run?.stats || {};
  if (cur) {
    $('nowTitle').textContent = cur.title;
    $('nowPlatform').textContent = PLATFORM[cur.platform] || cur.platform;
    $('nowPrize').textContent = cur.prizePool ? 'prize pool ' + cur.prizePool : '';
    $('nowEnds').textContent = left(cur.endsAt);
    $('nowRepo').href = cur.repoUrl || '#'; $('nowRepo').hidden = !/^https?:/.test(cur.repoUrl || '');
    $('nowUrl').href = cur.url || '#'; $('nowUrl').hidden = !cur.url;
    const r = cur.run;
    const read = r.files.filter((f) => f.status === 'read').length;
    $('nowBar').style.width = (r.files.length ? Math.round(100 * read / r.files.length) : 0) + '%';
    $('nowPhase').textContent = 'phase: ' + (r.phase || '') + (STATUS[cur.status] && cur.status !== 'running' ? ' (' + STATUS[cur.status] + ')' : '');
    $('nowFile').textContent = r.currentFile ? (r.phase === 'prove' ? 'proving on ' : 'reading ') + r.currentFile : '';
    $('sFiles').textContent = read + '/' + r.files.length;
  } else { $('sFiles').textContent = '0'; }
  $('sLines').textContent = (st.linesRead || 0).toLocaleString('en-US');
  $('sHyp').textContent = st.hypotheses || 0;
  $('sTests').textContent = st.tests || 0;
  $('sPassed').textContent = st.testsPassed || 0;
  $('sConfirmed').textContent = st.confirmed || 0;
  $('sUsd').textContent = usd(st.usd || 0);

  // terminal
  const log = s.log || [];
  const key = log.length + ':' + (log[log.length - 1]?.t || 0);
  if (key !== lastLogKey) {
    lastLogKey = key;
    const term = $('term');
    term.innerHTML = log.map((l, i) => `<div class="l"><span class="t">${hhmmss(l.t)}</span><span class="${esc(l.kind || '')}${i === log.length - 1 && working ? ' cursor' : ''}">${esc(l.line)}</span></div>`).join('') || '<div class="l"><span class="t">--:--:--</span><span class="cursor">waiting for the first contest</span></div>';
    term.scrollTop = term.scrollHeight;
  }

  // contests
  const rows = [...s.contests].reverse();
  $('contests').innerHTML = rows.length ? rows.map((c) => {
    const r = c.run; const n = r ? r.findings.filter((f) => !f.duplicateOf).length : 0;
    return `<tr><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}<div class="meta">${esc(left(c.endsAt))}</div></td><td>${esc(PLATFORM[c.platform] || c.platform)}</td><td>${esc(c.prizePool || '—')}</td><td><span class="st ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span>${c.resultNote ? `<div class="meta">${esc(c.resultNote)}</div>` : ''}</td><td>${n}${r ? ` <span class="note">(${r.stats.hypotheses} hyp, ${r.stats.testsPassed} pass)</span>` : ''}</td><td>${r ? usd(r.stats.usd) : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">nothing yet</td></tr>';

  // relatorios abertos (so depois do resultado)
  const open = rows.filter((c) => ['results', 'paid'].includes(c.status) && c.run && (c.run.findings.length || c.run.hypotheses.length));
  $('reports').innerHTML = open.map((c) => `
    <h2>Report: ${esc(c.title)}</h2>
    ${c.run.findings.filter((f) => !f.duplicateOf).map((f) => `<details><summary><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span> ${esc(f.id)} · ${esc(f.title)} <span class="note">${f.mergedIds?.length ? '· includes ' + esc(f.mergedIds.join(', ')) : ''}${f.outcome ? ' · ' + esc(f.outcome) : ''}</span></summary><pre>${esc(f.report || '')}</pre></details>`).join('')}
    ${c.run.hypotheses.filter((h) => h.status !== 'confirmed').length ? `<details><summary class="note">${c.run.hypotheses.filter((h) => h.status !== 'confirmed').length} hypotheses that did not survive</summary><pre>${c.run.hypotheses.filter((h) => h.status !== 'confirmed').map((h) => `[${h.severity}] ${h.id} ${h.title} (${h.file}) -> ${h.status}${h.verdict ? ': ' + h.verdict : ''}`).join('\n')}</pre></details>` : ''}`).join('');

  // ledger
  const L = s.ledger || { split: { compute: 40, burn: 40, salary: 20 }, entries: [] };
  $('splitC').style.width = L.split.compute + '%'; $('splitB').style.width = L.split.burn + '%'; $('splitS').style.width = L.split.salary + '%';
  $('legC').textContent = L.split.compute + '%'; $('legB').textContent = L.split.burn + '%'; $('legS').textContent = L.split.salary + '%';
  $('legS').parentElement.hidden = !L.split.salary; $('splitS').hidden = !L.split.salary;
  const tot = (k) => L.entries.reduce((a, e) => a + (e[k] || 0), 0);
  $('lPrizes').textContent = usd(tot('prizeUsd')); $('lBurn').textContent = usd(tot('burn')); $('lCompute').textContent = usd(tot('compute'));
  $('ledger').innerHTML = L.entries.length ? [...L.entries].reverse().map((e) => `<tr><td>${esc(e.contestTitle || e.contestId || '')}<div class="meta">${new Date(e.receivedAt).toISOString().slice(0, 10)}</div></td><td>${usd(e.prizeUsd)}</td><td>${usd(e.burn)}${e.burnTokens ? `<div class="meta">${esc(e.burnTokens)} burned</div>` : ''}</td><td>${e.payoutTx ? `<a href="${esc(e.payoutTx)}" target="_blank" rel="noopener">payout</a> ` : ''}${e.burnTx ? `<a href="${esc(e.burnTx)}" target="_blank" rel="noopener">burn</a>` : ''}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">no prize yet</td></tr>';
}
tick();
setInterval(tick, 3000);
