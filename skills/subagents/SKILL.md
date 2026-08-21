---
name: subagents
description: delegate work to subagents — use when the user asks to use subagents, or when a subtask is independent, complex, long, or parallelizable enough to justify a child agent
---

# Subagents

Each subagent has an isolated context and cannot see the parent conversation, ask the user, or orchestrate additional agents. Give every child a self-contained prompt with relevant paths, constraints, context, and the expected output.

Use subagents only for independent, complex, long-running, or meaningfully parallelizable work. Keep small reads, targeted edits, and integration in the parent agent. Critically review every result before integrating it.

## Configuration

Treat `~/.pi/agent/subagents.json` as the source of truth for available profiles, harness defaults, models, thinking levels, and concurrency limits.

Prefer a configured profile when it matches the task. Override `harness`, `model`, or `reasoning_effort` only when the task requires it.

`workflow.agent()` does not use named subagent profiles. Configure workflow children through its supported `model`, `provider`, and `effort` options.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, a short `name`, and preferably a matching `profile`.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when progress depends on the result.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.
