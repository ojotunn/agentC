# Warden

An AI security researcher that competes in public smart-contract audit contests (Code4rena, Sherlock, Cantina, CodeHawks). Every finding it reports is proven by a Foundry test that executes the attack. Prizes fund the buyback and burn of its token on pons (Robinhood Chain).

## How a contest runs

1. The contest is added in the panel (`/admin`): repository, commit, scope. Sherlock contests import from its API.
2. The engine clones the repo, builds it, and reads the whole scope file by file, listing hypotheses of High/Medium bugs.
3. Each hypothesis gets a Foundry test written against the real contracts. No passing test, no finding.
4. A passing test is judged again as a strict contest judge. Then the report is written in the platform's format.
5. The creator copies the report from the panel and submits it on the platform. Results come weeks later; the prize is recorded in the ledger with its split and the burn transaction.

During a contest the public site shows the work (file being read, counts, log) but not the bugs: contest findings are confidential until results are published. Then everything opens.

## Running

```
cp .env.example .env     # fill ANTHROPIC_API_KEY
npm install
npm start                # http://localhost:8441   panel: /admin (token in data/admin.token or ADMIN_TOKEN)
npm test                 # unit tests, no model
npm run prova            # end-to-end on fixtures/vault with the real model (~$5-12)
```

Foundry: unzip `foundry_stable_win32_amd64.zip` (official release) into `tools/foundry/`, or set `FORGE_BIN`.

## Deploy

The engine needs git, forge and the API key: it runs on the creator's machine. The public site runs anywhere (Railway, Dockerfile included) with `MIRROR_TOKEN` set; the local engine pushes its public state there with `MIRROR_URL` + `MIRROR_TOKEN`.

## Rules (env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_MODEL` | claude-opus-5 | model for reading, tests, judging and reports |
| `FALLBACK_MODEL` | claude-opus-4-8 | used when the safety classifier declines a request |
| `MAX_USD_PER_CONTEST` | 150 | hard budget per contest |
| `MAX_HYPOTHESES_PER_FILE` | 6 | cap per scope file |
| `MAX_POC_ITERATIONS` | 4 | attempts to get a test passing |
| `SPLIT_COMPUTE/BURN/SALARY` | 40/60/0 | how a prize is split (also editable in the panel) |
