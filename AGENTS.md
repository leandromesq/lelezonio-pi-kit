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

# Delegation

- Pi usually runs as a subagent started by T3 Code. In that role, do the task yourself: do not spawn subagents, Herdr workers, or remote agents. The T3 Code parent owns delegation and integration.
- Spawn a subagent only when the user explicitly asks for one in this session.

---

# Background terminals

- Use `bg_start` for long-running commands (dev servers, watchers, streaming builds) as instructed in the background-terminals skill; use regular `bash` for quick commands.

---

# Context hygiene

- Targeted reads only: native grep/find/ls with filters (Pi provisions rg/fd), never dump whole files into context. If exploration is big, it's a subagent job.

---

# Extension authoring

- In-process SDK children must exclude DonSeTch: its upstream cached transport is not session-owned. Keep parent web tools active; do not fork the external package without user approval.
- Preserve Pi's native startup header; `ui-customization` owns the dashboard/footer and editor, not the startup logo or repository banner.
- Any visible surface follows `docs/ui-conventions.md` (borders, glyphs, color roles, empty/error states, key hints via keybindings, English-only UI).
- Shared primitives are the single source: `extensions/shared/format.ts` (tokens, elapsed), `extensions/shared/activity-status.ts` (status lines), `extensions/shared/terminal-text.ts` (sanitization), `extensions/shared/ui/viewport.ts` (heights), `extensions/shared/context-utilization.ts`. Do not add a local copy; a drifted copy is a bug.
- Extensions that only serve an interactive parent (memory workers, dashboards, naming, recaps) must stay out of child sessions: Herdr workers get `PI_SUBAGENT=1` (env-gate there) and in-process children filter via `CHILD_EXCLUDED_EXTENSION_PATHS` in `extensions/shared/child-session.ts`.
- Never block the event loop on persistence: no `Atomics.wait`/spin-locks on request paths; write with debounce + temp/rename (async), read with an mtime/dirty check. See `extensions/remote-agents/src/persistence.ts`.

---

# Verify after change

- After any change, run the project's check/format/lint/test suite and report results. If none exists, say so and suggest adding one.
- When updating Pi, align the kit's pinned development dependencies with the installed runtime and run `npm run test:runtime` as well as the local suite; never silently substitute the local SDK for the installed-runtime smoke test.

---

# Safety

- Never run destructive commands (rm -rf, force push, branch deletion, package removal) without explicit confirmation.
- When ambiguous, ask one question at a time with concrete options.

---

# Meta

- Keep this file current: when a workflow decision becomes a habit, write it down here.
- Per-run findings and open items live in `docs/reviews/`; the current one is `2026-10-02-setup-corrections.md`.
