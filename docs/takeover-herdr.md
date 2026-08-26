# Workers, take-over, and tails in Herdr

When this Pi session runs inside Herdr (`HERDR_ENV=1`), all extensions route
their observable work through one shared ephemeral
`Pi Workers · <project> · <short-session>` workspace (created lazily with
`--no-focus`; the first requested category claims the workspace's initial
tab/root pane, the second gets a `tab create`). Everything is opened with an
explicit `pane run` launch command — never `agent start`, which fails for npm
shims on Windows — and panes are reported to Herdr as agents
(`pane report-agent` + `agent rename`) so they show lifecycle state and can be
focused/prompted/keystroked by pane id.

- **Subagents** (`/subagents`): Pi and Codex children spawn as real
  interactive TUIs in the Subagents tab. Take-over focuses the live pane
  (running, never interrupting) or reopens + resumes the exact native session
  (settled, `pi --session <path>` / `codex resume <id>`).
- **Background terminals** (`/ps`): a watcher pane in the Terminals tab tails
  the terminal's spill files with a plain shell command
  (`Get-Content -Wait` / `tail -F`); the extension keeps sole ownership of the
  process.
- **Remote agents** (`/remotes`) keep their in-session overlay (native remote
  takeover is deferred).
- **By-the-way agents** (`/btw`) use the same managed Pi backend as normal
  subagents. Inside Herdr they run as tracked native workers with `btw-N` ids,
  concurrency accounting, settlement delivery, cancellation, takeover, and
  session cleanup; outside Herdr they fall back to the in-process Pi backend.

Outside Herdr — or whenever the workspace/pane cannot be opened — every path
falls back to the exact in-session behavior used before (in-process Pi SDK /
`codex app-server` subagents, terminal overlay, remote overlay).

## Subagents as native interactive TUIs

### Launch

The manager pre-allocates the logical id (`sa-N` / `btw-N`) **before** the
backend spawn so pane titles and technical names are deterministic:

- Pane title: `[sa-N · <profile|backend>] <title>`.
- Technical agent name: `p-<parent-session-prefix>-sa-N` — collision-safe
  across parent sessions, matching Herdr's `[a-z][a-z0-9_-]{0,31}` grammar.

Launch commands never carry the worker's real argv on the pane command line.
The parent writes a **transient launcher spec** (raw JSON argv — spaces,
unicode, apostrophes, quotes are byte-exact inside JSON) under
`<agentDir>/tmp/worker-specs/`, and the pane runs only
`node <launcher> <spec.json>` (extensions/shared/worker-launcher.mjs, a
zero-dependency Node program that `spawn`s the exact argv with inherited
stdio). Quoted argv through Herdr/PowerShell Start-Process mangles arguments
(live-proven: `--name '[spike · pi] native'` fragmented into positional
prompt fragments), which is exactly why the pane line is minimized. The spec
carries `PI_SUBAGENT=1` in the child env, and the launcher deletes the spec
right after reading it (the session finalizer cleans leftovers). Pi children
also receive `PI_SUBAGENT_ASK_FILE` pointing at a sidecar next to their
private session: the `ask_question` tool (headless children get it via
`customTools`, Herdr children via the extension when `PI_SUBAGENT=1`) writes
`{questionId,text}` there, the parent worker polls/dedupes it into a
`QuestionAsked` event, and the parent answers with `subagent_send`. Pi's initial
prompt is submitted with the low-level transport
`pane send-text <pane> <text>` then `pane send-keys <pane> enter` after the
TUI boots (retried only while the pane is busy). Codex receives its initial
marked prompt as the native TUI's positional argv from inside the JSON spec;
this avoids losing input while Codex initializes its alternate screen.
`agent prompt` is never used — live-proven to fail for
manually reported explicit-node Pi agents
(`agent_not_ready: no longer pane foreground process`).

Pi sessions persist under the normal agent sessions tree —
`<agentDir>/sessions/workers/<parent session>/<sa-id>` — and are **never**
deleted on scope close or manager prune, so children stay discoverable and
resumable (`/subagents` take-over reopens with `pi --session <path>`). One
child self-gate: the summaries extension disables itself when `PI_SUBAGENT=1`
(a recap inside a child is unorchestrated extra model activity that races the
pane closing); other child extensions stay available, and tools were already
excluded at launch.

### Pi discovery and parsing

Session discovery is deterministic: the parent generates a native session
UUID and passes `--session-id <uuid>` plus a **persistent per-agent
`--session-dir`** under `<agentDir>/sessions/workers/<parent>/<sa-id>` (the
same tree normal sessions live in; stale files from a crashed parent can
never hijack the watch because discovery checks our fresh session id). The
launch also carries `--name`, the model, the thinking level, the project
trust flag, and the child tool denylist (`subagent_*`, `workflow`,
`ask_user`). The session JSONL is then tailed incrementally — replay from
byte 0 when the file is found (a fast tiny prompt may have already produced
the whole run), deduped by entry id so compaction rewrites never double-emit —
and translated into the existing normalized `SubagentEvent`s (user/assistant
messages, tool calls + results, usage — read from the assistant message's
`usage`, the real session format).

