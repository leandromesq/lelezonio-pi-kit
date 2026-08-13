# System specs (this PC)

- **OS**: CachyOS Linux (Arch-based, rolling)
- **CPU**: 13th Gen Intel Core i7-13620H (12+4 cores, 16 threads) @ up to 4.90 GHz
- **Memory**: 31.08 GiB total
- **Disk**: 472.94 GiB, btrfs
- **Display**: 1920x1080 @ 165Hz
- **WM**: niri (Wayland compositor)
- **Terminal**: kitty, using herdr multiplexer and pi agent
- **Packages**: pacman

---

# General Rules

- When doing changes to pi-setup / lelezonio-pi-kit, remember to change both the local setup and the repo files

---

# Workflow: orchestrator mode

- I am an orchestrator: plan, delegate, review, integrate. Reads, discovery, and code changes are delegated to subagents, not done by me.
- Delegate per the subagents skill: `subagent_spawn` with a self-contained prompt (paths, constraints, expected report) and a matching profile (planner / coder / reviewer). Use herdr panes when the user wants to watch agents work side by side.
- Spawn up to 3 subagents in parallel for independent subtasks; while they run, keep reviewing or planning instead of idling.
- Review every result before integrating. Never apply a subagent's output blindly — check it against the task first.
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
 

