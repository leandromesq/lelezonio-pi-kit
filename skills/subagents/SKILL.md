---
name: subagents
description: delegate work to subagents — use when the user asks to use subagents, or when a subtask is independent, complex, long, or parallelizable enough to justify a child agent
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

The main agent executes small tasks directly: targeted reads, simple edits, and integration. Delegate only what is really worth a child — independent, complex, long, or parallelizable subtasks — and critically review delegated results before integrating.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Default:** Spawns without a named profile run on `pi` by default. The configured Pi default is `opencode-go/gpt-5.6-luna` with `max` thinking; explicit spawn fields and named profiles override it. The `coder` profile (implementation) runs on `opencode-go/deepseek-v4-flash` at `high`.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Use:** The `planner` and `reviewer` profiles run on Codex (`gpt-5.6-luna`). Use Codex whenever the task suits it — including work the pi harness lacks tools for, e.g. vision/image input (`deepseek-v4-flash` has no vision) or MCP servers (pi has no MCP) — or when the user explicitly requests it.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `max`              |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, and preferably a matching `profile`. Optional `harness`, `working_dir`, `model`, and `reasoning_effort` fields override configured values. The current profiles in `subagents.json` are:

| Profile    | Harness | Model                           | Thinking | Use for                             |
| ---------- | ------- | ------------------------------- | -------- | ----------------------------------- |
| `planner`  | Codex   | `gpt-5.6-luna`                  | `max`    | difficult planning and architecture |
| `coder`    | Pi      | `opencode-go/deepseek-v4-flash` | `high`   | implementation                      |
| `reviewer` | Codex   | `gpt-5.6-luna`                  | `high`   | review and research                 |

Codex runs the planning and review profiles; Pi runs implementation, and profile-less spawns default to the `pi` harness. At most three subagents run concurrently.

`workflow`/ultracode children inherit the session model by default — pass an explicit model or named profile to `agent()` calls so each child matches the profile you intend instead of silently inheriting.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
