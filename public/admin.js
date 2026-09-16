// Painel do criador: cadastro de contests, start/pause/stop, findings prontos
// para copiar e enviar, status do contest, livro-caixa. Token fica no localStorage.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const dt = (t) => t ? new Date(t).toLocaleString('en-US') : '—';
let token = localStorage.getItem('warden_admin') || '';
$('token').value = token;
$('save').onclick = () => { token = $('token').value.trim(); localStorage.setItem('warden_admin', token); refresh(); };

function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(() => (t.style.display = 'none'), 2500); }
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { toast(j.error || res.status); throw new Error(j.error || res.status); }
  return j;
}

let state = null;
async function refresh() {
  if (!token) return;
  try { state = await api('/api/admin/state'); } catch { return; }
  const e = state.engine, t = state.tools;
  $('engine').innerHTML = `status <b>${esc(e.status)}</b>${e.current ? ' on ' + esc(state.contests.find((c) => c.id === e.current)?.title || e.current) : ''} · model ${esc(state.agent.model)} · budget $${state.limits.maxUsdPerContest}/contest · forge ${t.forge ? '<span class="ok">' + esc(t.forge) + '</span>' : '<span class="error">missing</span>'} · claude ${t.claude ? 'key ok' : '<span class="error">no key</span>'} · total spent ${usd(state.spend.usd)}${e.error ? ` · <span class="error">${esc(e.error)}</span>` : ''}`;
  renderContests();
  renderLedger();
}

const STATUSES = ['queued', 'submitted', 'judging', 'results', 'paid', 'stopped'];
function renderContests() {
  const box = $('contests');
  box.innerHTML = [...state.contests].reverse().map((c) => {
    const r = state.runs[c.id];
    const running = c.status === 'running';
    const canStart = ['queued', 'paused', 'stopped', 'error', 'budget', 'done', 'ready'].includes(c.status) && state.engine.status !== 'running';
    return `<div class="card" style="margin-bottom:12px">
      <h3>${esc(c.title)} <span class="st ${esc(c.status)}">${esc(c.status)}</span></h3>
      <div class="meta">${esc(c.platform)} · ${esc(c.repoUrl)}${c.commit ? ' @ ' + esc(c.commit.slice(0, 10)) : ''} · ends ${dt(c.endsAt)} · ${esc(c.prizePool || '')}</div>
      ${r ? `<div class="meta" style="margin-top:6px">phase ${esc(r.phase)} · ${r.files.filter((f) => f.status === 'read').length}/${r.files.length} files · ${r.stats.hypotheses} hypotheses · ${r.stats.tests} tests (${r.stats.testsPassed} pass) · ${r.stats.confirmed} confirmed · ${usd(r.stats.usd)}${r.error ? ` · <span class="error">${esc(r.error)}</span>` : ''}</div>` : ''}
      <div class="actions" style="margin-top:10px">
        ${canStart ? `<button class="primary" data-act="start" data-id="${c.id}">${r && r.startedAt ? 'resume' : 'start'}</button>` : ''}
        ${running ? `<button data-act="pause" data-id="${c.id}">pause</button><button class="danger" data-act="stop" data-id="${c.id}">stop</button>` : ''}
        <select data-status="${c.id}" ${running ? 'disabled' : ''}>${(STATUSES.includes(c.status) ? STATUSES : [c.status, ...STATUSES]).map((s) => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <input data-note="${c.id}" placeholder="result note (public)" value="${esc(c.resultNote || '')}" style="min-width:220px">
        <button data-act="note" data-id="${c.id}">save note</button>
        ${!running ? `<button class="danger" data-act="del" data-id="${c.id}">delete</button>` : ''}
      </div>
      ${r && r.findings.length ? `<h2 style="margin-top:16px">Findings to submit (${esc(c.platform)} format)</h2>` + r.findings.filter((f) => !f.duplicateOf).map((f) => `<details><summary><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span> ${esc(f.id)} · ${esc(f.title)}${f.mergedIds?.length ? ' (+ ' + esc(f.mergedIds.join(', ')) + ' merged)' : ''} · <label><input type="checkbox" data-sub="${c.id}/${f.id}" ${f.submitted ? 'checked' : ''}> submitted</label> <input data-outcome="${c.id}/${f.id}" placeholder="outcome (valid / dup / invalid)" value="${esc(f.outcome || '')}"> <button data-act="outcome" data-id="${c.id}/${f.id}">save</button> <button data-copy="${c.id}/${f.id}">copy report</button> <button data-copytest="${c.id}/${f.id}">copy test</button></summary><pre>${esc(f.report || '')}</pre></details>`).join('') : ''}
      ${r && r.hypotheses.length ? `<details><summary class="note">${r.hypotheses.length} hypotheses (private until results)</summary><pre>${r.hypotheses.map((h) => `[${h.severity}] ${h.id} ${h.title}\n   ${h.file} / ${h.fn} · ${h.status}${h.verdict ? ' · ' + h.verdict : ''}`).join('\n')}</pre></details>` : ''}
    </div>`;
  }).join('') || '<div class="card empty">no contest yet</div>';

  box.querySelectorAll('button[data-act]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.id, act = b.dataset.act;
    if (act === 'start') await api(`/api/admin/contests/${id}/start`, 'POST');
    if (act === 'pause') await api(`/api/admin/contests/${id}/pause`, 'POST');
    if (act === 'stop') await api(`/api/admin/contests/${id}/stop`, 'POST');
    if (act === 'del' && confirm('delete this contest and its run?')) await api(`/api/admin/contests/${id}`, 'DELETE');
    if (act === 'note') await api(`/api/admin/contests/${id}`, 'PATCH', { resultNote: box.querySelector(`[data-note="${id}"]`).value });
    if (act === 'outcome') { const [cid, fid] = id.split('/'); await api(`/api/admin/findings/${cid}/${fid}`, 'PATCH', { outcome: box.querySelector(`[data-outcome="${id}"]`).value }); }
    toast('ok'); refresh();
  });
  box.querySelectorAll('select[data-status]').forEach((s) => s.onchange = async () => { await api(`/api/admin/contests/${s.dataset.status}`, 'PATCH', { status: s.value }); toast('status ' + s.value); refresh(); });
  box.querySelectorAll('input[data-sub]').forEach((i) => i.onchange = async () => { const [cid, fid] = i.dataset.sub.split('/'); await api(`/api/admin/findings/${cid}/${fid}`, 'PATCH', { submitted: i.checked }); toast(i.checked ? 'marked submitted' : 'unmarked'); });
  box.querySelectorAll('button[data-copy]').forEach((b) => b.onclick = (ev) => { ev.preventDefault(); const [cid, fid] = b.dataset.copy.split('/'); navigator.clipboard.writeText(state.runs[cid].findings.find((f) => f.id === fid).report || ''); toast('report copied'); });
  box.querySelectorAll('button[data-copytest]').forEach((b) => b.onclick = (ev) => { ev.preventDefault(); const [cid, fid] = b.dataset.copytest.split('/'); navigator.clipboard.writeText(state.runs[cid].findings.find((f) => f.id === fid).test?.code || ''); toast('test copied'); });
}

