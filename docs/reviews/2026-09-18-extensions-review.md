# Revisão do sistema de extensões — performance concorrente, UI e memória

Data: 2026-09-18. Escopo: `extensions/` (24 extensões, ~44k linhas) + `settings.json` /
`subagents.json` + as extensões de memória já instaladas. Método: duas trilhas de auditoria
em contexto isolado (performance concorrente e UI/jank), uma trilha de infraestrutura, e
verificação local, no repositório, de todo achado P1 citado aqui. O que já estava em
`docs/reviews/2026-09-17-pi-performance-audit.md` não é re-reportado como achado novo, exceto
onde há quantificação diferente.

Alteração de código aplicada nesta revisão: **política de retenção de cache por modelo**
(`extensions/cache-retention/`). O resto do documento é diagnóstico + proposta.

---

## 1. Correção aplicada: `prompt_cache_retention` não é universal

### O problema, reproduzido

`extensions/cache-retention/index.ts` liga `PI_CACHE_RETENTION=long` em todo processo pi
(pai e filhos). O pi-ai então envia `prompt_cache_retention: "24h"` para qualquer modelo cujo
`compat` não negue retenção longa. Alguns endpoints do gateway não aceitam o campo:

```
$ PI_CACHE_RETENTION=long pi -p --no-session --no-tools -ne \
    --model opencode-go/glm-5.3-flash "ok"
400: {"param":"prompt_cache_retention","type":"invalid_request_error",
      "message":"... \"prompt_cache_retention\" is not supported by this endpoint;
                 use \"prompt_cache_options\""}
```

Sondagem direta contra `https://opencode.ai/zen/go/v1/chat/completions` (2026-09-18):

| modelo (opencode-go)                                           | `prompt_cache_retention` | `prompt_cache_options`                                                                                                           | `prompt_cache_key` |
| -------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `glm-5.1`, `glm-5.3`                                           | rejeitado                | rejeitado (`Extra inputs are not permitted`)                                                                                     | ok                 |
| `glm-5.3-flash`                                                | rejeitado                | aceito _às vezes_: `ttl` válido difere por backend (Zen exige `5m`/`1h`, upstream exige `30m`; `mode:"explicit"` exige GPT-5.6+) | ok                 |
| `deepseek-v4.1-flash`, `kimi-k3`, `qwen3.8-max`, `longcat-2.0` | ok                       | ok                                                                                                                               | ok                 |

Ou seja: traduzir para `prompt_cache_options` não é uma solução estável (o `ttl` aceito muda
conforme o backend roteado), e o campo correto é específico por modelo — não dá para resolver
com um único `PI_CACHE_RETENTION` global nem editando `models-store.json` (que é reescrito
pelo catálogo remoto).

### O que foi implementado

`extensions/cache-retention/` deixou de ser um one-liner e passou a ter três camadas:

- `src/policy.ts` — função pura que aplica regras ao payload que está saindo:
  `stripRetention`, `stripOptions` (aprendido), `stripKey`, `replaceWithOptions`.
  Regras que casam são mescladas; **um strip aprendido sempre vence um
  `replaceWithOptions` configurado**, para nunca voltar a mandar um campo que já deu 400.
  Glob por modelo (`glm-*`) e curinga de provider (`*`).
- `src/store.ts` — regras de três fontes, nesta ordem: `config.private.json` (à mão),
  `learned.private.json` (aprendido em runtime) e os defaults embutidos. Leitura preguiçosa
  (primeira requisição) e cacheada por processo: esta extensão carrega em todo processo pi,
  inclusive em cada worker Herdr, então o import continua sem I/O.
- `index.ts` — hook `before_provider_request` (aplica a política), hook `message_end`
  (aprende com o erro: grava a regra, aplica na hora em memória e persiste
  temp+rename com merge do conteúdo em disco, para não perder regra de outro processo) e o
  comando `/cache`, que mostra o modelo ativo, o efeito líquido, as regras que casaram, a
  origem de cada uma (config/aprendida/embutida) e os caminhos dos arquivos.

Default embutido hoje: `opencode-go` + `glm-*` → remove `prompt_cache_retention`.

### Verificação executada

1. `node --test` nas duas suítes novas: **19/19 passam** (`policy.test.ts`, `store.test.ts`).
2. `npm run check` (tsc): passa.
3. Autocura ponta a ponta, contra o endpoint real:
   - regra artificial `replaceWithOptions: { ttl: "1h" }` → requisição falha com 400
     `prompt_cache_options.ttl must be "30m"`;
   - `learned.private.json` é criado com `stripOptions` + `stripRetention` e a nota do erro;
   - **processo novo** (o caminho que realmente importa): a mesma chamada responde `ok`.
4. `glm-5.3-flash` com a extensão ativa: requisição responde `ok` onde antes dava 400.

### O que ficou de fora de propósito

- Não enviamos `prompt_cache_options` para GLM: o `ttl` aceito varia por backend roteado e o
  teste mostrou respostas inconsistentes. Sem campo de cache, o gateway ainda roteia pela
  sessão (`x-opencode-session`, enviado pelo pi) e o cache implícito do upstream continua valendo.
- Não há poda de regras aprendidas: o arquivo é minúsculo e auditável (`/cache` mostra tudo).
  Se um dia um modelo voltar a aceitar retenção, apague a entrada do `learned.private.json`.

---

## 2. Performance com múltiplos subagentes e bg terminals

Regra de leitura: quase todo custo aqui é pago **por processo pi**. Um filho Herdr é uma TUI
completa (`extensions/subagents/src/backends/herdr-worker.ts:412-426`) que carrega as 24
extensões; só a superfície de tools é restringida. Então o multiplicador real é
`(1 + filhos)` para tudo que roda em `session_start`, e `filhos` para tudo que roda por turno.

### 2.1 O que multiplica por processo filho (maior retorno primeiro)

**P1-A · `remote-agents` inicializa em todo processo TUI e gasta 3 `ssh` por filho.**
`extensions/remote-agents/index.ts:247-251`: `session_start` → se `ctx.mode === "tui"` →
`getManager()`; `manager.ts:132-140` → `initialize()` → `reconcile()` → `client.list()`;
`transport.ts:96-131` → `ensureHelper()` **sempre** reenvia `helper.py` e faz ping (2 `ssh`),
e cada request soma mais um. Com 3 filhos: ~12 spawns `ssh` + round-trips Tailscale numa
rajada, mesmo sem nenhum agente remoto configurado. Se o host estiver fora, cada `ssh` pode
ficar até 30 s vivo (`transport.ts:48-56`). _Correção mínima:_ não criar o manager quando o
registry local está vazio (nada a reconciliar) e/ou adiar para o primeiro uso de `/remote`.

