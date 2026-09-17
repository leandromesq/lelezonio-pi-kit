# Pi extension setup: critical performance and lifecycle audit

Date: 2026-09-17. Scope: local Windows setup, current working tree, Agrofortis mobile session traces, live Herdr metadata, installed Pi documentation, and Eero Alvar's reference setup.

## Verdict

**Do not migrate to tmux or rewrite everything yet.** There are concrete defects in the integration, unnecessary work before launches return, and orchestration/context-growth costs that changing multiplexers will not fix.

The strongest findings are:

1. A failed pane close can make the controller abandon a still-live workspace. Reproduced using an injected runner, without modifying live Herdr state.
2. `bg_start` waits for its optional Herdr observer to finish opening. A display feature is on the execution critical path.
3. Herdr-launched read-only profiles are not actually tool allowlists; PowerShell and extension-backed execution tools remain available.
4. Children inherit much more extension machinery than their tasks require. This amplifies polling, startup work, tool-surface size, and behavior differences between execution modes.
5. The session spends considerable time on long child runs and repeated review/documentation handoffs; one child reached about 432k input tokens without compaction.

No configuration or implementation fixes were applied. Existing uncommitted changes were preserved. This audit created this report and temporary diagnostic logs/transcript data. Its own test processes and review children were run locally; existing user jobs/workspaces were not deliberately closed or interrupted.

## Evidence and limits

### Agrofortis traces

Session files under `sessions/--c--Users-leandro.mesquita-Documents-GitHub-agrofortis.mobile--/`:

| Session                                         | Observation                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Parent `01a0a581-2a24-7587-a5e2-dbec39249585`   | 20 spawn calls, 35 sends, 31 waits; 159 assistant records.                                            |
| Same parent                                     | 19 matched spawn/result pairs: median 2.15 s, max 12.63 s.                                            |
| Same parent                                     | 7 background starts: median 13.11 s, max 25.71 s.                                                     |
| Same parent                                     | 29 matched waits: median 179.6 s, max 6,354.6 s. These are waiting durations, NOT extension CPU time. |
| Child `01a0ab8e-36fa-70e8-94b5-59552d159643`    | 166 assistant records; input + cache tokens grew from 8,693 to 432,268; no compaction entries.        |
| Same child                                      | 9 background starts: median 29.40 s, max 32.16 s.                                                     |
| Reviewer `01a0abb6-96c3-70e8-94b5-59595c5d5e83` | 34 assistant records; input + cache tokens grew from 3,804 to 168,349; no compaction entries.         |
| Same reviewer                                   | 15 reads returned 163,470 text characters; 31 grep calls returned 196,463.                            |

Timing method: tool-calling assistant entry timestamp to corresponding tool-result entry timestamp. These are user-visible trace intervals, not isolated tool execution spans. Parallel sibling tools and ordered result persistence can inflate individual intervals; do not sum them into total wall time or attribute them entirely to Herdr.

The parent also recorded WebSocket errors, aborts, and a ChatGPT usage-limit error. During this audit both reviewers initially terminated with provider errors and were resumed. Provider availability is a real, separate source of delay; it is not evidence that an extension caused the termination.

### Live Herdr

Initial snapshot showed three workspaces named `Pi Workers · agrofortis.mobile · 01a0ab8e`: `w1K`, `w1N`, and `w1Q`. Each had one pane, a Terminals tab, unknown agent status, and no detected agent. This corroborates the reported duplicate/empty-worker symptom. It does not independently prove their exact creation/failure sequence, or that a plain shell watcher was absent.

Both audit review children initially shared one new worker workspace correctly. A subsequent reviewer snapshot reported the three old workspaces were gone; the audit did not close them. Live state was changing during inspection.

Two read-only `workspace list` probes took 76 ms via `HERDR_BIN_PATH` and 83 ms via the standalone binary. These are small samples, not a benchmark, but they do not support blaming every launch delay on ordinary CLI round-trip latency.

Herdr server log excerpts show fast individual API completions separated by multi-second client-side gaps. They justify per-hop instrumentation, not an exact attribution to event-loop CPU pressure. Workspace IDs may be reused across server lifetimes; file modification times do not prove which code a long-running process loaded.

## Prioritized findings

