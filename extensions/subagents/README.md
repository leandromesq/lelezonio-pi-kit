# Subagents extension

Delegates work to autonomous background subagents with their own context
windows. Two backends share one normalized manager: **pi** (a native Pi TUI
in a Herdr pane when available, otherwise an in-process `AgentSession`) and
**codex** (a native Codex TUI in Herdr, otherwise `codex app-server` JSON-RPC).
Nesting-capable Pi children stay in-process so their constrained spawn bridge
can call the parent manager.

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
| `tools`                        | Explicit Pi tool allowlist covering builtin, extension, and custom tools. Unlisted tools are excluded; `ask_question` and an authorized nesting bridge are added intentionally.                                                                                |
| `readOnly`                     | Defaults to a Pi allowlist of `read,grep,find,ls` (overridden by explicit `tools`, plus the question/authorized nesting bridge), blocking PowerShell and other unlisted tools. Forces Codex sandbox `read-only` regardless of project trust.                   |
| `allowChildren` + `maxDepth`   | Constrained nesting: the child may spawn only these profiles, at most `maxDepth` deep (top level = 0). Nesting-capable children run **headless** (the child's `subagent_spawn` is an in-process callback). Default `maxDepth` = 1 when `allowChildren` is set. |
| `contextMode`                  | `standalone` (default) or `summary` (prepends a compact parent-session context frame).                                                                                                                                                                         |
| `cwd`                          | Default working directory for this profile (resolved relative to the caller's cwd); the model's explicit `working_dir` overrides it.                                                                                                                           |

Profiles can also be shipped **per project**: a `.pi/subagents.json` in the
project root overlays the global config (same schema, project wins by profile
name; resolved from the caller's cwd).

This setup defaults all named profiles to the Pi harness. Override a spawn to
the Codex harness only when the task requires tooling unavailable in Pi, such
as an MCP integration exposed by Codex CLI.

Example (this setup):

```json
{
  "planner": {
    "harness": "pi",
    "model": "opencode-go/deepseek-v4.1-flash",
    "thinking": "high",
    "readOnly": true
  },
  "coder": {
    "harness": "pi",
    "model": "opencode-go/deepseek-v4.1-flash",
    "thinking": "high",
    "allowChildren": ["reviewer"],
    "maxDepth": 1
  },
  "reviewer": {
    "harness": "pi",
    "model": "opencode-go/deepseek-v4.1-flash",
    "thinking": "high",
    "readOnly": true
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

Explicit `tools` is an authoritative capability grant, even with `readOnly`:
only include tools appropriate for the intended restriction.

Pi tool policy is identical for fresh and resumed workers. Default coder
profiles keep ordinary tools but exclude parent orchestration; narrowed
profiles use an explicit allowlist. **This is not an OS sandbox:** trusted
extensions still load and execute code. Project trust is unchanged.

## Reliability model

- Settlements are delivered once, FIFO, keyed by `id:runGeneration` — a
  session that runs multiple turns never overwrites an undelivered result.
- `wait`/`cancel` consume exactly the run generations they return; aborted
  waiters leave results queued for automatic delivery.
- Delivered results copy only the settled run's notification fields; the full
  transcript is neither cloned nor retained by the delivery queue.

## Remaining limits

- Tool allowlists do not reduce extension discovery/loading. Minimal per-role
  extension bundles and workflow-child loadouts remain follow-up work.
- Read-only profiles currently have no dedicated Git status/diff tools; they
  also do not automatically gain `rg`/`fd` extension tools.
- Native Herdr launch/resume policy is regression-tested with injected
  runners; this delivery does not claim an end-to-end live-TUI benchmark.
- Context/compaction settings, model effort, and SDK versions are unchanged.

See [the delivery record](../../docs/reviews/2026-09-17-pi-fix-plan.md)
and [Herdr lifecycle documentation](../../docs/takeover-herdr.md).

## Tests

`npm run check` (tsc) and `npm test` (node:test) cover the manager lifecycle,
run-generation delivery, trust/codex policy, Herdr worker lifecycle
(launcher spec, resume, takeover, ask sidecar), naming, profiles, and the
pure policy helpers.
