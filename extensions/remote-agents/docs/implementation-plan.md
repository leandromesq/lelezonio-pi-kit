# Remote Agents Extension

Persistent remote Pi agents on the Tailscale-connected `macmini`, managed through Herdr.

## Verified environment

- SSH alias: `macmini`
- Local SSH client: `C:\Windows\System32\OpenSSH\ssh.exe`
- Remote Herdr: `/usr/local/bin/herdr` (`0.7.5`, protocol 17)
- Remote Python: `/usr/bin/python3`
- Remote Pi is started by Herdr from the interactive zsh environment.

The Phase 0 spike verified this sequence over batch-mode SSH:

1. `herdr workspace create --cwd ... --label ... --no-focus`
2. Wait for the root pane to reach an available shell.
3. `herdr agent start <name> --kind pi --pane <id>`
4. `herdr agent prompt <name> <text>`
5. `herdr agent get/read/wait`
6. `herdr workspace close <id>`

Herdr workspace creation can return before its root pane is ready. The remote helper retries only the `agent_pane_busy` failure for up to 15 seconds.

## Architecture

- `transport.ts`: bounded, cancellable, batch-mode SSH with JSON stdin.
- `remote/helper.py`: owner-only remote adapter that invokes Herdr without interpolating prompts into a shell.
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
  "sshExecutable": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
  "remoteHelper": "/Users/leandrom/.local/share/pi-remote/helper.py",
  "projectsRoot": "/Users/leandrom/Projects",
  "worktreesRoot": "/Users/leandrom/Worktrees",
  "pollIntervalMs": 3000,
  "maxConcurrent": 3
}
```

Local Git repositories resolve by repository name beneath `projectsRoot`; working subdirectories are preserved. Missing projects require explicit approval before cloning from the local origin. Non-Git jobs use `worktreesRoot`, and only one active writer is permitted per Git project.

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
- Completed Pi jobs return the latest finalized assistant text extracted from the remote JSONL session. Sanitized Herdr terminal output remains the fallback and live takeover view.
- Settled workspaces remain available for inspection until deleted with `d` or cleaned with `/remote-clean`.
- Blocked-agent questions are delivered once to the parent session and can be answered with `remote_send`.
- Common credential shapes are redacted, but users must still avoid placing secrets in delegated context.
