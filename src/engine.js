// O motor do Warden: prepara o repo, le o escopo, levanta hipoteses, prova cada
// uma com um teste Foundry que executa o ataque, julga o teste e escreve o
// relatorio no formato da plataforma. So finding com PoC passando vira relatorio.
//
// Sigilo: durante o contest o publico ve contagens e o arquivo sendo lido;
// titulos, descricoes e testes ficam `secret` ate o status 'results'.
import { z } from 'zod';
import * as S from './state.js';
import * as claude from './claude.js';
import * as repo from './repo.js';
import * as forge from './forge.js';
import { AGENT, LIMITS, TOOLS } from './config.js';

const control = new Map(); // contestId -> 'pause' | 'stop'
let busy = null;           // contestId em execucao

export function status() { return { busy, controls: Object.fromEntries(control) }; }
export function pause(cid) { control.set(cid, 'pause'); }
export function stop(cid) { control.set(cid, 'stop'); }
export function clearControl(cid) { control.delete(cid); }

class Halt extends Error { constructor(why) { super(why); this.halt = why; } }
function check(cid) {
  const c = control.get(cid);
  if (c) throw new Halt(c);
}

const HypothesesSchema = z.object({
  hypotheses: z.array(z.object({
    title: z.string(),
    severity: z.enum(['High', 'Medium']),
    file: z.string(),
    fn: z.string(),
    description: z.string(),
    attack_path: z.string(),
    poc_plan: z.string(),
    confidence: z.number(),
  })),
});

const MergeSchema = z.object({
  groups: z.array(z.object({
    keep: z.string(),
    merge: z.array(z.string()),
    reason: z.string(),
  })),
});

