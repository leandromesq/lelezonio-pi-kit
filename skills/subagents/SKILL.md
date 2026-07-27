---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when no named profile fits and the user does not request another harness. The configured Pi default is `opencode-go/kimi-k3` with `max` thinking; explicit spawn fields can override it.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Configured default:** `gpt-5.6-sol` with `high` effort. Prefer the `planner` profile when this is the intended combination, and reserve Codex for work that benefits from it to conserve subscription limits.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `high`             |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, and preferably a matching `profile`. Optional `harness`, `working_dir`, `model`, and `reasoning_effort` fields override configured values. The current profiles in `~/.pi/agent/subagents.json` are:

| Profile    | Harness | Model                         | Thinking | Use for                             |
| ---------- | ------- | ----------------------------- | -------- | ----------------------------------- |
| `planner`  | Codex   | `gpt-5.6-sol`                 | `high`   | difficult planning and architecture |
| `coder`    | Pi      | `opencode-go/deepseek-v4-pro` | `max`    | implementation                      |
| `reviewer` | Pi      | `opencode-go/kimi-k3`         | `max`    | review and research                 |

Prefer `coder` and `reviewer` where appropriate to conserve Codex subscription usage. At most three subagents run concurrently.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
