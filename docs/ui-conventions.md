# Convenções de UI das extensões

Referência para qualquer superfície visível de uma extensão (`render` de overlay, mensagem
custom, status line, widget, cartão de comando). Nasceu da revisão de 2026-09-18
(`docs/reviews/2026-09-18-extensions-review.md`, seções 3 e 4). Objetivo: abrir `/subagents`,
`/ps`, `/workflows`, `/remotes` e `/lg` lado a lado e parecer o mesmo produto.

## 1. Molduras

| Uso                                                          | Estilo                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Painel em fluxo (lista + detalhe dentro do mesmo overlay)    | caixa `╭─╮ │ ╰─╯` na cor `border`, título na borda superior                        |
| Overlay transitório (relatório de `/perf`, `/cache`, `/kit`) | regra de largura total (`─`) na cor `borderAccent` + linha de título própria       |
| Sem moldura                                                  | só quando o conteúdo ocupa a tela inteira e não tem cabeçalho (ex.: picker nativo) |

Proibido: `accent` ou `borderMuted` como cor de moldura; misturar `┌┐└┘` com `╭╮╰╯`; título
dentro da borda em um lugar e como primeira linha do corpo em outro.

## 2. Cabeçalho, contagem e chrome

- Primeira linha: `{Título}` em `accent` + `bold`; contagem/estado à direita na mesma linha,
  `dim` (ex.: `/subagents` → `subagents · 2/5`).
- Última linha: hints em `dim`, separador `·`.
- Cabeçalho e hint são calculados com `truncateToWidth(..., width)` — nunca `slice`.

## 3. Glifos

| Glifo     | Significado                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------- |
| `■`       | estado: `warning` = rodando, `success` = concluído, `error` = falhou, `muted` = morto/desconhecido |
| `❯`       | item selecionado                                                                                   |
| `✓` / `✗` | resultado de uma ação (mensagem), nunca em coluna de lista                                         |
| `…`       | truncagem e continuação                                                                            |
| `—`       | separador decorativo de título, com moderação                                                      |

Sem emoji em linhas de coluna fixa (`❓` → `?`); nada de `x` como marcador de falha.

## 4. Cores (papéis, não cores literais)

| Papel                                    | Papel do tema                                            |
| ---------------------------------------- | -------------------------------------------------------- |
| Título / destaque de comando             | `accent` (+ `bold` no título)                            |
| Cabeçalho de bloco, rótulo               | `muted`                                                  |
| Meta, hint, contagem, caminho secundário | `dim`                                                    |
| Sucesso, aviso, erro                     | `success`, `warning`, `error`                            |
| Diff                                     | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`    |
| Seleção                                  | `selectedBg` (nunca `customMessageBg`)                   |
| Borda                                    | `border` (painel) / `borderAccent` (overlay transitório) |

Nunca hardcodar escape ANSI: sempre `theme.fg`/`theme.bg`.

## 5. Estados vazios e de erro

- Vazio: `(no X yet)` em `dim`, indentado como o conteúdo que substitui.
- Erro: `error: {mensagem}` em `error`, minúsculo, uma linha (`oneLine` + `truncateToWidth`).
- Carregando/lento: `…` no fim da linha de estado, sem bloco novo.
- Falha que o usuário precisa saber mas não interrompe o trabalho: `ui.notify(msg, "warning")`;
  nunca `console.error` (escreve por cima do alt-screen).

## 6. Números e tempo

- Tokens: um único formatter (`shared/context-utilization.ts`), sem `M`/`m` divergentes.
- Custo: `$x.xx` no footer e nas listas; `$x.xxxx` só em detalhe explícito.
- Duração: `shared/format.ts` (a ser extraído) — a mesma frase para o mesmo estado
  (`running 3m12s`, `exit 0 · 12s`, `2m ago`).
- Percentual: inteiro no footer/status, uma casa decimal só em detalhe.

## 7. Altura e viewport

- Toda viewport: `viewportRows(tui.terminal.rows, chrome, min)` e `sliceViewport(items, offset, capacity)`
  (`extensions/shared/ui/viewport.ts`).
- A altura da viewport **não pode mudar entre frames**: reservar a banda máxima e preencher com
  linhas vazias; notas e status de scroll contam dentro da viewport.
- Overlay de altura variável (lista → detalhe) fixa a banda máxima dos dois modos para não
  "pular" ao navegar.

## 8. Contrato de cache de render

Qualquer transformação histórico → linhas deve ser memoizada por **(revisão, largura, tema)** e
invalidada por `invalidate()`. O padrão de referência é
`extensions/background-terminals/src/ui/output-view.ts` (`createOutputLineCache`), e o alvo é que
um chunk novo custe O(chunk), não O(buffer). Contra-exemplo a evitar:
`ask-user/index.ts` (cache sem largura).

## 9. Status line versus widget

- **Status line** (`ui.setStatus`) para estado de orquestração assíncrona que o usuário consulta
  quando quiser: subagentes, workflows, remotos, recaps. Formato único via
  `shared/activity-status.ts`: `{label}: ■ n running · ■ n done · /{cmd} to view`.
- **Widget** acima do editor só para estado que **exige ação** e desaparece sozinho (ex.: “N bg
  terminals running • /ps to view” — com o separador padrão `·`).
- Nunca os dois para a mesma informação.

## 10. Mensagens custom

Cartão com moldura e rótulo, como o recap de `/summary`
(`Box(1, 1, customMessageBg)` + `✦`/label em `customMessageLabel` + `customMessageText` no
corpo). Resultado de subagente, bg terminal e agente remoto seguem o mesmo envelope; texto pelado
fica indistinguível da resposta do modelo.

## 11. Idioma

Todo texto de UI, descrição de comando/ferramenta e mensagem de erro em **inglês**. Exceção:
conteúdo do usuário ou do modelo (recap, respostas) não é traduzido.

## 12. Como verificar (teste de conformidade)

Um teste que varre `extensions/**/*.ts` e falha nos padrões proibidos:

- `console.error` em arquivo de UI de extensão;
- `\u001b` / `\x1b` literal fora de `shared/`;
- `truncateToWidth(` sem terceiro argumento quando o texto pode conter `…` (heurística: exigir
  elipse explícita em overlays);
- `Math.floor(rows *` / `rows - 9` fora de `shared/ui/viewport.ts`;
- `"customMessageBg"` em borda/realce de seleção;
- texto de UI em português (lista de palavras: `Revisar`, `concluída`, `nenhum`, `falhou`).

Os quatro primeiros são mecânicos e de baixo falso-positivo; os dois últimos exigem uma lista
curta e revisão humana quando falharem.
