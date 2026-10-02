# pi-observational-memory (local fork)

Tiered, subprocess-backed memory for pi: parallel **observers** distill raw conversation chunks
into atomic observations in a branch-local ledger; a deterministic, model-free **compaction**
renders that buffer into the compaction block; a **consolidator** promotes the oldest
observations into durable `.memory/<sessionId>/` topic files.

This directory is a **local fork** of
[`amosblomqvist/pi-observational-memory`](https://github.com/amosblomqvist/pi-observational-memory),
pinned to commit `78a1efcfdd46332253fb289724f05b26dfc7769e` (upstream `package.json` version
`0.1.0`, developed against pi `0.74`). It is **not an official upstream release**. The upstream
MIT license is preserved verbatim in [`LICENSE`](LICENSE); [`PLAN.md`](PLAN.md) is the upstream
design document.

The earlier `elpapi42` observational-memory source that lived in this directory is **not** this
fork. Its custom ledger entries remain in existing session files, untouched (see
[Ledger namespace isolation](#ledger-namespace-isolation)).

## Local changes vs upstream

Compatibility and safety fixes for pi 1.0, kept as small as possible:

- **Ledger namespace is `om2.*`** (upstream used `om.*`, which collides with the legacy
  elpapi42 schema). Old `om.*` entries are never parsed as ours.
- **Opt-in fallback gate**: `settings.enabled` (default `false`) is used only when the branch
  has no `om2.enabled` entry. `/om off` writes a branch entry and overrides it.
- **Proactive compaction is disabled by default** (`compactAtContextTokens: 0`). Pi's native
  window-pressure compaction is authoritative; OM supplies the summary through
  `session_before_compact`. When `> 0`, mid-run compaction uses the pi 1 `turn_end` boundary
  (`entries` + `continue: true`) instead of a manual `ctx.compact()` + hidden resume message.
- **`session_tree` restores the gate** and invalidates in-flight workers (epoch + abort), so a
  worker dispatched on an old branch cannot append coverage to the new one.
- **Child isolation**: the factory registers nothing when `PI_SUBAGENT=1` or
  `PI_OBSERVATIONAL_MEMORY_PASSIVE=1`; the shared resource loader also excludes this package by
  path. `PI_OM_PASSIVE=1` keeps commands but disables triggers.
- **Durable acknowledgements**: observers must call `finish_observations` and consolidators
  must call `finish_consolidation` before the orchestrator commits coverage / tombstones a
  batch. A clean `exit 0` is not sufficient (the turn cap or `ctx.shutdown` can end a worker
  early). A consolidator ack with zero durable writes is accepted only as an explicit
  `discardedAll` batch discard.
- **Ordered, contiguous coverage**: observers commit in dispatch order through a bounded
  pending window, and a successful empty chunk writes an `om2.coverage.committed` marker, so
  durable coverage advances even with nothing to remember. A later successful chunk never jumps
  an earlier failed/unobserved one; a failure aborts the window and retries from the last
  committed chunk (duplicate observations are acceptable).
- **Frontier-bounded compaction**: the custom summary never cuts past the last contiguously
  committed coverage. When no safe boundary exists (a gap, or no committed coverage yet), the
  hook returns `undefined` and Pi falls back to its native model summary instead of omitting the
  region or cancelling compaction.
- **Bounded workers**: `timeoutMs` (wall-clock, SIGTERM→SIGKILL) and `maxTurns` (enforced by the
  worker extension); stderr capture is capped to a 64 KiB tail; an already-aborted signal returns
  before any spawn side effect; run ids are UUIDs (unique across restarts on a reused pid);
  worker cost is recorded once per runId; shutdown suppresses appends and notifications against
  a dead context.
- **Symlink-safe `.memory/` scoping**: the consolidator's file tools resolve through symlinks and
  reject any path that escapes the session memory root.
- **Project settings are trust-gated**: `<cwd>/.pi/settings.json` is read only for a trusted
  project; global `~/.pi/agent/settings.json` is always read.
- **Portable pi resolution**: workers resolve the installed package CLI and run it with
  `process.execPath`, so Windows (no `.cmd` shim) and SDK/test hosts work without mistaking the
  host entry point for pi.
- **Bounded shutdown drain**: `session_shutdown` aborts every in-flight worker and then awaits
  the tracked observer/consolidator process tasks (`whenWorkersIdle(SHUTDOWN_DRAIN_MS)`) so the
  SIGTERM→SIGKILL escalation actually fires before Pi exits, instead of orphaning subprocesses.
  The drain tracks tasks independently of the ordered pipeline map, so jobs dropped by
  `abortAllWorkers` are still awaited, and it is bounded so a stuck worker cannot hang exit.
- **Transient worker widget**: the `om-workers` line is a component factory that re-renders with
  the current theme (no stale ANSI), clamps to the available width, and collapses overflow into
  a trailing `+N`. There is no persistent OM footer. `/om:status` opens a responsive, scrollable
  overlay with live detail and an honest `OM worker cost` figure (the sum of worker `om2.cost`
  entries, not the whole-session bill); non-TUI clients get the plain read-only report.
- `max` is accepted as a thinking level (pi 1).

## Enable

In the agent-directory `settings.json`, point the package source at this directory:

```json
{
  "packages": ["./vendor/pi-observational-memory"]
}
```

Do not load both the npm package and this local copy: they register the same hooks, commands,
and tools. Restart pi after changing the source.

## Configuration

Namespace `observational-memory` in `~/.pi/agent/settings.json` (global) and
`<project>/.pi/settings.json` (project; read only for a trusted project, overrides global):

```jsonc
{
  "observational-memory": {
    "enabled": true,                  // fallback gate when the branch has no om2.enabled entry
    "chunkTokens": 10000,
    "chunkOverlapTokens": 0,          // reserved; NOT used by the chunk cutter (no-op)
    "poolTargetTokens": 20000,
    "consolidateAtPoolTokens": 30000, // must be >= poolTargetTokens (clamped up)
    "tailTokens": 20000,
    "journeyTargetTokens": 4000,
    "observerConcurrency": 1,         // bounded 1..8
    "compactAtContextTokens": 0,      // 0 = disabled (Pi pressure compaction authoritative)
    "timeoutMs": 600000,              // worker wall-clock bound; 0 disables
    "maxTurns": 40,                   // worker turn cap; 0 disables
    "models": {
      "observer":     { "provider": "opencode-go", "id": "deepseek-v4.1-flash", "thinking": "low" },
      "consolidator": { "provider": "opencode-go", "id": "deepseek-v4.1-flash", "thinking": "low" }
    },
    "passive": false,
    "debugLog": false
  }
}
```

Relational bounds are enforced after merge: `chunkOverlapTokens < chunkTokens`,
`consolidateAtPoolTokens >= poolTargetTokens`, `observerConcurrency` clamped to `1..8`,
`timeoutMs`/`maxTurns` clamped to sane maxima. `chunkOverlapTokens` is accepted but has no
effect today.

Environment: `PI_OM_PASSIVE=1` forces `passive`. `PI_SUBAGENT=1` and
`PI_OBSERVATIONAL_MEMORY_PASSIVE=1` make the whole extension inert.

Commands: `/om`, `/om on|off`, `/om:status`, `/om:compact`, `/om:consolidate`.

## Memory files and `/tree` policy

Durable long-term memory lives under `<project>/.memory/<sessionId>/` (`INDEX.md`, `<topic>.md`,
`JOURNEY.md`), keyed by the immutable session-header id. A fork seeds its directory from the
parent once.

**Topic files and `JOURNEY.md` track the session, not the branch: they are intentionally not
rolled back by `/tree`.** The short-term ledger *is* branch-local and does roll back. This is a
deliberate policy: the durable tier is a session-wide, `grep`-able record of what happened, while
the buffer is branch-correct.

> **Secrets warning.** `.memory/` can contain sensitive conversation content. Add `.memory/` to
> your project's `.gitignore` yourself; this extension does **not** write or modify any
> `.gitignore` outside its own directory.

Transient worker IPC lives under `<project>/.memory/<sessionId>/.runs/`.

## Ledger namespace isolation

This fork writes only `om2.*` custom entries (`om2.observations.recorded`,
`om2.observations.dropped`, `om2.folded`, `om2.enabled`, `om2.cost`). The legacy elpapi42
extension used `om.*` with a different observation schema (an `id`, `relevance`,
`sourceEntryIds`, and a minute-resolution display timestamp). Because the schemas are not
compatible, the new namespace is separate and **old entries are ignored, never migrated or
deleted**. There is no durable migration: old memory stays in the session files, and the new
system starts its own ledger.

## Recall: what this fork does and does not do

The durable tier is the **filesystem**: the model sees a generated memory map in the compaction
block and reads/greps `.memory/` topic files with its normal tools. Upstream (and this fork) do
**not** ship a `recall` tool, and v1 observations do **not** retain source-entry ids, so exact
"jump back to the source message" recall is not available. This is an accepted limitation of the
fork; no compatibility shim for the old recall API is provided.

## Development and tests

```sh
# from the kit root
node scripts/observational-memory.test.mjs   # loader/safety regression tests (no model/network)
```

The vendored upstream vitest suite is also kept:

```sh
cd vendor/pi-observational-memory
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

A local package is not updated by `pi update --extensions`. To refresh it, review the upstream
diff at a newer commit, re-apply the local changes above, and re-run both suites.