**P1-B · o registry remoto é reescrito de forma síncrona, com spin-lock, a cada refresh.**
`remote-agents/src/persistence.ts:88-107` (`mkdirSync` + `writeFileSync` + `renameSync` do
arquivo inteiro) e `:114-136` (`Atomics.wait(sleepArray, 0, 0, 10)` em até 100 tentativas ⇒
até ~1 s de event loop **parado**); `manager.ts:618-641` (`changed()` → `persist()`), chamado
no fim de **todo** `refresh()` (`manager.ts:308`) e por `reconcile()` (`:600`). O poll é de 3 s
por agente ativo (`:135-138`) e o dashboard de detalhe força refresh a cada 2 s
(`remote-agents/src/ui/dashboard.ts:255`). O arquivo é global e compartilhado por todos os
processos pi, com tombstones que nunca são podados (`persistence.ts:26-42`). _Correção mínima:_
dirty-flag (não persistir sem mudança), persistência assíncrona com debounce e poda de tombstones.

**P2-C · `browser` importa `playwright-core` no topo do módulo, em todo processo.**
`extensions/browser/src/runtime.ts:23-31` (import estático) + `browser/index.ts:134-140`
(`new BrowserRuntime(...)` no factory), embora a extensão esteja desligada por padrão
(`runtime.ts:116-121` só abre o Chromium sob demanda). _Correção mínima:_ `await import("playwright-core")`
dentro de `ensurePage()`.

**P2-D · `git-info` roda em cada filho TUI e dispara 4-5 processos `git` por mutação.**
`git-info/index.ts:29` (poll de 15 s), `:204-220` (fiber de poll quando `ctx.mode === "tui"`),
`:226-231` (`tool_execution_end` → refresh com debounce de 500 ms; `refresh-policy.ts:21-25`
trata tudo que não é read-only como mutação). Um filho codando faz ~1 mutação/s ⇒ 4-5 spawns
de `git`/s por filho; 3 filhos no mesmo repo ≈ 12-15 spawns/s. _Correção mínima:_ manter o poll
lento no filho, mas pular o refresh por mutação quando `PI_SUBAGENT === "1"` (a variável já
existe: `herdr-worker.ts:283`; o precedente de uso é `summaries/index.ts:25-33`).

**P2-E · lock e leitura síncronos por filho, no processo pai.**
`herdr-worker.ts:1266-1300` (tailer com `statSync` a cada 300 ms + `openSync/readSync`),
`:1816-1841` (`existsSync` do ask-file a cada 300 ms), `:2198-2221` (descoberta do arquivo de
sessão com `readdirSync` a cada 300 ms), `herdr-workspace.ts:1098-1108` (sonda de liveness a
cada 30 s = 1 processo `herdr`). Isolado é pouco; somado a B e D no mesmo loop, aparece.

**P2-N · `file-search` sonda (e pode baixar) binários em todo `session_start`.**
`file-search/index.ts:119-160`: o handler de `session_start` roda `Effect.all({fd, rg})` com
`concurrency: "unbounded"`; cada inicializador faz probe por spawn (`fd --max-results 1 -- ""`,
`rg --version`, timeout de 5 s) e, se não achar, **baixa e instala** o binário via HTTPS + tar
(`src/binaries.ts:327-356`). `ctx.hasUI` só controla notificação, não o trabalho — então todo
processo (pai e cada filho) paga 2 spawns e, em cache frio, rede. O repo já tem
`bin/fd.exe`/`bin/rg.exe`, então o caminho provável é "probe e desiste"; ainda assim, um
`existsSync` no diretório de binários antes de qualquer spawn elimina o custo por processo.

**P2-P · `herdr-agent-state.ts` pode somar ~2 s a cada `session_start` de TUI.**
`extensions/herdr-agent-state.ts:229-241`: `session_start` faz `await reportSession(...)` e
`sendRequest` (`:50-55`) tenta o socket com timeouts de 500 ms e depois 1500 ms. Vale para
toda TUI, inclusive cada worker Herdr. **Arquivo gerenciado pelo herdr** (está no `.gitignore`,
"Installed automatically by herdr"), então a correção é upstream/reduzir o budget de retry — não
dá para corrigir localmente sem perder a próxima instalação.

**P3-Q · `prompt-snippets` recarrega o diretório em todo `session_start`.**
`prompt-snippets/index.ts:308-312` → `snippets.ts:51-69` lê cada `.md` de forma síncrona (e cria
o diretório se faltar). Com ~11 snippets é barato, mas é pago por processo e não tem cache por
`mtime`; só vale se a loadout de filhos for adiada.

**P3-R · `restoreWorkers` lê 256 KiB por filho anterior em todo `session_start`.**
`subagents/index.ts:438-470` + `:373-390` + `:392-435`: 20 filhos restaurados ≈ 5 MB de leitura
síncrona + ~20 mil `JSON.parse` num único tick. _Correção mínima:_ ler ~8 KiB primeiro e ampliar
só se não houver mensagem terminal.

**Latente:** descoberta de rollout do Codex lê a árvore inteira e cada candidato inteiro a cada
300 ms (`herdr-worker.ts:2229-2247`, `:147`, `:1331-1360`, `:1363-1381`) — só com
`harness: "codex"`, que hoje nenhum profile usa (mas uma única chamada de tool ativa).

### 2.2 O que dói com a UI aberta (custo por evento/frame)

**P1-G · `/ps` re-sanitiza e re-wrapa o buffer retido inteiro a cada chunk.**
`background-terminals/src/output.ts:40-83` (o cache de join invalida a cada push e
`totalBytes` é o proxy de versão), `ui/ps.ts:578` e `ui/output-view.ts:57-81` (cache chaveado
em `versão:largura` ⇒ **miss a cada chunk**), `output-view.ts:44-58` (3 regex + split +
`wrapTextWithAnsi` por linha de todo o texto), `ps.ts:430-437` (throttle de 50 ms ⇒ até 20
renders/s). Com 2 MiB retidos e um comando verboso: até 20 varreduras completas por segundo.
_Correção mínima:_ cache incremental append-only (processar só o sufixo desde o último
`version`) — o padrão de layout já existe, só falta ser incremental.

