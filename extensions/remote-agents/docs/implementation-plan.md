# Remote Agents Extension

Persistent remote Pi agents on the Tailscale-connected `macmini`, managed through Herdr.

## Runtime environment

The extension does not pin remote versions. Before every spawn it runs a
read-only preflight through the helper and reports the resolved Python, Pi and
Herdr paths and versions, the Herdr server state (running, version, protocol),
and the helper's working directory. Nothing from the remote environment is
dumped, and no version mismatch rejects a job; the report exists so a stale or
shadowed binary is visible instead of silently used.

The helper's tool path prefers the NixOS user profile
(`/etc/profiles/per-user/<user>/bin`) when it exists and otherwise falls back to
`~/.local/bin`, so the helper uses the same Python/Pi/Herdr as the login shell
instead of a legacy copy. Both directories stay on `PATH`, so older hosts keep
working.

Remote OS, SSH alias and the authentication of the remote Pi are host
configuration, not extension configuration; see the host setup for their
current values.

## Architecture

- `transport.ts`: bounded, cancellable, batch-mode SSH with JSON stdin.
- `remote/helper.py`: owner-only remote adapter that invokes Herdr without interpolating prompts into a shell, extracts the current submission's result from the Pi session file, and reports the preflight environment.
- `herdr-client.ts`: typed Herdr operations.
- `manager.ts`: persistent job registry, polling, reconciliation, structured result collection, completion delivery, and synchronous UI read model.
- `context.ts`: bounded context capsule with common credential redaction.
- `ui/dashboard.ts`: `/remotes` dashboard and interactive takeover transcript.

The manager never closes Herdr workspaces during Pi session shutdown. It stops only local polling, allowing remote jobs to survive `/reload`, `/new`, `/resume`, forks, process exit, and network loss.

## Configuration

Optional global configuration: `~/.pi/agent/remote-agents.json`.

```json
{
  "host": "macmini",
  "sshExecutable": "ssh",
  "remoteHelper": "/home/leandrom/.local/share/pi-remote/helper.py",
  "projectsRoot": "/home/leandrom/Projects",
  "worktreesRoot": "/home/leandrom/Worktrees",
  "openRemoteUiOnSpawn": true,
  "terminalExecutable": "kitty",
  "pollIntervalMs": 3000,
  "maxConcurrent": 2
}
```

`maxConcurrent` defaults to `2`; an explicit value in the file is honored. The
limit is a conservative default for a small host: each job is a full Pi process
and its tools may run CPU/RAM-heavy work. It is not a host-wide scheduler;
coordinate heavy builds separately. Busy alternate-screen history is a Herdr
read constraint, not evidence that concurrency itself caused overload.

Local Git repositories resolve by repository name beneath `projectsRoot`; working subdirectories are preserved. Missing projects require explicit approval before cloning from the local origin. Non-Git jobs use `worktreesRoot`, and only one active writer is permitted per Git project.

After a successful spawn, `openRemoteUiOnSpawn` opens a separate Kitty OS window running `herdr --remote macmini`. The launcher removes inherited `HERDR_*` variables before starting Kitty, so the new OS window is not rejected as a nested client. Selecting a job with Enter in `/remotes` opens the same external Herdr window instead of the old transcript overlay. The remote job remains successful if Kitty cannot be launched; Pi reports the UI launch failure as a warning. Set `openRemoteUiOnSpawn` to `false` to keep automatic spawn windows disabled; jobs can still be opened explicitly from `/remotes`.

## Commands and tools

Commands:

- `/remote <instructions>`
- `/remotes`
- `/remote-clean`

Tools:

- `remote_spawn`
- `remote_check`
- `remote_list`
- `remote_send`
- `remote_wait`
- `remote_cancel`

## Current MVP limits

- Local and remote project files are not synchronized automatically.
- No automatic Git worktree, bundle, push, merge, or result import.
- Each new submission carries a random marker in its prompt. That marker,
  its digest and the session cursor are persisted with the job generation.
  Extraction selects its user entry on the active session branch and excludes
  later submissions; delayed replies from an older generation cannot overwrite
  a follow-up. A prompt/answer not yet flushed stays pending rather than using
  an older answer. `remote_wait` also waits for this result validation.
- A normal final response is accepted; `error` fails the job, `length` is a
  truncated failure, and `aborted` becomes `cancelled` if cancellation was
  requested or `failed` otherwise. Unfinished tool turns are pending. Legacy
  sessions lacking stopReason retain the documented text-only policy.
- Only legacy jobs without anchors or Herdr versions without a session path
  use sanitized terminal output as a completion fallback; this is unverified
  terminal evidence, not a submission-bound structured answer. New anchored
  jobs with pending results never use stale terminal output as success. The
  terminal also remains available as the live takeover view. A
  `--source recent-unwrapped` read on a busy alternate-screen agent returns
  `agent_not_idle`; the helper retries that one error with the visible screen,
  and the manager keeps the previous transcript and a healthy status if even
  that read fails. Other Herdr and SSH failures stay failures.
- Settled workspaces remain available for inspection until deleted with `d` or cleaned with `/remote-clean`.
- Blocked-agent questions are delivered once to the parent session and can be answered with `remote_send`.
- Common credential shapes are redacted, but users must still avoid placing secrets in delegated context.

## Disconnect versus reboot

A network or SSH disconnect is not a job failure. The manager keeps polling a job
it cannot reach, marks it `unreachable` without settling it, and returns it to
its live `working`/`done` state when the host answers again; reconciliation on
the next Pi session start does the same from the registry. A reboot is
different: the Herdr server and the remote Pi processes are gone, so
reconciliation no longer finds the stable agent name and marks the job
`unknown`, and the next refresh confirms the agent is gone (`failed`). No
completion is invented from stale terminal output, and the interrupted run is
not resumed automatically.