**Completion is file-driven**: a run settles only when a NEW assistant
message with `stopReason` `stop`/`error`/`aborted` arrives after the prompt.
Herdr idle alone never settles a run; the only idle-independent fallback is a
liveness probe that fails the run when the worker TUI actually exited without
a terminal message.

### Codex discovery and parsing

Each Codex run uses a unique marker prepended to the user prompt (e.g.
`herdrsub_sa-3_a1b2c3 …`). The initial prompt (and a prompt that resumes a
closed settled session) is a native Codex positional argument; active-pane
follow-ups use send-text + Enter. Rollout discovery scans
new/changed `*.jsonl` files under `$CODEX_HOME/sessions` and `/rollouts` and
matches **marker text + cwd from `session_meta`** (plus the session id once
known) — never newest-mtime alone, so concurrent subagents cannot cross-bind.
The reader ignores injected pre-marker AGENTS/environment user records, so
only the actual marked turn enters the parent transcript. The bound rollout
is replayed from byte 0 and translated from
`task_started`/`task_complete`/`turn_aborted`, `event_msg` agent/user
messages, `token_count`, and `response_item` tools into the same normalized
events. The rollout path and native session id are stored in subagent meta.

### Steering, interrupts, take-over

Resumes rebuild the EXACT original launch policy in a fresh pane: Pi gets
`--session <path>` plus model, thinking level, tool exclusions, trust, and
name; Codex gets `resume <id>` plus `--cd`, model, reasoning effort via
`-c model_reasoning_effort=...`, sandbox, approval, and (for a queued settled
run) its marked positional prompt.

- **send()** steers an active run through the same `pane send-text` + Enter
  transport (Pi queues its own follow-ups; Codex follow-ups are queued locally
  and drain when the task settles). On a settled run, send resumes the exact
  session in a fresh pane, prompts, and monitors the next run — the manager's
  `send` semantics are unchanged, and a failed resume settles truthfully
  (RunStarted → RunSettled).
- **interrupt** sends `agent send-keys ctrl+c`; a local fallback settles the
  run if the parser misses the abort ack.
- **Take-over** (`/subagents` selection): running — atomically marks the
  session taken over, focuses the existing pane, never interrupts; the first
  result still delivers and the pane stays open at its TUI. Settled — opens a
  fresh pane resuming the exact native session (`pi --session <path>`,
  `codex resume <id>`), focuses it, keeps it open. A successful pane takeover
  exits the dashboard; outside Herdr the in-session takeover overlay is used.
- **Scope close**: watchers stop, transient launcher specs are cleaned, and
  the pane closes unless the user took it over. Persisted pi sessions are
  NEVER deleted (resumable); taken-over panes survive until the whole
  workspace closes at session shutdown.

## Background terminals: observer workspace

On every `bg_start`, when Herdr is available, the extension opens a watcher
pane in the shared workspace's Terminals tab running a plain spill-file tail
(Windows uses two `Get-Content -Wait` background jobs merged with
`Receive-Job`; POSIX uses `tail -F`). Lifecycle:

- `/ps` selecting a terminal marks its observer **taken over** and focuses it;
  the pane then survives the terminal's settle at its shell prompt.
- When the terminal settles, the watcher is stopped (ctrl+c) and — unless
  taken over — the pane is closed. The process itself is owned by the
  terminal manager before and after; this layer only observes.
- `session_shutdown` closes the workspace through the shared controller
  (`disposeWorkerWorkspace`), bounded.

## Shared workspace

`extensions/shared/herdr-workspace.ts` is the deep module: workspace/tab/pane
creation with `--no-focus`, serialized per-category allocation (the first
worker of a category runs in the tab's root pane, later workers split the
newest pane), pane-level `run`/`send-keys`/`prompt`/`report-agent`/
`report-metadata`/`focus`/`close`/`agent get`, explicit technical agent names,
and rollback that never leaves a closed root pane as the next split target
(active pane tracking). `extensions/shared/herdr-pane.ts` keeps the
split/run/close API used by `/btw` and re-exports the runner.

## Files

| File                                                | Role                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `extensions/shared/worker-launcher.mjs`             | Zero-dependency pane launcher (`node <launcher> <spec.json>` raw argv) |
| `extensions/shared/herdr-workspace.ts`              | Worker workspace, panes, agents, observers, send-text transport        |
| `extensions/shared/herdr-pane.ts`                   | `/btw` split/run/close + runner re-exports                             |
| `extensions/subagents/src/backends/herdr-worker.ts` | Pi/Codex TUI launch specs, parsers, rollout discovery, worker sessions |
| `extensions/subagents/src/ui/takeover.ts`           | `/subagents` dashboard + pane take-over entry                          |
| `extensions/background-terminals/src/observer.ts`   | Terminal watcher coordinator                                           |
