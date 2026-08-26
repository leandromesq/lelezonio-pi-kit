---
name: subagents
description: delegate work to subagents — use when the user asks to use subagents, or when a subtask is independent, complex, long, or parallelizable enough to justify a child agent
---

# Subagents

Each subagent has an isolated context and cannot see the parent conversation. Give every child a self-contained prompt with relevant paths, constraints, context, and the expected output. Pi children can request clarification through `ask_question`; nesting is disabled unless the selected profile explicitly allows named child profiles.

## Decision policy

Spawn a subagent when the user explicitly requests one. Otherwise, delegate only when the task can be described self-containedly and at least one condition applies:

- It is an independent investigation or implementation track.
- It can run in parallel while the parent continues useful work.
- It requires substantial multi-file analysis.
- An isolated context materially improves the work.

Do not delegate targeted reads, a few tool calls, small single-file changes, integration, routine verification, or work requiring frequent shared-state coordination. Never spawn merely because concurrency is available; the configured limit is a ceiling, not a target.

Choose profiles by expected output:

- `planner`: design a future approach or architecture.
- `coder`: perform substantial implementation.
- `reviewer`: independently evaluate an existing plan, diff, or implementation.

A `coder` should spawn a nested `reviewer` only for nontrivial changes where independent validation is materially useful. Keep final integration in the parent and critically review every delegated result before applying it.

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