### P1 — Failed cleanup loses ownership and leaks workspaces

**Confirmed, independently reproduced.**

References: `extensions/shared/herdr-workspace.ts:838-845`, `:1005-1054`, `:1067-1080`, `:1212-1235`, `:1283-1286`.

`closeBounded()` catches all close failures. The caller subsequently removes the pane from its maps. When no tracked panes remain, `forgetPaneLessWorkspace()` clears the workspace ID without establishing that the pane/workspace actually disappeared. Disposal likewise clears state before its best-effort close completes.

Injected-runner reproduction, current source:

```text
open worker -> fake workspace w1 exists
pane close -> throw "transport unavailable"
controller.workspaceId -> null; fake server still contains w1
open another worker -> controller owns w2; fake server contains w1 AND w2
```

This is a concrete mechanism for duplicate empty-looking workspaces. It is not proof that every initially observed orphan arose through this path.

**Fix:** represent close as confirmed-closed / confirmed-missing / uncertain. Preserve ownership and a bounded retry record on uncertain outcomes. Reconcile server state before allocating a replacement. Persist enough owner/session identity to recover after reload/crash. Never indiscriminately close workspaces by matching a human-readable label: taken-over panes and unrelated live work must be protected.

Existing test `herdr-workspace.test.ts:822` explicitly accepts swallowed rollback-close errors, but does not assert that the surviving server resource remains owned. Add that invariant, plus close/open interleavings and disposal-during-allocation tests.

### P1 — Background launch waits for optional visualization

**Confirmed code path; trace evidence demonstrates substantial user-visible launch intervals.**

References: `extensions/background-terminals/index.ts:320-327`; `extensions/background-terminals/src/observer.ts:56-95`; `extensions/shared/herdr-workspace.ts:361-364`, `:783-800`, `:892-917`.

After starting the actual process, `bg_start` awaits `coordinator.attach(snap)`. Attachment may create a workspace/tab/pane, rename/report it, launch the watcher, retry busy responses, and roll back. Individual CLI calls permit 20 seconds; the busy retry loop has a separate 15-second deadline that an individual call may overshoot.

A terminal can already be running or even finished while its launch tool is still waiting for a disposable display pane. Errors are then swallowed, explaining the combination of a slow call and no useful visual result.

**Fix:** return once the target process and spill files are ready. Attach the observer asynchronously under a session-owned task with cancellation, a total deadline, and shutdown tracking. `/ps` should be able to join an in-flight attachment or use the existing overlay immediately. Delay observer creation for very short commands to avoid opening/closing panes unnecessarily. Surface one concise diagnostic when visualization degrades.

A bare `void attach()` without lifecycle tracking is not a complete fix.

### P1 — Read-only policy differs across backends and is bypassable

**Confirmed source defect and observed capability during this audit.**

References: `extensions/subagents/src/profile.ts:13-51`; `extensions/subagents/src/backends/herdr-worker.ts:380-410`; `extensions/subagents/src/backends/pi.ts:300-305`; `extensions/shared/child-session.ts:13-25`.

The hardcoded builtin universe omits `powershell`. Herdr launches translate a nominal allowlist into exclusions from that incomplete universe rather than launching with a strict final allowlist. A reviewer in this audit successfully invoked PowerShell despite `readOnly: true`. Extension-provided capabilities such as background execution and remote tools are also not comprehensively restricted. In-process sessions use a different tools/exclusions path, so parity is not guaranteed.

There is a workflow cost as well: historical reviewers reported lacking shell access and reconstructed baselines with broad reads instead of reviewing a bounded Git diff. Accidental PowerShell availability is not an acceptable solution.

**Fix:** resolve one explicit child loadout from the actual tool registry and enforce it after extension registration, identically for fresh launch and resume in each backend. Add narrowly scoped read-only Git diff/status tools for reviewers. Keep remote execution and orchestration disabled unless explicitly granted. A tool allowlist is not an OS sandbox; document that distinction.

Test the actual visible tools, including PowerShell, extension-backed execution tools, resume, and project extensions—not just the old constant's exclusion list.

### P1 — Child runtimes inherit expensive, unnecessary extension behavior

**Confirmed architecture; exact performance contribution not isolated.**

