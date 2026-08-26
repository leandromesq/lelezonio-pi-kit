# System specs (personal Linux laptop only)

> These specifications and environment assumptions apply only on my personal Linux laptop. When running on Windows, ignore this entire section.

- **OS**: CachyOS Linux (Arch-based, rolling)
- **CPU**: 13th Gen Intel Core i7-13620H (12+4 cores, 16 threads) @ up to 4.90 GHz
- **Memory**: 31.08 GiB total
- **Disk**: 472.94 GiB, btrfs
- **Display**: 1920x1080 @ 165Hz
- **WM**: niri (Wayland compositor)
- **Terminal**: kitty, using herdr multiplexer and pi agent
- **Packages**: pacman

---

# Workflow: moderate delegation

- Spawn a subagent when the user explicitly requests one. Otherwise, delegate only when the task can be specified self-containedly and at least one condition applies: it is an independent investigation or implementation track, can run in parallel with useful parent work, requires substantial multi-file analysis, or materially benefits from an isolated context.
- Do not delegate targeted reads, a few tool calls, small single-file changes, integration, routine verification, or work requiring frequent shared-state coordination. Never spawn merely because concurrency is available.
- Delegate per the subagents skill with a self-contained prompt (paths, constraints, context, and expected output). Use `planner` to design a future approach, `coder` for substantial implementation, and `reviewer` for independent evaluation of an existing plan, diff, or implementation. A `coder` should spawn a nested `reviewer` only for nontrivial changes where independent validation is materially useful.
- Spawn up to 3 subagents in parallel only for genuinely independent tracks; this is a ceiling, not a target. While they run, continue useful review, planning, or integration work instead of idling. Use Herdr panes when the user wants to watch agents work side by side.
- Keep critical review of delegated results before integrating. Never apply a subagent's output blindly — check it against the task first.
- Profile routing (`subagents.json`): all named profiles run on the Pi harness. `planner` uses `openai-codex/gpt-5.6-luna`, `coder` uses `opencode-go/deepseek-v4-flash`, and `reviewer` uses `opencode-go/gpt-5.6-luna`; profile-less spawns also default to the Pi harness. Override the harness to Codex only when Pi lacks a tool required by the task, such as an MCP integration available through Codex CLI.
- This file overrides the herdr skill's "use only when explicitly mentioned" gating (that skill is installed externally from the herdr repo). Treat herdr as the default for visible side-by-side agents.

---

# Background terminals

- Use `bg_start` for long-running commands (dev servers, watchers, streaming builds) as instructed in the background-terminals skill; use regular `bash` for quick commands.

---

# Context hygiene

- Targeted reads only: rg/fd with filters, never dump whole files into context. If exploration is big, it's a subagent job.

---

# Verify after change

- After any change, run the project's check/format/lint/test suite and report results. If none exists, say so and suggest adding one.

---

# Safety

- Never run destructive commands (rm -rf, force push, branch deletion, package removal) without explicit confirmation.
- When ambiguous, ask one question at a time with concrete options.

---

# Meta

- Keep this file current: when a workflow decision becomes a habit, write it down here.
