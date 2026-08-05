---
name: remote-agents
description: Delegate long-running or resource-intensive work to persistent Pi agents through Herdr, or guide an explicitly requested interactive `herdr --remote` attach. Use when the user explicitly requests remote execution, Herdr, or unattended work on the homelab.
---

# Remote Agents

Use the `remote_*` tools supplied by the remote-agents extension.

## Rules

- Use `remote_spawn` only when the user explicitly asks for remote execution or has approved it.
- Give the remote agent self-contained instructions, constraints, relevant paths, and a clear completion contract.
- Never send credentials, private keys, `.env` contents, or unrelated secret-bearing context.
- Do not authorize the remote agent to push, merge, deploy, expose services, or perform destructive operations unless the user explicitly requested it.
- After spawning, report the remote job ID and continue useful local work.
- Do not repeatedly poll. Completed jobs are delivered automatically; use `remote_check` only when current status is needed.
- Use `remote_wait` only when the result is required before the current task can continue.
- Use `remote_send` to clarify or steer a job. Use `remote_cancel` when the user asks to stop it or it is clearly running the wrong task.
- Remote workspaces survive local Pi shutdown and can be inspected with `/remotes`.
- Git jobs run from the matching checkout under the configured remote `Projects` root. Only one active remote writer is allowed per project.
- If a remote project is missing, ask the user before setting `clone_if_missing`; never transmit a credential-bearing Git URL.
- Non-Git jobs run from the configured remote `Worktrees` folder.
- Blocked-agent questions are delivered automatically. Answer them with `remote_send` after obtaining any input needed from the user.
- In `/remotes`, `d` closes and forgets the selected workspace. `/remote-clean` removes all settled stale workspaces.

## Interactive Herdr remote attach

`remote_*` tools delegate and monitor headless Pi jobs through this setup's SSH helper. `herdr --remote` is separate: it is an interactive local thin-client attach to a remote Herdr server, not a replacement for `remote_spawn` or `/remotes`.

- Use it only when the user explicitly asks to attach to, inspect, or control the remote Herdr UI.
- First verify normal SSH access: `ssh -o BatchMode=yes <target> true`. It uses ordinary OpenSSH authentication; a passphrase-protected key must be loaded into `ssh-agent` for a non-prompting shell.
- For the configured host, the user can run `herdr --remote macmini`. Use `herdr --remote <target> --session <name>` for a named remote session.
- It needs an interactive TTY. Never launch it through a non-interactive agent shell or `bg_start`; give the user the command to run in their terminal instead.
- Detach with `ctrl+b q`; the remote panes and agents keep running. The default attach uses local keybindings; add `--remote-keybindings server` only when the user wants the remote server's bindings.
- Remote attach supports Linux and macOS targets on `x86_64` and `aarch64`. Native Windows does not support `herdr --remote`; from Windows, SSH into the host and run `herdr` there.
- An interactive attach can offer to install a matching Herdr binary remotely if it is absent. Do not approve that remote change, or opt into experimental `--handoff`, without explicit user authorization.

See [Herdr's remote-persistence documentation](https://herdr.dev/docs/persistence-remote/) for the current behavior and platform details.

## Recommended prompt shape

Include:

1. Objective and expected deliverable.
2. Remote working directory or repository.
3. Relevant decisions and constraints.
4. Checks to run.
5. Actions that require user approval.
6. Required final report: files changed, checks run, branch/commit, and unresolved issues.