const VerdictSchema = z.object({
  valid: z.boolean(),
  severity: z.enum(['High', 'Medium', 'Low']),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Prompts. Tudo em ingles: o relatorio vai para juizes humanos das plataformas.

function persona(contest) {
  return [
    `You are ${AGENT.name}, an autonomous smart-contract security researcher competing in public audit contests (Code4rena, Sherlock, Cantina, CodeHawks).`,
    `The protocol team published this code specifically so that auditors attack it; finding and proving exploitable bugs is the sanctioned purpose of the contest.`,
    `Your findings are judged by humans. Invalid, speculative or duplicated-by-design reports cost reputation, so you only report what a running Foundry test proves.`,
    `Severity (Code4rena / Sherlock style): High = direct loss or theft of funds, or a broken core invariant, with realistic preconditions. Medium = loss under specific conditions, value leak, or denial of service / griefing of core functionality. Everything else is NOT reported: informational, gas, best practices, centralization or admin trust assumptions, out-of-scope files, and known issues listed by the protocol.`,
    `Do not report the same root cause twice. Prefer fewer, stronger findings.`,
  ].join('\n');
}

function contestContext(contest, dir) {
  const readme = repo.readmeHead(dir);
  return [
    `CONTEST: ${contest.title} (${contest.platform})`,
    contest.description ? `DESCRIPTION: ${contest.description}` : '',
    contest.knownIssues ? `KNOWN ISSUES (do not report): ${contest.knownIssues}` : '',
    readme ? `README (head):\n${readme}` : '',
  ].filter(Boolean).join('\n\n');
}

// O sistema e o mesmo em todas as chamadas do contest: o codigo do escopo entra
// como bloco cacheado (cache de prefixo), o que derruba o custo das leituras.
function systemFor(contest, dir, bundle) {
  return [
    { type: 'text', text: persona(contest) + '\n\n' + contestContext(contest, dir) },
    { type: 'text', text: `SCOPE CODE (every file in scope, in full):\n${bundle}`, cache_control: { type: 'ephemeral' } },
  ];
}

function hypothesizePrompt(file, hints) {
  return [
    `FOCUS FILE: ${file.path} (${file.lines} lines). The full scope is in your context; interactions between this file and the others count.`,
    `Think like an attacker about every external/public function, every state transition, every arithmetic and accounting path, every external call and callback, every access control, every price/oracle/rounding assumption, every upgrade/initialization path, and every cross-contract assumption.`,
    `List up to ${LIMITS.maxHypothesesPerFile} hypotheses of High or Medium bugs rooted in this file. For each: a short title, severity, file, function, the root cause (description), a concrete numbered attack path, and a PoC plan saying exactly what a Foundry test must set up and assert to prove it. Give a confidence between 0 and 1.`,
    `If nothing credible exists, return an empty list. Do not pad the list with weak items.`,
    hints ? `STATIC ANALYSIS HINTS (may be noisy):\n${hints}` : '',
  ].filter(Boolean).join('\n\n');
}

function pocPrompt(h, name, sample, foundry) {
  return [
    `Write a Foundry test that PROVES this hypothesis by executing the attack against the real contracts of the repository.`,
    `HYPOTHESIS:\nTitle: ${h.title}\nSeverity: ${h.severity}\nFile: ${h.file}\nFunction: ${h.fn}\nRoot cause: ${h.description}\nAttack path: ${h.attackPath}\nPoC plan: ${h.pocPlan}`,
    `RULES FOR THE TEST:\n- File path: test/warden/${name}.t.sol. Contract name: ${name}Test, inheriting forge-std Test.\n- Exactly one test function: test_${name}_exploit(). It must PASS only if the exploit works, and it must assert the harmful outcome explicitly (balance deltas, stuck funds, wrong accounting, broken invariant).\n- Deploy and configure the protocol the same way the repository's own tests do (see the sample test). Import the real contracts with the repository's remappings.\n- The attacker is an ordinary address with no privileged role, unless the bug is exactly a missing access control.\n- Cheatcodes only for funding actors, pranking the attacker, and moving time or blocks. No vm.store, vm.etch or vm.mockCall to fake protocol state.\n- If, while writing, you conclude the bug is not real or not exploitable, answer with a single line: NOT_EXPLOITABLE: <reason>.`,
    foundry.config ? `foundry.toml:\n${foundry.config}` : 'No foundry.toml found.',
    foundry.remappings ? `remappings.txt:\n${foundry.remappings}` : '',
    sample ? `SAMPLE TEST FROM THE REPOSITORY (${sample.path}):\n${sample.code}` : 'The repository has no tests; deploy the contracts yourself in setUp().',
    `Output only the complete Solidity file in one \`\`\`solidity block, or the NOT_EXPLOITABLE line.`,
  ].filter(Boolean).join('\n\n');
}

function fixPrompt(feedback, iteration) {
  return [
    `The test did not pass (attempt ${iteration} of ${LIMITS.maxPocIterations}). Forge output:\n${feedback}`,
    `If the failure is in the test itself (compile error, wrong setup, wrong import, wrong assertion), fix the test and output the complete corrected file in one \`\`\`solidity block.`,
    `Common causes of a failing PoC that is otherwise right: the target has no funds beyond the attacker's own deposit (seed it with victim deposits first); a reentrant receive()/fallback has no stop condition and reverts when the target runs dry (stop when the target balance is below the amount, and never revert inside receive()); the attacker contract needs a receive() to accept ETH; a call is made from the test contract instead of the attacker (use vm.startPrank or route it through the attacker contract); a revert message differs from the one expected; the exact revert cause is in the trace above.`,
    `If the output shows that the bug is not real or not exploitable, answer with a single line: NOT_EXPLOITABLE: <reason>.`,
  ].join('\n\n');
}

function judgePrompt(h, code, tests) {
  return [
    `A Foundry test written to prove the following hypothesis PASSES. Judge it as a strict contest judge would.`,
    `HYPOTHESIS: ${h.title} (${h.severity}) in ${h.file} / ${h.fn}\n${h.description}\nAttack path: ${h.attackPath}`,
    `TEST FILE:\n${code}`,
    `FORGE RESULT: ${JSON.stringify(tests).slice(0, 4000)}`,
    `Is this a genuine demonstration of a High or Medium vulnerability, or a false positive? False positives include: the test exercises intended behavior; the attacker holds a privileged role; cheatcodes fake protocol state; assertions are tautological or do not show harm; the precondition is unrealistic, out of scope, or a listed known issue; the "loss" is dust or self-inflicted. Return valid, the severity you would award, and the reason.`,
  ].join('\n\n');
}

function reportPrompt(contest, h, finding) {
  const fmt = {
    code4rena: `## ${'{title}'}\n### Severity\n### Lines of code (paths and line ranges)\n### Vulnerability details\n### Impact\n### Proof of Concept (the Foundry test, with how to run it)\n### Tools used\n### Recommended mitigation steps`,
    sherlock: `### Summary\n### Root Cause (with file paths and line references)\n### Internal Pre-conditions\n### External Pre-conditions\n### Attack Path (numbered)\n### Impact\n### PoC (the Foundry test, with how to run it)\n### Mitigation`,
    cantina: `## Title\n### Severity\n### Description (root cause with file paths and lines)\n### Impact\n### Proof of Concept (the Foundry test, with how to run it)\n### Recommendation`,
    codehawks: `## Title\n### Description (root cause with file paths and lines)\n### Impact\n### Proof of Concept (the Foundry test, with how to run it)\n### Recommended Mitigation`,
  };
  const template = fmt[contest.platform] || fmt.code4rena;
  return [
    `Write the final report for this confirmed finding, in the ${contest.platform} submission format below. Markdown, precise, no filler, no hedging, no emojis. Reference exact file paths and functions. Include the passing test verbatim inside the PoC section with the command to run it (forge test --match-path ${finding.test.file} -vvv).`,
    `FORMAT:\n${template}`,
    `FINDING: ${h.title} (${finding.severity}) in ${h.file} / ${h.fn}\nRoot cause: ${h.description}\nAttack path: ${h.attackPath}\nJudge note: ${finding.verdictReason}`,
    `TEST FILE (passes):\n${finding.test.code}`,
  ].join('\n\n');
}

function mergePrompt(findings) {
  return [
    `These findings were all confirmed for the same contest. Contest judges merge reports that share a ROOT CAUSE (the same missing check, the same ordering bug, the same wrong formula), even when they surface in different functions, and duplicates within one submission look bad.`,
    `Group them by root cause. For each group with more than one finding, name the one to keep (the strongest PoC / highest impact) and the ones to merge into it, with the reason. Findings with a distinct root cause are their own group of one (list them with an empty merge array).`,
    findings.map((f) => `${f.id} [${f.severity}] ${f.title}
  file ${f.file} / ${f.fn}
  ${f.verdictReason.slice(0, 500)}`).join('\n\n'),
  ].join('\n\n');
}

function mergedReportPrompt(contest, keep, merged) {
  return [
    `Rewrite the report below so it also covers the merged findings that share its root cause. Same format and section headings as the original, same platform (${contest.platform}). Keep the original PoC test verbatim and add the other tests after it, each with its run command. Mention every affected function and line range.`,
    `ORIGINAL REPORT:
${keep.report}`,
    ...merged.map((m) => `MERGED FINDING ${m.id} [${m.severity}] ${m.title} (${m.file} / ${m.fn})
TEST (${m.test.file}):
${m.test.code}`),
  ].join('\n\n');
}

const extractSolidity = (text) => {
  const m = text.match(/```solidity\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  return m ? m[1].trim() + '\n' : null;
};

// ---------------------------------------------------------------------------
// Execucao.

export async function start(cid) {
  if (busy) throw new Error(`engine busy with ${busy}`);
  const c = S.contest(cid);
  if (!c) throw new Error('unknown contest');
  if (!claude.enabled()) throw new Error('ANTHROPIC_API_KEY missing');
  control.delete(cid);
  busy = cid;
  c.status = 'running';
  const s = S.load();
  s.engine = { status: 'running', current: cid, since: Date.now(), error: null };
  S.save(true);
  work(cid).catch(() => {}).finally(() => { busy = null; });
}

async function work(cid) {
  const c = S.contest(cid);
  const r = S.run(cid);
  const s = S.load();
  const meters = [r.stats, s.spend];
  r.startedAt = r.startedAt || Date.now();
  r.error = null;
  const pub = (line, kind = 'info') => S.log(line, { contestId: cid, kind });
  const sec = (line, kind = 'info') => S.log(line, { contestId: cid, secret: true, kind });
  const budget = () => {
    if (r.stats.usd > LIMITS.maxUsdPerContest) throw new Halt('budget');
  };

  try {
    // 1. Repo
    r.phase = 'prepare';
    pub(`preparing ${c.title}: ${c.repoUrl}${c.commit ? ' @ ' + c.commit.slice(0, 10) : ''}`);
    const dir = await repo.prepare(c, (l) => pub(l));
    if (!r.files.length) r.files = repo.resolveScope(c, dir);
    r.stats.files = r.files.length;
    pub(`scope: ${r.files.length} files, ${r.files.reduce((a, f) => a + f.lines, 0)} lines`);
    S.save(true);
    check(cid);

    const foundry = repo.foundryConfig(dir);
    let canProve = foundry.hasFoundry;
    if (canProve) {
      pub('forge build');
      const b = await forge.build(dir);
      if (!b.ok) { pub(`forge build failed; hypotheses only, no PoC (${b.out.split('\n').slice(-3).join(' | ').slice(0, 200)})`, 'warn'); canProve = false; }
      else pub('build ok');
    } else {
      pub('no foundry.toml: hypotheses only, no PoC', 'warn');
    }
    r.canProve = canProve;
    check(cid);

    // 2. Hipoteses, arquivo por arquivo
    const bundle = repo.bundle(dir, r.files);
    const system = systemFor(c, dir, bundle);
    r.phase = 'hypothesize';
    for (const f of r.files) {
      if (f.status === 'read') continue;
      check(cid); budget();
      r.currentFile = f.path;
      pub(`reading ${f.path} (${f.lines} lines)`);
      S.save(true);
      const { data, model } = await claude.askJson({
        system, schema: HypothesesSchema, meters,
        messages: [{ role: 'user', content: hypothesizePrompt(f, null) }],
      });
      r.stats.linesRead += f.lines;
      for (const h of data.hypotheses) {
        const n = r.hypotheses.length + 1;
        r.hypotheses.push({
          id: `W${n}`, title: h.title, severity: h.severity, file: h.file || f.path, fn: h.fn,
          description: h.description, attackPath: h.attack_path, pocPlan: h.poc_plan, confidence: h.confidence,
          status: 'open', iterations: 0, model, createdAt: Date.now(),
        });
        sec(`hypothesis W${n} [${h.severity}] ${h.title} (${h.file || f.path} / ${h.fn}, confidence ${h.confidence})`);
      }
      r.stats.hypotheses = r.hypotheses.length;
      f.status = 'read';
      pub(`${data.hypotheses.length} hypotheses from ${f.path} (${r.hypotheses.length} total, $${r.stats.usd.toFixed(2)} spent)`);
      S.save(true);
    }
    r.currentFile = null;

    // 3. Prova por teste
    r.phase = 'prove';
    const sample = repo.sampleTest(dir);
    const order = [...r.hypotheses].filter((h) => h.status === 'open')
      .sort((a, b) => (b.severity === 'High') - (a.severity === 'High') || b.confidence - a.confidence);
    for (const h of order) {
      check(cid); budget();
      if (!canProve) { h.status = 'unproven'; continue; }
      r.currentFile = h.file;
      pub(`writing PoC for hypothesis ${h.id} (${h.severity})`);
      S.save(true);
      const messages = [{ role: 'user', content: pocPrompt(h, h.id, sample, foundry) }];
      let outcome = null;
      for (let i = 1; i <= LIMITS.maxPocIterations; i++) {
        check(cid); budget();
        h.iterations = i;
        const { text } = await claude.ask({ system, messages, meters });
        if (/^\s*NOT_EXPLOITABLE:/m.test(text)) {
          h.status = 'rejected'; h.verdict = text.match(/NOT_EXPLOITABLE:(.*)/)[1].trim().slice(0, 500);
          sec(`${h.id} withdrawn by the agent while writing the PoC: ${h.verdict}`);
          pub(`hypothesis ${h.id} dropped by the agent while writing the exploit: not exploitable`, 'warn');
          outcome = 'rejected'; break;
        }
        const code = extractSolidity(text);
        if (!code) { messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'Output the complete Solidity file in one ```solidity block, or the NOT_EXPLOITABLE line.' }); continue; }
        r.stats.tests++;
        const res = await forge.runPoc(dir, h.id, code);
        if (res.passed) {
          r.stats.testsPassed++;
          h.test = { file: res.file, code, tests: res.tests };
          sec(`${h.id} PoC PASSED on attempt ${i}: ${h.title}`, 'ok');
          pub(`PoC for ${h.id} passed (attempt ${i})`, 'ok');
          outcome = 'passed'; break;
        }
        r.stats.testsFailed++;
        pub(`PoC for ${h.id} ${res.compiled ? 'failed' : 'did not compile'} (attempt ${i}/${LIMITS.maxPocIterations})`, 'warn');
        sec(`${h.id} forge feedback: ${res.feedback.slice(0, 400)}`);
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: fixPrompt(res.feedback, i) });
      }
      if (outcome !== 'passed') {
        if (outcome !== 'rejected') { h.status = 'unproven'; sec(`${h.id} unproven after ${h.iterations} attempts`); pub(`hypothesis ${h.id} dropped: no passing exploit after ${h.iterations} attempts`, 'warn'); }
        forge.removePoc(dir, h.id);
        S.save(true);
        continue;
      }

      // 4. Juiz
      check(cid); budget();
      const { data: v } = await claude.askJson({
        system, schema: VerdictSchema, meters,
        messages: [{ role: 'user', content: judgePrompt(h, h.test.code, h.test.tests) }],
      });
      h.verdict = v.reason; h.judgedSeverity = v.severity;
      if (!v.valid || v.severity === 'Low') {
        h.status = 'rejected';
        sec(`${h.id} rejected by the judge (${v.severity}): ${v.reason}`);
        pub(`hypothesis ${h.id} rejected by the judge (${v.severity}): the passing test does not prove a real ${h.severity}`, 'warn');
        forge.removePoc(dir, h.id);
        S.save(true);
        continue;
      }
      h.status = 'confirmed';
      r.stats.confirmed++;
      pub(`finding ${h.id} confirmed by the judge (${v.severity})`, 'ok');

      // 5. Relatorio
      const finding = { id: h.id, title: h.title, severity: v.severity, file: h.file, fn: h.fn, test: h.test, verdictReason: v.reason, createdAt: Date.now(), submitted: false, report: null };
      const rep = await claude.ask({ system, meters, messages: [{ role: 'user', content: reportPrompt(c, h, finding) }] });
      finding.report = rep.text.trim();
      r.findings.push(finding);
      sec(`${h.id} report written (${finding.report.length} chars)`);
      S.save(true);
    }
    // 6. Fusao: findings com a mesma causa raiz viram um relatorio so
    const live = r.findings.filter((f) => !f.duplicateOf);
    if (live.length >= 2) {
      check(cid); budget();
      r.phase = 'merge';
      pub(`checking ${live.length} findings for shared root causes`);
      const { data: m } = await claude.askJson({ system, schema: MergeSchema, meters, messages: [{ role: 'user', content: mergePrompt(live) }] });
      for (const g of m.groups) {
        const keep = live.find((f) => f.id === g.keep);
        const merged = g.merge.map((id) => live.find((f) => f.id === id && f.id !== g.keep)).filter(Boolean);
        if (!keep || !merged.length) continue;
        const rep = await claude.ask({ system, meters, messages: [{ role: 'user', content: mergedReportPrompt(c, keep, merged) }] });
        keep.report = rep.text.trim();
        keep.mergedIds = merged.map((x) => x.id);
        for (const x of merged) { x.duplicateOf = keep.id; const h = r.hypotheses.find((hh) => hh.id === x.id); if (h) h.status = 'merged'; }
        r.stats.confirmed -= merged.length;
        sec(`${merged.map((x) => x.id).join(', ')} merged into ${keep.id}: ${g.reason.slice(0, 300)}`);
        pub(`${merged.length} finding(s) merged into ${keep.id} (same root cause)`);
      }
      S.save(true);
    }

    r.currentFile = null;
    r.phase = 'done';
    r.finishedAt = Date.now();
    const toSubmit = r.findings.filter((f) => !f.duplicateOf).length;
    c.status = toSubmit ? 'ready' : 'done';
    pub(`done: ${toSubmit} findings ready to submit, ${r.hypotheses.length} hypotheses, ${r.stats.tests} tests, $${r.stats.usd.toFixed(2)}`, 'ok');
  } catch (e) {
    if (e.halt === 'pause') { r.phase = 'paused'; c.status = 'paused'; pub('paused'); }
    else if (e.halt === 'stop') { r.phase = 'stopped'; c.status = 'stopped'; pub('stopped'); }
    else if (e.halt === 'budget') { r.phase = 'budget'; c.status = 'budget'; pub(`budget of $${LIMITS.maxUsdPerContest} reached; stopped with $${r.stats.usd.toFixed(2)} spent`, 'warn'); }
    else { r.phase = 'error'; r.error = String(e?.message || e); c.status = 'error'; pub(`error: ${r.error.slice(0, 300)}`, 'error'); console.error(e); }
  } finally {
    control.delete(cid);
    const s2 = S.load();
    s2.engine = { status: 'idle', current: null, since: Date.now(), error: r.error };
    S.save(true);
  }
}

// Ao subir, retoma o contest que estava rodando.
export function resumeOnBoot() {
  const s = S.load();
  const running = s.contests.find((c) => c.status === 'running');
  if (running && claude.enabled()) {
    S.log(`resuming ${running.title} after restart`, { contestId: running.id });
    start(running.id).catch((e) => S.log(`resume failed: ${e.message}`, { kind: 'error' }));
  }
}

export async function toolsReport() {
  return { forge: await forge.version(), git: TOOLS.git, claude: claude.enabled(), slither: TOOLS.slitherEnabled };
}