References: `extensions/subagents/src/backends/pi.ts:103-111`, `:289`; `extensions/shared/child-session.ts:34-48`; `extensions/subagents/src/backends/herdr-worker.ts:380-410`; `extensions/git-info/index.ts:24`, `:94-120`, `:169-212`.

Children reload ordinary resources and extensions. Herdr workers launch a full Pi TUI without disabling ordinary extension discovery. Even a tightly scoped review receives substantial global behavior and tools.

`git-info` refreshes every three seconds and on input/tool completion. A successful repository refresh runs four Git processes; the periodic path alone can approach 80 process starts/minute/session when refreshes finish inside the interval, before event-triggered refreshes. Multiple full children multiply this. The overlap guard is good and disposal exists; this is unnecessary load, not a demonstrated timer leak.

**Fix:** introduce explicit parent / coder / reviewer / workflow-child loadouts. Keep trust enforcement, required project instructions, essential tool providers, cancellation, and result transport. Omit irrelevant dashboards, naming, Git polling, remote orchestration, and visual-only hooks in headless children. In visible worker TUIs, choose necessary UI features deliberately. Refresh Git on relevant mutations with debounce, on demand, or a slower visible-session cadence.

Cache immutable discovery results where safe. Do NOT share mutable extension runtimes or blindly memoize a resource loader across concurrent/trust-different sessions.

### P2 — An extra model request precedes every subagent launch

References: `extensions/subagents/index.ts:716`, `:288`, `:1250`; `extensions/auto-naming/src/title-generator.ts:89-150`; `extensions/auto-naming/src/config.ts:25-30`.

`generateTaskTitle()` is awaited before `manager.spawn`, including when the caller supplied a perfectly usable name. Defaults enable an additional model call with an 8-second request timeout. It is skipped when model/auth is unavailable, so not every observed slow spawn can be assigned to naming.

**Fix:** use the supplied name immediately. If automatic naming remains desirable, rename asynchronously without changing stable addressing IDs. Instrument naming/auth time separately from resource loading, pane readiness, and first provider response.

### P2 — Context policy optimizes capacity rather than responsiveness

References: `settings.json` compaction settings; `subagents.json`; Agrofortis trace table above.

All configured child profiles currently use high thinking. Coder and reviewer both use `opencode-go/deepseek-v4.1-flash`. Stored model metadata gives it a 1,000,000-token context window. With `reserveTokens: 120000`, the documented threshold is approximately 880,000 tokens—not 120,000. The observed 432k child therefore need not compact yet. For the stored 272k parent model, the same setting means about 152k instead.

High cache-hit counts reduce uncached input cost; they do not prove that a huge context is latency-free or behaviorally efficient. No controlled latency comparison was performed, so the amount attributable to context size remains unmeasured.

**Fix:** add a per-role soft context budget, initially benchmarked around 60–100k for ordinary focused workers; retain the model's real capacity separately. Summarize/restart at task boundaries rather than carrying finished work into every follow-up. Trial medium thinking for ordinary implementation and lower effort for narrow documentation/recon; retain high effort for genuinely difficult decisions. Measure quality and rework, not just tokens/sec.

Do not lower `reserveTokens` expecting earlier compaction—that moves the threshold in the opposite direction.

### P2 — Excessive handoffs inflate the critical path

The parent trace contains repeated docs-only delegations, documentation corrections sent through existing coders, review follow-ups, and blocking waits. One wait lasted roughly 106 minutes; the transcript contains a parent message asking a worker to stop broad exploration after 151 turns. Launch optimizations measured in seconds cannot explain or eliminate that duration.

**Fix:** enforce the already-written moderate-delegation policy. Parent handles small integration/doc edits. Give each substantial child a bounded scope, deliverable, and stop condition. Add progress budgets (elapsed active work, tool turns, context growth, repeated same-command failures) that request a checkpoint rather than silently allowing unbounded exploration. Separate a legitimately long build from a stalled provider or a worker repeatedly rereading files. Review once against a concrete diff, followed by narrow verification of fixes.

Do not replace useful parallelism with blanket serialization or mechanically lower concurrency. Do not remove `wait` outright: use it when the parent genuinely has no independent work left.

### P2 — UI and history work grows with session length

References:

- `extensions/subagents/index.ts:567`: deep-clones the whole settled snapshot for delivery, including transcript data that the notification does not need.
- `extensions/subagents/src/manager.ts:389-397`, `:480`; `extensions/subagents/index.ts:343-355`: per-event notification/status recomputation in streaming paths.
- `extensions/subagents/src/ui/takeover.ts:569`; `src/ui/transcript.ts:126-176`: transcript wrapping/rebuilding before viewport slicing.
- `extensions/model-info/index.ts:11-14`, `:40`, `:63-64`: repeated whole-branch cost/context work.

**Fix:** deliver compact immutable result records; keep transcript artifacts separate. Coalesce status changes, update usage incrementally, and memoize transcript layout by revision/width/theme. Benchmark with realistic long sessions before assigning a dominant cost to these paths. Simple string concatenation alone was not a meaningful bottleneck in the reviewer's small synthetic check.

### P2 — Workflow-only scaling issues (not evidence for this Agrofortis slowdown)

References: `extensions/workflows/runner.ts:485-552`, `:593`; `extensions/workflows/dashboard.ts:229-280`, `:417-425`; `extensions/workflows/artifacts.ts:90-110`, `:155-167`.

Workflow children rebuild usage/transcripts from full history on message completion; repeated full-history work is cumulatively quadratic. The open dashboard polls at 500 ms and synchronously loads historical run files before filtering by session. Checkpoints synchronously serialize/write aggregate artifacts on the extension event loop.

**Fix:** incremental child state, cached historical metadata, session filtering before heavyweight reads, dirty-agent checkpoints, asynchronous writes, and bounded history retention. Keep artifact atomicity and cancellation semantics.

The sampled Agrofortis parent did not use `workflow`; these are latent issues for that feature, not its measured root cause.

### P2 — Fallback and failure states are hidden

References: `extensions/shared/herdr-workspace.ts:1112-1142`; `extensions/background-terminals/src/observer.ts:84-88`; `extensions/subagents/src/backends/pi.ts:700-705`; `extensions/subagents/src/backends/codex.ts:1137-1141`.

Observer errors become no-ops. Failed Herdr worker creation can become an in-process child. The practical execution environment changes without a clear user-facing explanation.

**Fix:** record `executionMode` (Herdr TUI / in-process / CLI), observer state, last integration error, and launch phase. Show a single unobtrusive degraded-mode notice. Preserve machine-readable Herdr error codes. Ensure a launch-acknowledgment failure cannot trigger duplicate execution after real work started.

### P2 — Dependency and instruction drift undermine reproducibility

- Global Pi coding-agent package: **0.85.1**.
- Local `node_modules/@earendil-works/pi-coding-agent`: **0.84.3**.
- `package.json` requests **^0.84.4**, which excludes both 0.84.3 and 0.85.x.
- `AGENTS.md` describes different coder/reviewer model routing from `subagents.json`.
- The public subagent tool description says in-process Pi sessions, while Herdr-enabled execution can instead be a full TUI process.

The installed-version mismatch is confirmed. Which SDK copy every loader resolves needs runtime provenance instrumentation; it is not safe to assume all imports are duplicated just from package presence.

**Fix:** pin and validate a supported SDK range, align installs/lockfiles deliberately, expose loaded package/version/path per parent and worker, and derive displayed routing/tool documentation from configuration. Do not upgrade packages underneath active sessions as part of an audit.

## Comparison with the reference setup

Sources:

- Video: https://www.youtube.com/watch?v=iKwPaB5TUdI — captions retrieved successfully; “Pi Setup After 6 Months of Use”, Eero Alvar.
- Implementation documentation: https://github.com/amosblomqvist/pi-interactive-subagents
- Configuration collection: https://github.com/amosblomqvist/pi-config

Useful ideas to adopt:

1. **Explicit minimal child loadout.** Its documented launcher disables normal extension discovery, enables only backing extensions for allowed tools, and snapshots the loadout for resume.
2. **Small interaction surface.** Spawn, message/resume, list, and child questions; stable names avoid making the model manage more lifecycle details than necessary.
3. **Completion-driven orchestration.** Parent is notified when work finishes or clarification is needed. Auto-exit must respect pending questions and running nested children.
4. **Optional heavy tools.** Browser tooling is off by default in the referenced setup.