**P2-H · transcript reconstruído por frame troca CPU por fluidez.**
`subagents/src/ui/takeover.ts:569-605` (`buildTranscriptLines` dentro de `render`, depois
fatia a viewport), `remote-agents/src/ui/dashboard.ts:331`, `workflows/dashboard.ts:909-934/977`.
`subagents/src/manager.ts:56-59` permite 512 itens × 64 KiB + 128 KiB de texto vivo. Sem
memoização por (revisão, largura, tema). _Correção mínima:_ memoizar e/ou reusar o cache de
linhas por item.

**P2-I · delta de streaming faz concat + `slice(-128 KiB)` + spread por token.**
`subagents/src/manager.ts:383-399` (`(live.text + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH)`,
spread de objeto por delta) e `:480` (`notify(s.id)` por evento). No pai, mesmo para filhos
Herdr, os deltas chegam em lote do tailer — cada delta reconstrói até 128 KiB de string.
Com 3 filhos streamando, é alocação/GC contínua. _Correção mínima:_ acumular pedaços em array
e materializar sob demanda; coalescer `notify` (30-60 Hz).

**P2-J · dashboard de workflows varre o disco em ciclo de 500 ms.**
`workflows/dashboard.ts:418-425` (`setInterval(…, 500)` chamando `refresh()` enquanto algum run
está live) → `loadRunEntries` (`:228-280`) faz `readdirSync` + `readFileSync` + `JSON.parse`
de `workflow.json`, `result.json` e `transcripts.json` de **todos** os runs, filtrando por
sessão só depois. E `cancel` no detalhe chama `refresh()` **dentro do keypress**
(`:558-559`), então Esc pode travar em repositórios com muitos runs. _Correção mínima:_ cache
por `mtime` + releitura apenas dos runs live; tirar a varredura do caminho de tecla.

**P2-K · `model-info` recalcula o custo varrendo o branch inteiro.**
`model-info/index.ts:11-21` (`getSessionCost` soma sobre `ctx.sessionManager.getBranch()`) em
`agent_start`, `turn_end`, `agent_settled`, `model_select` e no canal de refresh. O(n) por
chamada, O(n²) acumulado, e roda também nos filhos. _Correção mínima:_ acumular custo
incrementalmente em `message_end`.

**P3-L · `updateWidget` paga `list()` + `filter` antes do guard de contagem.**
`background-terminals/index.ts:145-152`, chamado a cada chunk (`manager.ts:730-737`;
`list()` realoca array em `:961`). _Correção mínima:_ contadores incrementais no manager.

**P3-M · coleções monotônicas** (`observer.ts:107/199/222` `settledIds`, `herdr-workspace.ts:971-975`
`usedAgentNames`, tombstones de `remote-agents`) — custo pequeno, mas cresce com a sessão e
agrava 2.1-B.

### 2.3 Inventário de duplicação (consolidação candidata)

Levantado na trilha de infraestrutura; serve de backlog para o kit compartilhado da seção 5.

| Infra duplicada          | Onde                                                                                                                                                                      | Risco de drift                                                                       | Consolidação                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Wrapping de viewport     | `shared/ui/viewport.ts:33-40` vs `subagents/src/ui/transcript.ts:37-43`, `remote-agents/src/ui/transcript.ts:20-25`, `background-terminals/src/ui/output-view.ts:48-53`   | larguras mínimas e parágrafos diferem; linha pode exceder a largura                  | reusar `wrapViewportText`                        |
| Sanitização ANSI         | `subagents/src/ui/transcript.ts:24-33`, `remote-agents/src/ui/transcript.ts:11-18`, `background-terminals/src/ui/output-view.ts:29-39`, `ui-customization/index.ts:49-54` | uma variante remove tabs, outra preserva; OSC/CSI vaza em um overlay e some no outro | `shared/terminal-text.ts` com políticas nomeadas |
| Escrita JSON atômica     | `workflows/serialization.ts:148-160`, `auto-naming/src/config.ts:81-98`, `summaries/src/config.ts:83-99`, `remote-agents/src/persistence.ts:88-107`                       | divergem em lock, modo, falha e cleanup                                              | `shared/json-store.ts`                           |
| Formatação de tokens     | `shared/context-utilization.ts:29-46` vs `subagents/src/format.ts:34-49`, `workflows/model.ts:131-135`, `ui-customization/index.ts:57-60`                                 | `M` vs `m`, arredondamento, capacidade desconhecida                                  | um formatter parametrizado                       |
| Formatação de duração    | `subagents/src/domain.ts:301-311`, `background-terminals/src/domain.ts:53-61`, `remote-agents/src/domain.ts:51-59`, `workflows/model.ts:157-166`                          | 4 cópias, formatos distintos para o mesmo estado                                     | `shared/format.ts:formatElapsed`                 |
| Activity status          | `shared/activity-status.ts:13` vs `subagents/src/format.ts:76-88`                                                                                                         | ícones/contagens divergem entre footer e dashboards                                  | subagents importar o shared                      |
| Tickers de overlay       | `subagents/src/ui/takeover.ts:188,447`, `remote-agents/src/ui/dashboard.ts:104,254-255`, `workflows/dashboard.ts:417-426`                                                 | cleanup e frequência variam                                                          | `shared/ticker.ts` com start/stop e `unref`      |
| Load/validação de config | `auto-naming/src/config.ts:50-78`, `summaries/src/config.ts:53-79`, `remote-agents/src/config.ts:43-116`, `subagents/src/config.ts:171-306`                               | uns caem para default em silêncio, outros lançam                                     | parser comum com política explícita              |
| Walk/tail de sessões     | `subagents/index.ts:373-401,438-467` vs `subagents/src/backends/herdr-worker.ts:2433-2456`                                                                                | dois algoritmos com limites e critérios diferentes                                   | helper compartilhado                             |

### 2.4 Falsos positivos (não gaste tempo)

- Saída de bg terminal **não** passa pelo event loop: buffer limitado, spill em disco nunca é
  relido (`output.ts`, `manager.ts:679-688`, `prompt.ts:95-104`); o watcher é processo externo.
- `cache-retention` copia o payload de forma rasa por request e carrega regras 1×/processo.
- `browser` abre o Chromium só sob demanda; o custo é o import, não um browser por processo.
- Guards de sobreposição de tick existem e funcionam (`refreshCoordinator.runIfIdle`,
  `remote-agents` `this.polling`, `JsonlTailer.running`, fiber cancelável do `git-info`).
