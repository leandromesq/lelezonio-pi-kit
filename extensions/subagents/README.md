# Subagents extension

Delegates work to autonomous background subagents with their own context
windows. Two real backends — **pi** (in-process `AgentSession`) and **codex**
(`codex app-server` JSON-RPC, or a native Codex TUI in a Herdr pane) — behind
one normalized manager, plus native Herdr panes when available.

## Tools (model-facing)

| Tool                               | Purpose                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `subagent_spawn`                   | Fire-and-forget background subagent (profile/harness/model/working_dir). Result auto-delivered on settle.                      |
| `subagent_send`                    | Address a subagent by **id or friendly name**: steers a running one, resumes a settled one. Answer child questions with this.  |
| `subagent_wait`                    | Block until the listed subagents settle, return their outputs (consumes automatic delivery for exactly those run generations). |
| `subagent_cancel`                  | Abort running subagents; preserves partial transcripts.                                                                        |
| `subagent_check` / `subagent_list` | Inspect one / list all, non-blocking.                                                                                          |

`/subagents` opens the dashboard + full takeover UI (`/btw` is a managed
one-off side agent; in Herdr it runs as a tracked native worker).

## Profiles — `~/.pi/agent/subagents.json`

Profiles define the spawn policy the model can choose by name:

| Field                          | Meaning                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`, `model`, `thinking` | Backend, model, reasoning effort.                                                                                                                                                                                                                              |
| `systemPrompt` / `promptFile`  | System prompt injected above the task (`promptFile` is relative to the agent dir). Exactly one may be set.                                                                                                                                                     |
| `tools`                        | Explicit pi tool allowlist (builtin names: `read write edit bash grep find ls`). Everything not listed is excluded.                                                                                                                                            |
| `readOnly`                     | Removes write/edit/bash and forces Codex sandbox `read-only` regardless of project trust.                                                                                                                                                                      |
| `allowChildren` + `maxDepth`   | Constrained nesting: the child may spawn only these profiles, at most `maxDepth` deep (top level = 0). Nesting-capable children run **headless** (the child's `subagent_spawn` is an in-process callback). Default `maxDepth` = 1 when `allowChildren` is set. |
| `contextMode`                  | `standalone` (default) or `summary` (prepends a compact parent-session context frame).                                                                                                                                                                         |
| `cwd`                          | Default working directory for this profile (resolved relative to the caller's cwd); the model's explicit `working_dir` overrides it.                                                                                                                           |

Profiles can also be shipped **per project**: a `.pi/subagents.json` in the
project root overlays the global config (same schema, project wins by profile
name; resolved from the caller's cwd).

Example (this setup):

```json
{
  "planner": { "harness": "codex", "readOnly": true, "contextMode": "summary" },
  "coder": { "harness": "pi", "allowChildren": ["reviewer"], "maxDepth": 1 },
  "reviewer": {
    "harness": "codex",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls"]
  }
}
```

## Child→parent questions

Every pi child gets `ask_question` (headless: an in-process custom tool that
emits `QuestionAsked`; Herdr children: a `PI_SUBAGENT_ASK_FILE` sidecar the
parent worker polls). The unanswered question is folded into the snapshot
(`snap.question`), shown with ❓ in the footer and `/subagents`, embedded in
the delivered result (`Answer it with subagent_send(...)`), and cleared when
the child is resumed with the answer.

## Stalled detection

A `running` subagent with no event for 90s shows `stalled` in the dashboard
and a `◔ n stalled` footer badge (refreshed on a 20s ticker); purely derived
from `snap.lastEventAt`.

## Restored sessions

On `session_start`, persisted children of a previous pi session (same parent
id, under `sessions/workers/`) are re-adopted as **inspect-only** entries
(dashboard, `subagent_check`). Resume after a restart is not wired for
restored entries — `subagent_send` explains taking over in a pane instead.

## Trust

Children inherit the parent's project-trust decision:

- pi: project resources are gated by `projectTrusted`; read-only profiles get
  a narrowed tool surface.
- codex: untrusted directories run `sandbox: read-only`; read-only profiles
  force read-only even when trusted.

## Reliability model

- Settlements are delivered once, FIFO, keyed by `id:runGeneration` — a
  session that runs multiple turns never overwrites an undelivered result.
- `wait`/`cancel` consume exactly the run generations they return; aborted
  waiters leave results queued for automatic delivery.
- Delivered results are immutable `structuredClone` snapshots.

## Tests

`npm run check` (tsc) and `npm test` (node:test) cover the manager lifecycle,
run-generation delivery, trust/codex policy, Herdr worker lifecycle
(launcher spec, resume, takeover, ask sidecar), naming, profiles, and the
pure policy helpers.
