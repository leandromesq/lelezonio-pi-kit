# Plano de correções — performance e lifecycle Pi

## Restrições

- Preservar alterações preexistentes; não fechar workspaces do usuário nem recarregar sessões ativas.
- Não trocar modelos, instalar versões novas de dependências ou alterar compactação sem benchmark.
- Usar testes com runners falsos: não executar tarefas de modelo para medir desempenho.

## Entrega atual

1. **Ownership Herdr e observadores**: retenção de recursos em close incerto, coordenação de abertura/fechamento, attachment de observador fora do caminho crítico de `bg_start`, shutdown/takeover tratados e regressões.
2. **Política de children**: allowlist consistente em backend in-process e Herdr, inclusive PowerShell e ferramentas de extensões; fresh/resume equivalentes, mantendo perguntas e nesting autorizado.
3. **Naming**: nome fornecido pelo chamador evita descoberta/auth/chamada ao modelo.
4. **Git display**: sem polling em headless; intervalo de 15 s em TUI; debounce de 500 ms; ferramentas de leitura não disparam refresh.
5. **Resultados**: copiar apenas o registro necessário para entregar resultados, sem clonar o transcript inteiro.
6. **Documentação**: corrigir roteamento documentado e registrar limitações remanescentes.

## Validação

- Typecheck; testes focados por frente; regressões de naming, refresh e entrega.
- Formatação somente dos arquivos alterados; nenhuma reformatação global.
- Suíte geral com limite externo e registro explícito das falhas preexistentes de Windows.
- Revisão de integração do diff antes de concluir.

### Validação executada na retomada

| Verificação                                  | Resultado                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run check` (tsc)                        | passa                                                                                              |
| Testes focados das frentes corrigidas        | 133/133                                                                                            |
| `extensions/shared/*.test.ts`                | 66 testes de workspace Herdr passam (shutdown, sibling não confirmado, close incerto, recuperação) |
| Pacote `background-terminals`                | 70 passam, 4 ignorados (plataforma), 0 falhas                                                      |
| Pacote `subagents`                           | passa                                                                                              |
| Suíte suplementar (`--test-force-exit`, 424) | 419 passam, 1 ignorado, 4 falhas **preexistentes** (ver abaixo)                                    |
| `npm test` completo                          | não termina neste Windows; processo encerrado por limite externo de 300 s                          |
| Formatação                                   | arquivos alterados limpos; 4 arquivos já sujos antes da auditoria seguem sujos                     |

Falhas preexistentes, em arquivos **não modificados** por esta entrega:

- `extensions/git-info/process.test.ts`: o caso de falha excede o timeout de
  1 s do spawner no Windows (`-1 !== 7`). `process.ts` e o próprio teste não
  foram alterados; é sensível ao tempo de startup de processo.
- `extensions/remote-agents/session-lifecycle.test.ts`: 3 casos falham com
  "Timed out waiting for fake ssh to start" no Windows.
- `scripts/test.mjs` não passa `--test-force-exit`, então a suíte completa fica
  pendurada após essas falhas em vez de encerrar.

Na revisão de integração foram encontrados dois caminhos reais que ainda
perdiam ownership, ambos corrigidos com teste de regressão que falha na
versão anterior:

1. `dropCategory` na recuperação de categoria descartava panes irmãos ainda
   possivelmente vivos, permitindo esquecer o workspace depois; agora só os
   ids do tab/root mais recente são invalidados, mantendo os panes rastreados.
2. `dropWorkspace` limpava o estado antes do close e ignorava o resultado,
   esquecendo um workspace cujo teardown não foi confirmado; agora só libera
   ownership com close confirmado e não recria nada ao lado de um workspace
   possivelmente vivo.

Além disso, um close de workspace anterior que continue não confirmado agora
impede a criação de um workspace substituto (o registro fica retido em vez de
ser descartado), `forgetPaneLessWorkspace` não libera ownership durante um
dispose em andamento, e o root pane de um tab reconstruído passa a ser
rastreado. As retentativas de close de workspace são uma por chamada explícita
(sem limite vitalício), então um transporte que se recupera volta a confirmar
o close em vez de bloquear a criação de workspaces para sempre.

Limitação de escopo do cleanup de workspace: o ownership é local ao processo.
Se o processo encerrar com um `workspace close` não confirmado, o registro de
retentativa morre junto e o workspace pode permanecer no Herdr; reconciliação
persistente após crash continua fora desta entrega.

## Retomada da entrega interrompida

A sessão original `01a0af40-d73f-76e7-aae1-ac92acd7449c` recebeu os resultados
concluídos das duas frentes de implementação, mas atingiu o limite de uso do
provedor antes da revisão final. As duas tentativas de continuação seguintes
foram abortadas; isso não estabelece uma falha de compactação como causa.

Na retomada, o usuário escolheu **concluir somente a entrega interrompida**:
fechar pendências de lifecycle, documentação e verificação. Não autorizou
ampliar o trabalho para os itens adiados abaixo.

A verificação inicial da retomada confirmou typecheck, 133 testes focados e
70 testes de background terminals passando (4 ignorados na plataforma).
Identificou ainda a perda de ownership quando o fechamento final do workspace
falhava, além de documentação antiga sobre roteamento, allowlists e resultados.

Alterações anteriores à auditoria em `background-terminals/src/manager.ts`,
`manager.test.ts`, `src/prompt.ts` e `prompt.test.ts` foram preservadas; suas
diferenças de formatação não são atribuídas a esta entrega.

## Não incluído automaticamente nesta entrega

- Redesenho de workflows/dashboard e caching de resource loaders: requer testes de lifecycle/trust próprios.
- Orphan reconciliation persistente após crash e telemetria completa por fase.
- Loadouts mínimos de extensões: primeiro garantir restrição de ferramentas sem remover instruções de projeto ou extensões essenciais.
- Ajustes de esforço/contexto: benchmark A/B de qualidade, latência e retrabalho antes de mudar defaults.
- Upgrade SDK: alinhamento deliberado das instalações, sem atualização sob sessões ativas.