- `auto-naming` não faz chamada extra quando o nome é fornecido (`title-generator.ts:86-91`;
  `subagent_spawn.name` é obrigatório) — o achado antigo não se aplica no fluxo normal.
- `herdr-agent-state.ts` publica por transição (dedupe em `publishState`), não por token.

### 2.5 Custo medido do startup da correção desta revisão

`cache-retention` passou de 18 para ~330 linhas, mas o import continua sem I/O: as regras só
são lidas na primeira requisição e ficam em cache. Custo por processo: alguns `µs` de registro
de 3 hooks; custo por requisição: um `filter` sobre 1-2 regras. Custo por erro: 1 escrita
pequena e atômica (só na primeira vez que um modelo é aprendido).

---

## 3. UI: consistência

Superfícies comparadas: `/summary` (S1), auto-naming (S2), `/subagents` (S3), `/ps` (S4),
`/workflows` (S5), `/remotes` (S6), `ask_user` (S7), `/kit` (S8), `/perf` (S9), `/cache` (S10),
snippets (S11), `/lg` (S12), footer/header (S13), busca de arquivos (S14).

| Atributo        | Valor dominante                     | Divergências                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moldura         | `border`/`borderAccent`             | 5 cores de borda: `border` (`takeover.ts:301,315`; `ps.ts:286,303`), `borderMuted` (`workflows/dashboard.ts:650`), `borderAccent` (`changed-files-view.ts:236-245`, `performance:89`, `cache-retention:125`), `accent` (`prompt-snippets:247`, `ask-user/layout.ts:302`), `text` (`takeover.ts:262`) |
| Cantos          | `╭╮╰╯`                              | `┌┐└┘` em S12 (`changed-files-view.ts:237-238`); sem caixa em S6/S9/S10/S11/S7                                                                                                                                                                                                                       |
| Título          | linha própria, contagem à direita   | título dentro da borda (S12, S5), título só como 1ª linha do corpo (S9, S10), sem título (S9/S10)                                                                                                                                                                                                    |
| Seleção         | `❯`                                 | `›` (S12), literais `> ` (S11), `" ❯ "` (`ask-user/layout.ts:165`)                                                                                                                                                                                                                                   |
| Glifo de estado | `■`                                 | falha = `x`/`■ error`/`✗`; sucesso = `✓` só em S6/S7; precisa de input = `?` vs `❓`; stalled = `◔`; recap = `✦`                                                                                                                                                                                     |
| Separador       | `·`                                 | `•` (`prompt-snippets:235`), ` —` (`ps.ts:566`), `"  "` (`ask-user/index.ts:403`)                                                                                                                                                                                                                    |
| Elipse          | `…` (28 usos)                       | `truncateToWidth` tem default `"..."` (pi-tui `utils.js:961`) ⇒ mistura por omissão                                                                                                                                                                                                                  |
| Key hints       | `dim`, teclas configuradas          | 4 dialetos: `keyHint()` real (S5/S6), literal `(ctrl+o to expand)` (S3/S4), teclas minúsculas (S3/S4/S5), palavras fixas `Enter`/`Esc` (S8/S7/S11/S12)                                                                                                                                               |
| Empty state     | `(no X yet)`                        | `no workflow runs yet`, `No files found`, `Run recap unavailable`, `(no answer)`, ou via `notify`                                                                                                                                                                                                    |
| Error state     | `error: X`                          | `Error: X`, `workflow error: X`, `Run recap unavailable`                                                                                                                                                                                                                                             |
| Altura          | —                                   | 6 fórmulas: `rows-5`, `rows-8`, `rows-9`, `rows-1`, `0.8·rows-2`, `0.9·rows`; `shared/ui/viewport.ts` só é usado por S8/S7, e `sliceViewport` não tem uso em produção                                                                                                                                |
| Números         | —                                   | tokens em 3 formatos (`12k`/`1.5k`/`1.5KB`), custo `$x.xx` vs `$x.xxxx`, 4 cópias de `formatElapsed`                                                                                                                                                                                                 |
| Status          | `label: ■ n running · /cmd to view` | S6 foge do padrão (`remote-agents/index.ts:104-118`: sem `■`, sem sufixo `/remotes to view`, `accent` em vez de `warning`)                                                                                                                                                                           |
| Mecanismo       | status line                         | S4 publica a mesma informação como **widget** acima do editor (`background-terminals/index.ts:157-168`)                                                                                                                                                                                              |
| Idioma          | inglês                              | **português** no fallback do recap (`summaries/src/transcript.ts:279-288`)                                                                                                                                                                                                                           |
| Mensagem custom | caixa com fundo (S1)                | S3/S4/S6 devolvem `Text` pelado, indistinguível do texto do assistente                                                                                                                                                                                                                               |

### Top divergências (com correção mínima)

1. **Moldura/cantos em 5 cores e 4 estilos** — abrir `/subagents` e `/lg` lado a lado parece
   dois apps. Fix: uma constante de borda (`border` para painéis, `borderAccent` para overlays
   transitórios) e um só estilo de canto.
2. **Status de `remote-agents` fora do padrão** — reusar `formatActivityStatus`
   (`shared/activity-status.ts`) com o label `remote`.
3. **Mensagem custom sem moldura em S3/S4/S6** — envelope compartilhado com cabeçalho
   (`Box(1,1,customMessageBg)`), como S1 já faz (`summaries/src/ui.ts:49`).
4. **Elipse `...` vs `…`** — convenção: `…` explícito em todo `truncateToWidth`.
5. **Key hints em 4 dialetos** — usar `keyHint()`/`keyText()` (já existe em pi-tui); em
   teclado remapeado, hint literal mente.
6. **Altura em 6 fórmulas e `sliceViewport` morto** — padronizar em
   `viewportRows`/`sliceViewport` (`shared/ui/viewport.ts`).
7. **`/perf` e `/cache` sem cabeçalho distinto** e com cor por índice mágico
   (`performance:92`) — cabeçalho `accent(bold(...))` explícito.
8. **Tokens/custo/duração em 3-4 formatos** — apagar as cópias (`ui-customization:57`,
   `subagents/src/format.ts:35`, `workflows/model.ts:131`) e importar
   `shared/context-utilization.ts` + um único `formatElapsed`.
