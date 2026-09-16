# Warden — spec (congelada em 15/09/2026)

Agente de segurança que compete em contests públicos de auditoria de smart contracts.
O prêmio em dólar vira recompra e queima do token $WARDEN na pons (Robinhood Chain).
O lançamento do token é do Michel, fora do claudeploy. O site só mostra o CA e o livro-caixa.

## O que ele faz (ciclo de um contest)

1. **Entrar**: o contest é cadastrado no painel (Sherlock importa pela API; Code4rena, Cantina e
   CodeHawks à mão com repo, commit e escopo). Clona no commit auditado, submódulos, `forge build`.
2. **Ler**: todo o escopo entra no contexto (bloco cacheado). Arquivo por arquivo o modelo lista
   hipóteses High/Medium com caminho de ataque concreto e plano de PoC (saída estruturada).
3. **Provar ou descartar**: para cada hipótese escreve um teste Foundry em `test/warden/W<n>.t.sol`
   que executa o ataque contra os contratos reais. Roda `forge test --json`. Até 3 tentativas com o
   erro do forge de volta. Sem teste passando, a hipótese morre (`unproven`). O modelo pode desistir
   com `NOT_EXPLOITABLE:`.
4. **Julgar**: teste que passa é julgado de novo como juiz de contest (falso positivo: comportamento
   esperado, atacante privilegiado, cheatcode falseando estado, asserção tautológica, pré-condição
   irreal). Só `valid` com High/Medium vira finding.
5. **Relatar**: relatório no formato da plataforma. **Envio manual**: o Michel copia do painel e cola
   na plataforma (nenhuma tem API de submissão; a conta, o KYC e o saque são dele).
6. **Prêmio**: semanas depois. Registrado no painel com rateio (padrão 40% compute / 60% queima /
   0% criador: o Michel já recebe as taxas de criador do token) e links das transações de pagamento e queima.

## Sigilo (regra das plataformas)

Durante o contest o público vê: contest, prêmio, prazo, arquivo sendo lido, contagens (hipóteses,
testes, passaram, confirmados), gasto, e o log **sem** conteúdo (linhas `secret`). Com status
`results` ou `paid` tudo abre: hipóteses, vereditos, testes e relatórios.

## Custo

Teto por contest `MAX_USD_PER_CONTEST` (padrão 150). Contado por token com a tabela de preços em
`config.js`. Cache de prefixo no código do escopo (leitura a 10%).

## Arquitetura

- `src/engine.js` motor (pipeline acima), `src/claude.js` (SDK, refusal → fallback),
  `src/repo.js` (git/escopo), `src/forge.js` (build/test/parse), `src/state.js` (JSON atômico +
  vista pública redigida), `src/server.js` (site + painel + API + espelho), `src/sherlock.js`.
- O motor precisa de git + forge + chave: roda no PC do Michel (`START-Windows.bat`, porta 8441).
- O site no Railway roda o mesmo servidor sem motor e recebe o estado por `POST /api/mirror`
  (`MIRROR_URL` + `MIRROR_TOKEN` no PC; `MIRROR_TOKEN` no Railway).

## Fora de escopo (por decisão)

- Envio automático às plataformas (não há API; automação de navegador em conta com KYC não).
- Carteira própria do agente para queimar sozinho (o prêmio cai na conta do Michel; a queima é dele,
  registrada com link).
- Immunefi (bounties em código em produção): outra disciplina, outra hora.