Your implementation already has several of these interaction concepts. The main deficit is dependable lifecycle/ownership and predictable child loadouts, not the absence of tmux.

Do not copy blindly:

- Its tmux launcher still documents a shell-readiness delay (500 ms default), so readiness races do not disappear by switching multiplexers.
- The video is a demonstration, not a comparative latency benchmark.
- Observational memory moves summarization work into background agents. It is not free and would add another subsystem before the current ones are reliable.
- A compact public tool surface is useful, but hiding necessary cancellation/diagnostics would make failure recovery worse.

## Recommended implementation order

### Phase 1: reliability and immediate latency

1. Preserve ownership on uncertain close; add orphan reconciliation and concurrency tests.
2. Move observer creation out of `bg_start`'s critical path, with tracked async lifecycle.
3. Skip synchronous naming when a name is supplied.
4. Make backend selection and degraded visualization visible.
5. Enforce identical explicit child tool loadouts, including PowerShell and extension tools.

### Phase 2: reduce multiplied work

1. Separate parent and child extension bundles.
2. Reduce/deduplicate Git polling across workers in the same repo.
3. Add role-specific effort and soft context budgets; keep small edits in the parent.
4. Send compact results and optimize history-dependent UI work.
5. Align SDK dependencies and generated configuration documentation.

### Phase 3: measure and harden

Add correlated timestamps for: spawn requested, naming done, resources ready, process started, pane allocated, pane launch accepted, child first response, last meaningful progress, settled, result delivered, pane close confirmed.

Track per-run tool/context counts, event-loop delay, process/RSS, provider retries and first-token latency. Existing `/perf` is lightweight and useful but mixes unlike tools and omits these causal phases.

Proposed acceptance tests/targets (targets, not current measurements):

- `bg_start` returns within roughly one second locally even when Herdr is unavailable or slow.
- Caller-supplied names cause zero naming requests.
- No lost-owned panes after failed close, reload, aborted open, concurrent settle/open, or server restart.
- Parent and worker retain identical intended tool policy across backend/fresh/resume combinations.
- Repeated short jobs do not steadily increase workspace count, polling processes, or retained transcript memory.
- UI cost remains stable enough at 50/200/800-message synthetic histories; report p50/p95 rather than only averages.

Use a controlled A/B with the same task/model/effort: current setup, minimal child loadout, observer disabled, naming skipped. Measure first useful work and final verified completion—not just spawn return. No paid model benchmark was run in this audit.

## Verification performed

- `npm run check`: passed.
- Focused Herdr workspace, Herdr worker, profile, and result-delivery tests: **81 passed, 0 failed** (`tmp/pi-audit-focused.log`).
- Failed-close ownership reproduction: demonstrated two live fake workspaces after one failed close; no live Herdr mutation.
- `npm run format:check`: failed on existing formatting differences across many files; no autofix applied (`tmp/pi-audit-format.log`).
- `npm test`: background-terminal stage reported 66 passed / 0 failed / 4 skipped. Later stages reported failures in Git process and remote-agent lifecycle tests, then made no progress. The audit-owned full-suite process was stopped after approximately 16 minutes. This is NOT a green full-suite result (`tmp/pi-audit-tests.log`).
- Two-file failure rerun reproduced the Git process and three remote lifecycle failures and again failed to exit, despite a Node test timeout; stopped the audit-owned process after approximately four minutes (`tmp/pi-audit-failures.log`). A subsequent **Git-only rerun passed all 3 tests**. Treat that Git failure as timing/load-sensitive, not a confirmed production defect. Remote lifecycle tests remain failing/non-terminating on this Windows setup; their precise cause was not established.

## Conclusions deliberately not promoted to findings

- No detected agent is not proof that a plain PowerShell/tail observer never started.
- A newly numbered tab after the old tab closes is not itself a tab leak.
- Fast server requests separated by long gaps do not by themselves prove an overloaded JavaScript event loop.
- Historical source modification times do not prove a live session loaded the latest source.
- A failed close log can mean “already absent”; the code defect is the inability to distinguish that from a transport failure, not every logged close error.
- No evidence justifies calling tmux inherently faster for these workloads or recommending a full architecture rewrite before fixing the measured failure paths.
