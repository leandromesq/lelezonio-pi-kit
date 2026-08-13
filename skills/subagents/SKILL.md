---
name: subagents
description: delegate work to subagents — use when the user asks to use subagents or when following AGENTS.md orchestrator mode (default delegation of reads, discovery, and changes)
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

Per AGENTS.md (orchestrator mode), the parent session is the orchestrator running a big model (`openai-codex/gpt-5.6-sol` at `high` thinking). All delegated work goes to Pi subagents on opencode-go models only (`deepseek-v4-pro` or `deepseek-v4-flash`); never spend the OpenAI models on subagents — except the capability fallback below.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when no named profile fits and the user does not request another harness. The configured Pi default is `opencode-go/deepseek-v4-pro` with `max` thinking; explicit spawn fields can override it. All profiles run on Pi — subagents exclusively use opencode-go models.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Capability fallback + explicit request only.** Not used for subagents by default; subagents stay on opencode-go. Use Codex when:
- the user explicitly requests a Codex subagent or an OpenAI model, or
- the task needs tools the pi harness or its subagents lack, e.g. vision/image input (`deepseek-v4-flash` and `deepseek-v4-pro` have no vision) or MCP servers (pi has no MCP).

In the fallback case, spawn with `harness: codex`, `model: gpt-5.6-luna`, `reasoning_effort: max`. The main orchestrator session already runs the big OpenAI model (`gpt-5.6-sol`).

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `max`              |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, and preferably a matching `profile`. Optional `harness`, `working_dir`, `model`, and `reasoning_effort` fields override configured values. The current profiles in `~/.pi/agent/subagents.json` are:

| Profile    | Harness | Model                           | Thinking | Use for                             |
| ---------- | ------- | ------------------------------- | -------- | ----------------------------------- |
| `planner`  | Pi      | `opencode-go/deepseek-v4-pro`   | `max`    | difficult planning and architecture |
| `coder`    | Pi      | `opencode-go/deepseek-v4-flash` | `max`    | implementation                      |
| `reviewer` | Pi      | `opencode-go/deepseek-v4-pro`   | `max`    | review and research                 |

All profiles run on Pi with opencode-go models, so subagents normally never touch the OpenAI subscription — the codex capability fallback above is the exception. At most three subagents run concurrently.

`workflow`/ultracode children inherit the session model by default. Since the orchestrator session runs an OpenAI model, always pass an explicit opencode-go model or named profile to `agent()` calls — otherwise the "never spend OpenAI on subagents" rule is silently violated.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