9. **`subagents/src/format.ts` é cópia assumida** dos helpers shared (o header do arquivo diz
   "self-contained copies of the v1 shared helpers") e já divergiu (stalled/questions só na cópia).
10. **Idioma misturado e estados vazios/erro em 3 estilos** — normalizar tudo para inglês,
    `error: {msg}` minúsculo, `(no X yet)`.

### Regras propostas (para virar `docs/ui-conventions.md`)

1. Moldura: painel em fluxo = caixa `border` com título na borda; overlay transitório =
   `borderAccent` + regra de largura total com linha de título. Nunca `accent` como borda.
2. Glifos: `■` só para estado (warning/success/error/muted), `❯` para seleção, `✓`/`✗` em
   resultado, sem emoji em coluna fixa, `…` para truncagem.
3. Cores: título `accent`+bold, meta `dim`, bloco `muted`, diffs
   `toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`, seleção `selectedBg`.
4. Header: `{Título} {n/total}`; empty `(no X yet)` em `dim`; erro `error: {msg}` em `error`.
5. Hints: última linha, `dim`, teclas via keybinding, separador `·`, sempre incluir a tecla de fechar.
6. Altura: sempre `viewportRows(...)`; viewport com altura fixa entre frames.
7. Cache de render: qualquer transformação histórico→linhas memoizada por
   (revisão, largura, tema), com `invalidate()` limpando tudo.
8. Um só status line (`shared/activity-status.ts`) com sufixo `· /{cmd} to view`; widget só
   para estado que exige ação.
9. Todo texto de UI em inglês.

---

## 4. UI: jank e flicker (ranqueado)

| #   | Sev | Confirmado    | Sintoma                                                                             | Mecanismo                                                                                                                            | Fix mínimo                                            |
| --- | --- | ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| J1  | P1  | sim           | UI engasga enquanto um workflow roda; Esc trava                                     | varredura de disco síncrona a cada 500 ms + no keypress (`workflows/dashboard.ts:418-425`, `:228-280`, `:558`)                       | cache por `mtime`, só runs live, tirar do keypress    |
| J2  | P2  | mecanismo sim | takeover de subagente/remoto e detalhe de workflow aquecem CPU e parecem congelados | transcript re-wrapado inteiro por frame (`takeover.ts:569`, `remote dashboard.ts:331`, `workflows/dashboard.ts:977`), sem memoização | lift do `createOutputLineCache` para `shared/ui/`     |
| J3  | P2  | sim           | overlay remoto pisca/aquece                                                         | `subscribeTo → requestRender` sem debounce + refresh de 2 s + ticker de 1 s (`remote dashboard.ts:238-240`)                          | copiar o `scheduleRender` de 50 ms dos irmãos         |
| J4  | P2  | sim           | responder `ask_user` e redimensionar a janela deixa o layout na largura antiga      | cache de linhas não considera `width` (`ask-user/index.ts:291`); pi só faz `requestRender` no resize, não `invalidate`               | guardar `cachedWidth`                                 |
| J5  | P2  | sim           | Esc "agarra" o terminal                                                             | `refresh()` síncrono dentro do handler de tecla (`workflows/dashboard.ts:558`)                                                       | `setImmediate` ou reusar `entries` em memória         |
| J6  | P3  | sim           | CPU constante com overlay aberto                                                    | ticker de 1 Hz força frame completo em 3 dashboards                                                                                  | manter o tick, corrigir J2                            |
| J7  | P3  | sim           | frame completo sem mudança de estado                                                | `else tui.requestRender()` em `/perf` e `/cache`                                                                                     | remover (já removido em `/cache`)                     |
| J8  | P3  | sim           | latência cresce com o catálogo no picker de modelo do `/summary`                    | `clear()` + novo `SelectList` por tecla (`summaries/src/ui.ts:186-204`)                                                              | atualizar itens da lista existente, debounce do input |
| J9  | P3  | sim           | `\t`/escape em transcript de workflow desalinha o painel                            | `workflows/dashboard.ts:918-934` não passa por `sanitizeText`, ao contrário dos 3 irmãos                                             | importar o `sanitizeText` compartilhado               |
| J10 | P3  | suspeito      | linha de log rasga o alt-screen                                                     | `console.error` em caminhos de erro (`background-terminals/index.ts:199`, `remote-agents/index.ts:160,206`)                          | `ctx.ui.notify(...,"error")` ou log em arquivo        |

J1, J2, J4, J5, J7 foram verificados por leitura direta nesta revisão (não só pelo auditor).

---

## 5. Ideias para o processo e para o sistema

1. **Kit de UI compartilhado (`shared/ui/panel.ts` + `docs/ui-conventions.md` + teste de
   conformidade).** Um módulo com: moldura/título, viewport de altura fixa, linha de hints,
   estados vazio/erro, cache de linhas incremental e um `sanitizeText` único. Um teste que
   varre as extensões e falha em padrões proibidos (borda `accent`, `truncateToWidth` sem
   elipse, `console.error` em UI, texto em português, `Math.floor(rows*0.9)`) impede a
   divergência de voltar. Custo: ~1 dia; ganho: mata 8 das 10 divergências e 4 dos 10 itens de jank.
2. **Loadout de extensões para filhos.** Um filho Herdr não precisa de dashboards, naming,
   recap, git poll por mutação, remote-agents nem playwright. Hoje eles são TUIs completas que
   carregam tudo. pi já suporta a mecânica: no launcher, `-ne` + `-e` para as extensões
   essenciais (transporte de resultado, `ask_question`, bg terminals, cache-retention); para
   filhos in-process, `DefaultResourceLoaderOptions.noExtensions` + `extensionFactories` /
   `extensionsOverride`. Custo: precisa de uma lista curada + testes de paridade de tools;
   ganho: corta de uma vez 2.1-A, C, D e parte de E por processo filho.
   _Alternativa mais barata, 1 linha:_ `PI_SUBAGENT === "1"` como gate nas extensões caras
   (`git-info` no refresh por mutação, `remote-agents` no initialize, `browser` no import).
3. **Orçamento de startup medido.** Um teste/checagem que conta trabalho eager por extensão
   (I/O síncrono, spawn, leitura de diretório no import/factory/session_start) e falha acima de
   um limite. Sem isso, cada extensão nova paga em todos os processos e ninguém percebe.