function renderLedger() {
  const L = state.ledger;
  const f = $('split'); f.compute.value = L.split.compute; f.burn.value = L.split.burn; f.salary.value = L.split.salary;
  $('prizeContest').innerHTML = '<option value="">—</option>' + state.contests.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
  $('ledger').innerHTML = [...L.entries].reverse().map((e) => `<tr><td>${new Date(e.receivedAt).toISOString().slice(0, 10)}</td><td>${esc(e.contestTitle)}</td><td>${usd(e.prizeUsd)}</td><td>${usd(e.compute)}</td><td>${usd(e.burn)}</td><td>${usd(e.salary)}</td><td>${e.payoutTx ? `<a href="${esc(e.payoutTx)}" target="_blank">payout</a> ` : ''}${e.burnTx ? `<a href="${esc(e.burnTx)}" target="_blank">burn</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">nothing recorded</td></tr>';
}

$('add').onsubmit = async (ev) => {
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(ev.target));
  if (fd.endsAt) fd.endsAt = new Date(fd.endsAt).getTime();
  await api('/api/admin/contests', 'POST', fd);
  ev.target.reset(); toast('added'); refresh();
};
$('split').onsubmit = async (ev) => { ev.preventDefault(); const fd = Object.fromEntries(new FormData(ev.target)); await api('/api/admin/ledger/split', 'PATCH', fd); toast('split saved'); refresh(); };
$('prize').onsubmit = async (ev) => {
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(ev.target));
  fd.contestTitle = state.contests.find((c) => c.id === fd.contestId)?.title || '';
  await api('/api/admin/ledger', 'POST', fd); ev.target.reset(); toast('prize recorded'); refresh();
};
$('loadSherlock').onclick = async () => {
  $('sherlock').innerHTML = '<tr><td colspan="6" class="empty">loading…</td></tr>';
  const { contests } = await api('/api/admin/sherlock');
  $('sherlock').innerHTML = contests.map((c) => `<tr><td><a href="${esc(c.url)}" target="_blank">${esc(c.title)}</a><div class="meta">${esc(c.short)}</div></td><td>${esc(c.prizePool || '')}</td><td>${dt(c.startsAt)}</td><td>${dt(c.endsAt)}</td><td>${esc(c.status)}</td><td><button data-import="${c.sherlockId}">import</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">no open contest</td></tr>';
  $('sherlock').querySelectorAll('button[data-import]').forEach((b) => b.onclick = async () => {
    const d = await api(`/api/admin/sherlock/${b.dataset.import}`);
    const repo = d.templateRepo || (d.scopeRepos[0]?.repo ? 'https://github.com/' + d.scopeRepos[0].repo : '');
    const f = $('add');
    f.platform.value = 'sherlock'; f.title.value = d.title; f.url.value = d.url; f.repoUrl.value = repo;
    f.commit.value = d.templateRepo ? '' : (d.scopeRepos[0]?.commit || ''); f.prizePool.value = d.prizePool || '';
    f.endsAt.value = d.endsAt ? new Date(d.endsAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    f.description.value = (d.description || '').slice(0, 4000);
    f.scopeText.value = d.scopeRepos.map((s) => (s.files || []).join('\n')).join('\n');
    toast('form filled: check the repo, then add'); f.scrollIntoView({ behavior: 'smooth' });
  });
};
refresh();
setInterval(refresh, 5000);
