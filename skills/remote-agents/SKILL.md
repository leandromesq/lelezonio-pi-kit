---
name: remote-agents
description: Delegate long-running or resource-intensive work to persistent Pi agents on the Tailscale-connected macmini through Herdr. Use when the user explicitly requests remote execution, Herdr, or unattended work on the homelab.
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

## Recommended prompt shape

Include:

1. Objective and expected deliverable.
2. Remote working directory or repository.
3. Relevant decisions and constraints.
4. Checks to run.
5. Actions that require user approval.
6. Required final report: files changed, checks run, branch/commit, and unresolved issues.