4. **Convenção "nunca bloquear o loop" para persistência.** Proibir `Atomics.wait`/spin-lock no
   caminho de requisição; escrever com debounce + temp/rename assíncrono; ler com cache por
   `mtime`. Aplicar em `remote-agents/src/persistence.ts` primeiro.
5. **Telemetria de fase no `/perf`.** `perf_hooks.monitorEventLoopDelay` + contadores de spawn
   síncrono/assíncrono e de bytes re-wrapados por frame. Sem medir, as decisões de UI/perf viram
   preferência; com isso, os próximos cortes são óbvios.
6. **Padrão "política por modelo" (o que esta revisão criou no cache-retention).** Endpoints e
   catálogos divergem; uma extensão pequena que ajusta o payload por modelo, aprende com o 400
   e expõe o estado num comando é mais robusta que editar catálogo ou confiar em env global.
   Vale para futuros campos (reasoning, tools, sampling).

---

## 6. `pi-observational-memory`: vale adicionar?

Avaliação de `github.com/elpapi42/pi-observational-memory` v3.1.3 (MIT, `pi >= 0.81`), feita
por leitura do README, `docs/how-it-works.md`, `src/index.ts`, hooks e agentes. **Não instalei
nem executei** (é código de terceiros; ver riscos).

### O que ele faz, tecnicamente

- Publicado no npm como `pi-observational-memory@3.1.3` (MIT, 2026-09-16), sem dependências de
  runtime, só peer deps `@earendil-works/pi-*` — o pin por versão é limpo.
- Registra `turn_end` (observer/reflector/dropper), `agent_settled` (gatilho de compactação
  proativa), `session_before_compact` (render determinístico), `/om:status`, `/om:view` e a
  tool `recall`.
- A memória é um ledger de entradas custom na própria sessão (`om.observations.recorded`,
  `om.reflections.recorded`, `om.observations.dropped`), com watermark de cobertura por worker.
- Na compactação, o resumo é **renderizado sem chamada de modelo** quando há projeção; se a
  projeção estiver vazia, delega ao sumarizador nativo. É isso que torna a compactação rápida.
- Os workers são `agentLoop` **in-process** com uma tool de registro, modelo = modelo da sessão
  (ou o configurado em `observational-memory.model`), cap de turnos e de tokens.
- Pontos de qualidade: trata explicitamente o caso `opencode-go` (400 `MissingSessionID`)
  espelhando `x-opencode-session`/`x-opencode-client` (`src/hooks/consolidation-trigger.ts:120-145`),
  tem testes (vitest) para hooks, ledger, budget e erros de stream, e é "cache-friendly" por
  construção: **não toca no contexto entre compactações**.

### Encaixe no seu setup — o que eu olharia antes

1. **Filhos.** Não há gate de `PI_SUBAGENT` nem de `ctx.mode`: em cada worker Herdr (TUI) e em
   cada filho in-process (print) o OM roda observer/reflector/dropper e pode chamar
   `ctx.compact()` na sessão do filho. Isso significa chamadas de modelo extras por filho,
   compactação precoce dentro de workers e disputa de rate limit — exatamente onde suas sessões
   já sofreram limite de uso. _Mitigação pronta:_ `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` no env do
   worker (você controla o spec do `worker-launcher.mjs`); para filhos in-process o ideal é
   pedir/upstream um gate `ctx.mode === "tui"` (ou aplicar num fork).
2. **Modelo dos workers.** Default = modelo da sessão. No seu caso isso seria `gpt-6-astra`.
   Configure um modelo barato (`opencode-go/deepseek-v4-flash` ou `glm-5.3-flash`); a sinergia
   com a correção desta revisão é direta: o worker também passa pelo `before_provider_request`,
   então GLM não vai mais dar 400 por `prompt_cache_retention`.
3. **Chunk do observer.** Sem configurar, `observerChunkMaxTokens = floor(contextWindow × 0.2)`
   do modelo de memória — com um modelo de 1M de contexto isso é 200k tokens por rodada, a cada
   `observeAfterTokens` (default 10k) de crescimento. Defina explicitamente (~30-40k) para
   limitar entrada por rodada. Workers são conversas novas, sem cache: cada rodada paga prefill cheio.
4. **Threshold de compactação × sua política atual.** Hoje `compaction.reserveTokens: 120000`
   com modelos de 1M ⇒ compactação nativa só perto de ~880k (o limiar é `janela − reserva`;
   _aumentar_ a reserva antecipa a compactação). O default do OM é `compactAfterTokens: 81000`
   em modo `calibrated` — ~10× mais compactações do que você faz hoje. Em modo `ratio` com 0.5-0.68,
   fica em 500-680k num modelo de 1M. Isso é uma decisão de política, não um bug: se o objetivo é
   continuidade longa, comece alto; se é sessão ágil e prefill barato, comece baixo.
5. **Três camadas de memória.** Você já tem `summaries` (recap pós-run), `pi-hermes-memory`
   (`MEMORY.md`/`USER.md`) e `projects-memory` (por repositório). O OM é escopo-branch e existe
   para sobreviver à compactação — não substitui nem duplica os outros dois, mas passam a ser
   três fontes injetando contexto. Defina o papel de cada um e evite gravar os mesmos fatos em
   dois lugares.
6. **Custo por rodada, em ordem de grandeza.** Com chunk de 30k e modelo a US$0,15/M de entrada,
   cada observação custa ~US$0,005 + saída; com `observeAfterTokens: 10000` isso é ~US$0,0005
   por 1k tokens de sessão. Barato num modelo flash, caro no modelo da sessão.
7. **Riscos de terceiros.** A extensão roda com acesso total à sessão, lê o branch inteiro,
   escreve estado em `~/.pi/agent/observational-memory/` e usa clipboard no `/om:view`. Não é
   sandbox. Pinar a versão (`npm:pi-observational-memory@3.1.3`), e como `settings.json` é
   gitignored no seu repo, registrar a instalação no `SETUP.md` para não perder a reprodutibilidade.

### Veredicto

**Vale um teste limitado, não uma instalação global imediata.** O desenho ataca exatamente o
seu problema (compactação lenta e perda de coerência em cadeias de resumos) de um jeito que o
`summaries` + settings atuais não atacam, e é cache-friendly por construção. Os três riscos
reais no seu setup são de integração, não de mérito: (a) rodar em filhos, (b) threshold de
compactação incompatível com janelas de 1M, (c) modelo dos workers.

### Status: instalado globalmente e verificado (2026-09-18)

A pedido do usuário a instalação foi feita globalmente:

- `pi install npm:pi-observational-memory@3.1.3` (entra em `settings.json > packages`, código em
  `~/.pi/agent/npm/node_modules/pi-observational-memory`).
- Config global em `~/.pi/agent/settings.json > observational-memory`:
  modelo de memória `opencode-go/deepseek-v4.1-flash` (`thinking: low`, o mesmo dos subagentes —
  barato e já provado em loops com tools neste setup), `observerChunkMaxTokens: 30000`
  (sem isso o cap derivado seria 200k, porque o modelo de memória tem janela de 1M),
  `compactAfterTokensMode: "ratio"` com `compactAfterTokensRatio: 0.5`,
  `showWorkerNotifications: false`, `debugLog: false`.

**Smoke test ponta a ponta** (sessão real em `tmp/om-smoke`, modelo de sessão
`opencode-go/glm-5.3-flash`, worker `deepseek-v4.1-flash`, thresholds temporariamente em
100/200 para disparar na hora):

1. `~/.pi/agent/observational-memory/debug/<session>.ndjson` registrou
   `observer.start` → `observer.records` → `observer.appended` → `reflector.agent_start` →
   `reflector.result` → `dropper.waiting_for_reflection`.
2. O JSONL da sessão passou a conter entrada `om.observations.recorded` com observações reais,
   ids e `sourceEntryIds` (ex.: "User asked the assistant to read notes.txt, summarize it in one
   sentence, then say 'done'.").

Ou seja: a extensão carrega no processo pi, os workers rodam no modelo barato configurado
(inclusive passando pelo caminho que espelha `x-opencode-session` para o gateway opencode-go) e
o ledger é persistido na sessão. Thresholds e `debugLog` foram restaurados aos valores de
trabalho depois do teste; artefatos de debug removidos.

**Pendente:** nada bloqueante. O gate cobre os dois modos de filho (env nos workers
Herdr e filtro do resource loader nos filhos in-process). O que resta é a consolidação
dos dois caches de transcript e dos três sanitizadores duplicados, em andamento como
refatoração comportamento-idêntica.

Instalação e configuração também ficaram documentadas em
`SETUP.md > Observational memory (optional)`, já que `settings.json` é gitignored e a
instalação não ficaria registrada no repositório.

### Plano sugerido

1. **Projeto-piloto.** `pi install npm:pi-observational-memory@3.1.3 -l` num único repositório
   (instalação local ao projeto) com `.pi/settings.json`:
   `model` flash + `observerChunkMaxTokens: 30000`, `compactAfterTokensMode: "ratio"`,
   `compactAfterTokensRatio: 0.5`, `showWorkerNotifications: false`.
2. **Gate nos filhos** no mesmo passo: `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` no env dos workers
   Herdr — o ponto de inserção é o spec do launcher em
   `extensions/subagents/src/backends/herdr-worker.ts:1561-1566` (`{ PI_SUBAGENT_ASK_FILE: ... }`);
   decidir sobre filhos in-process (pedido upstream de gate por modo, ou patch mínimo).
3. **Medir antes/depois** numa sessão longa: latência da compactação, cache read ratio
   (`/perf` + `/om:status`), contagem de chamadas por sessão, RSS/event-loop delay enquanto
   roda um workflow.
4. **Promover ou descartar.** Se o ganho aparecer, promover ao global com a config documentada
   e o gate de filhos; se não, o custo de experimentar foi uma instalação local.

Se o objetivo imediato é só "compactação mais barata e menos frequente", um passo intermediário
sem terceiros é subir `reserveTokens` (antecipa a compactação) e dar orçamento de contexto por
papel de subagente — já previsto na entrega anterior como item adiado.

---

## 7. Estado das correções

Entrega desta revisão. Verificação final: `npx tsc --noEmit` limpo; suíte completa (77 arquivos de teste, sem `background-terminals` e `codex.test.ts`, que têm runners próprios) com apenas as 3 falhas pré-existentes de timing no Windows (`remote-agents/session-lifecycle.test.ts`); `background-terminals` 80 testes, 76 pass, 0 fail, 4 skips.

| Frente                                                                                                                    | Estado                 | Verificação                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Política de cache por modelo (`cache-retention`)                                                                          | aplicada               | 19 testes novos; reprodução do 400 e autocura confirmadas contra o endpoint real                                                                                                                     |
| `remote-agents` sob demanda + persistência sem bloquear o loop                                                            | aplicada               | suíte do pacote: 25 testes, 22 pass, 3 falhas pré-existentes (fake ssh no Windows); 8 testes novos                                                                                                   |
| `git-info` gate de filho + `browser` lazy import                                                                          | aplicada               | git-info 15 testes (1 falha pré-existente de spawn no Windows); browser 34 testes, 0 fail; integração real com Chromium passou                                                                       |
| `/ps` cache incremental + workflows por `mtime` + `model-info` incremental + `ask-user` por largura + widget sem `list()` | aplicada               | background-terminals 80 testes, 0 fail; workflows+model-info+ask-user 34 testes, 0 fail                                                                                                              |
| Helpers compartilhados (`shared/format.ts`, `shared/activity-status.ts`)                                                  | aplicada               | 16 testes novos; `context-utilization` passou a delegar para o formatter único                                                                                                                       |
| Convenções de UI (`docs/ui-conventions.md`)                                                                               | escrita                | referência para a wave 2, com teste de conformidade proposto                                                                                                                                         |
| Wave 2: superfície de subagentes (deltas, transcript, formatação, status, moldura)                                        | aplicada               | 127 testes do pacote, 0 falhas; 14 novos (buffer de delta, cache de transcript, tail-first)                                                                                                          |
| Wave 2: superfície remota/bg (status, moldura, jank do overlay)                                                           | aplicada               | remote 30 pass + 3 falhas pré-existentes; background-terminals 76 pass + 4 skips, 0 falhas                                                                                                           |
| Wave 2: workflows/summaries/ui-customization/perf/ask-user/kit/snippets/`/lg`                                             | aplicada               | 77 testes focados, 0 falhas; `shared/terminal-text.ts` novo como fonte única de sanitização                                                                                                          |
| `pi-observational-memory` global                                                                                          | instalado + smoke test | observações gravadas no ledger com o modelo barato; gate de filhos aplicado (ver 6)                                                                                                                  |
| Gate do OM nos filhos (env do worker Herdr + filtro do loader in-process)                                                 | aplicada               | asserção no spec do worker + teste do filtro por segmento de caminho                                                                                                                                 |
| Consolidação dos dois caches de transcript + 3 sanitizadores                                                              | aplicada               | primitivo único em `shared/ui/transcript-cache.ts` (7 testes); 3 sanitizadores passam por `shared/terminal-text.ts`, o que corrigiu 7 vazamentos reais de OSC/C1/CSI/DCS no transcript de subagentes |

## 8. Limites desta revisão

- As auditorias foram análise de fonte + testes de leitura; **não** houve benchmark de tempo de
  render, latência de compactação ou custo real de provider. Números citados são ordens de
  grandeza derivadas do código (ex.: "até 20 renders/s" vem do throttle de 50 ms em `ps.ts:430`).
- Perfis de execução variam: os piores casos de 2.1-A/B/D dependem de haver agentes remotos,
  filhos ativos e ferramentas mutantes. O que multiplica por processo é o custo que existe
  independentemente do uso (remote-agents, playwright, git-info).
- Não medi `~/.codex/sessions|rollouts` para decidir se o caso latente do Codex é real.
- A avaliação do `pi-observational-memory` é por leitura de código no que diz à extensão;
  o smoke test reproduziu apenas o caminho de memória (observer/reflector gravando no ledger),
  não a compactação proativa nem uma sessão longa.
- **Entrega do prompt inicial em workers Herdr: investigada e corrigida.** Ver a seção 9.
- Formatação: `npm run format:check` continua falhando em arquivos que já estavam sujos antes
  desta revisão; só os arquivos alterados aqui foram formatados.

## 9. Entrega do prompt inicial em workers Herdr (investigação)

Sintoma: `subagent_spawn` criava o pane, o filho ficava com **zero turnos e nenhum session file**
(2 de 6 spawns numa sessão: `sa-3`, `sa-4`), e o run falhava com
`Pi worker initial prompt made no observable first turn after an Enter-only retry (Herdr state:
working); the worker remained at zero turns`.

### Forense

- `sessions/workers/01a0b44d-.../sa-3` e `sa-4` existiam **vazios** (sem `.jsonl`), enquanto
  `sa-1`/`sa-2` tinham sessões de ~900 KB. O arquivo de sessão só nasce na primeira mensagem do
  usuário, então o prompt nunca foi submetido. Nenhum pane órfão ficou para trás (os dois panes
  foram fechados pelo caminho de falha) e o `Herdr state: working` do erro é auto-infligido: o
  próprio pai reporta `working` logo após enviar o Enter.

### Reprodução e medições (panes reais, mesmo caminho de produção)

| Caso                                                 | Resultado                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| texto de 500 / 2000 / 4000 / 4500 chars (1 linha)    | chega inteiro no editor                                                                                                                       |
| texto de **8000 chars** (1 linha)                    | **some por completo** (`pane send-text` retorna 0)                                                                                            |
| prompt real de **4527 chars / 30 linhas**            | **chega truncado** (cabeça presente, última linha ausente) e o Enter não submete                                                              |
| envio ~0,4 s após `pane run` (antes do TUI desenhar) | texto **parcialmente consumido**: o modelo recebeu só `ta gamma` de `IMMEDIATE-MARKER alpha beta gamma` — fragmento submetido **em silêncio** |
| `pane send-text` com `                               |
| `                                                    | o newline age como **Enter**: `M1-alfa                                                                                                        |
| M2-bravo`submeteu apenas`M1-alfa`                    |
| spawn real de probe durante a investigação           | caiu no **fallback in-process silencioso** (nenhuma chamada `herdr` no server log, nenhum pane, nenhum session dir)                           |

Conclusão: o transporte `pane send-text` + `pane send-keys enter` **não é confiável para o
tamanho/forma dos prompts reais** e o pai não verificava nada — nem se o texto chegou ao editor,
nem se o que foi submetido corresponde ao pedido. Daí as três manifestações: zero turnos, prompt
truncado submetido em silêncio, e fallback silencioso para in-process.

### Correção

Em `extensions/subagents/src/backends/herdr-worker.ts` (mesma sessão de trabalho):

1. **Retentativa com o texto completo** na fase 2 do watchdog. Antes era só Enter; como nada foi
   submetido (não existe `UserMessage`), reenviar o prompt inteiro é seguro e recupera a entrega
   perdida em vez de matar o worker.
2. **Verificação do que foi submetido**: quando o primeiro `UserMessage` aparece, o texto é
   comparado com o que foi enviado (tolerando `

` e espaços nas pontas). Divergência ⇒ run
   falha com diagnóstico explícito, em vez de deixar o filho trabalhar num fragmento.
3. **Fallback visível**: a falha do caminho Herdr deixa de ser engolida em silêncio
   (`src/backends/pi.ts`), para que "rodou in-process" apareça com o motivo.

O watchdog ficou em **três fases bounded**: (1) espera a submissão inicial; (2) se nada apareceu,
pressiona **só Enter** — o texto já está no editor e um reenviar duplicaria o prompt; (3) se ainda
nada foi submetido (logo, nada duplica), reenvia o **prompt completo** + Enter e só então falha.
Assim os três casos de produção têm desfecho correto: Enter perdido ⇒ recupera sem reenviar;
texto perdido/truncado no transporte ⇒ recupera no reenvio; fragmento submetido ⇒ falha com
diagnóstico de contagem.

Testes de regressão no harness falso (sem Herdr real): Enter perdido ⇒ 1 `sendText` + 2 `enters` e
run completa; texto perdido ⇒ 2 `sendText` (mesmo conteúdo) + 3 `enters` e run completa;
fragmento submetido ⇒ falha com diagnóstico, 1 `sendText`, sem reenvio; submissão intacta ⇒ sem
reenvio. Suíte de `extensions/subagents`: **133/133**, `tsc` limpo.

### Limitação remanescente (documentada, não corrigida)

Prompts muito grandes estão na faixa de risco medida: 4500 chars chegam inteiros, **8000 chars
podem sumir** e um prompt real de 4527 chars já chegou truncado. Com a verificação nova, isso
deixa de ser silencioso (falha com N vs M) e o reenvio recupera quando nada foi submetido — mas
a correção de raiz para prompts grandes é **entregar em chunks** (ex.: blocos de 1-2 KB com
pequeno intervalo, verificação do sufixo antes do Enter). Fica como follow-up se o caso aparecer
com frequência.
