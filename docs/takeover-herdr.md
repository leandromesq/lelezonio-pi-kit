# Take over in a Herdr pane

When this Pi session runs inside Herdr (`HERDR_ENV=1`), the **take over** paths
of three extensions — subagents (`/subagents`), background terminals (`/ps`),
and remote agents (`/remotes`) — open the chosen target in a **new Herdr pane**
that shows and controls the **same existing process**. Selecting take-over
never starts a second Pi and never duplicates the work: the pane runs a thin
viewer that observes the existing manager's snapshot and relays user actions
back over a loopback bridge. Outside Herdr, or whenever the pane cannot be
opened, the exact same in-session overlay as before is used.

## Architecture

```
parent Pi process                       Herdr pane
┌────────────────────────────┐          ┌──────────────────────────┐
│  manager / read model      │          │  node takeover-viewer.mjs │ ← run via
│  (sole owner of the work)  │          │  (interactive TTY)        │   pane run
│         │                  │          │         │                 │
│  ┌──────▼───────────────┐  │  TCP     │  ┌──────▼──────────────┐  │
│  │ takeover-host        │◄─┼──────────┼──│ net.createConnection │  │
│  │ net.Server 127.0.0.1 │  │JSONL     │  └─────────────────────┘  │
│  │ ephemeral port       │  │          │                           │
│  │ per-takeover token   │  │          │                           │
│  └──────────────────────┘  │          │                           │
└────────────────────────────┘          └──────────────────────────┘
```

- **Host** (`extensions/shared/takeover-host.ts`): a parent-owned loopback TCP
  JSONL bridge. The extension's thin adapter registers a target
  (`kind:id`, snapshot getter, action handlers) and subscribes to the read
  model; the host opens the pane, authenticates the viewer, throttles and
  bounds snapshot pushes, and routes actions back to the manager's
  fire-and-forget commands.
- **Viewer** (`extensions/shared/takeover-viewer.mjs`): a zero-dependency
  Node program launched in the pane with `node …/takeover-viewer.mjs`. It
  reads its bridge endpoint from pane environment variables (never argv),
  connects, renders the normalized snapshot as a live TTY screen, and turns
  keys into bridge actions.
- **Pane lifecycle** (`extensions/shared/herdr-pane.ts`): the same
  split/run/rollback dance used by `/btw`, extracted and shared. Splits use
  `--no-focus` and keep the caller's cwd; `pane run` starts the viewer,
  retrying `agent_pane_busy`.

## Which pane/what commands

| Target   | Snapshot shown                                  | Actions from the pane                                                     |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| subagent | plain-text transcript, live assistant, queued   | i/Enter = compose, Enter = send, Ctrl+C = abort (confirm)                 |
| terminal | stdout (main) + stderr (`t` toggles), read-only | Ctrl+C = kill (confirm)                                                   |
| remote   | remote transcript                               | i/Enter = compose, Enter = send, Ctrl+C = cancel (confirm), `r` = refresh |

## Viewer keys

Two explicit modes. In command/navigation mode (the default), the classic
keys act:

```
q            detach (target keeps running; pane returns to its shell)
i / Enter    enter input mode (compose)
Ctrl+C       destructive action with confirmation y/any-other-key
r            request refresh (remote agents, while attached)
t            toggle stdout/stderr (terminals)
↑/↓, PgUp/PgDn, g/G   scroll
```

In input mode every printable character edits the buffer — including q/t/r/g/G
and emoji/code points, which never act as commands while composing:

```
Enter        send the composed input (subagents, remote agents)
Esc          exit input mode and cancel the buffer
Ctrl+C       clear the buffer (stays in input mode)
Backspace    delete the previous code point
```

Input is byte-capped at 8 KB; over the limit the viewer shows a notice and
the host acks `text_too_long` without dropping the bridge.

Detaching (`q`), closing the pane, losing the bridge, or the parent session
ending **never stops the target** — the managers remain the sole owners.
Snapshots pushed to a slow socket are dropped in favor of the latest
(full-state, idempotent); control frames are never dropped.

## Bounds and backpressure

The host and viewer share one coherent protocol (the viewer rejects any frame
over 64 KB before parsing, so the host never sends one):

- Incoming frames (hello/actions): ≤ 64 KB, ≤ 4 frames buffered per socket.
- Snapshot text: ≤ 24 KB per stream, sanitized (ANSI/OSC/control stripped);
  the **newest tail** is kept and dropped bytes are marked
  (`…[truncated]`), never the oldest head. The serialized snapshot frame is
  capped at 56 KB (< the viewer's 64 KB parse cap) even under worst-case
  JSON escaping.
- Send text: ≤ 8 KB; over-limit input acks `text_too_long` rather than
  killing the connection, and a throwing action handler acks `handler_error`.
- Push cadence: at most 10 Hz per target; a viewer whose socket backs up has
  snapshot frames skipped (latest-wins) rather than queued.
- Connections: a per-connection pre-auth timeout (silent sockets are dropped
  after 5 s) and a modest cap (8 simultaneous connections).
- Auth: a fresh 48-hex random **per-takeover attempt** token via
  `timingSafeEqual`, delivered to the pane only through `pane split --env`
  (never argv); a token authenticates only its own source. The hello must
  carry the protocol version and the viewer's `kind:id` key.
- Header safety: target-controlled title/status/id are sanitized before they
  reach the pane TTY, and the viewer strips ANSI again when rendering.

## Fallback and idempotence

- `open()` resolves the pane id only after split, viewer launch, **and** the
  correct viewer's hello all succeed within the approval window (~8 s). On
  timeout, auth failure, or launch failure the half-opened pane is closed,
  the source/subscription cleaned up, and `undefined` is returned so the UI
  keeps the in-session overlay.
- One pane per `kind:id` while its viewer is attached; reopening the same
  target reuses the pane. Concurrent opens for the same key share one
  split/launch attempt (no double split). After a detach, reopening closes
  the stale pane (if still open) and splits fresh.
- Parent `session_shutdown` disposes the bridge: sockets and panes close,
  sources unsubscribe, and targets keep running.
- `/btw` keeps its original behavior — a real `pi -p` in a pane — implemented
  on top of the same shared `herdr-pane.ts` helpers.

## Files

| File                                           | Role                                  |
| ---------------------------------------------- | ------------------------------------- |
| `extensions/shared/herdr-pane.ts`              | Herdr CLI split/run/close + rollback  |
| `extensions/shared/takeover-host.ts`           | Bridge server, auth, protocol, bounds |
| `extensions/shared/takeover-viewer.mjs`        | Interactive pane viewer (zero deps)   |
| `extensions/subagents/src/ui/takeover.ts`      | subagent adapter + entry point        |
| `extensions/background-terminals/src/ui/ps.ts` | terminal adapter + entry point        |
| `extensions/remote-agents/src/ui/pane.ts`      | remote adapter + entry point          |
