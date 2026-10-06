# Extension setup corrections — 2026-10-02

## User constraints

- Keep current resources active; do not create setup presets.
- Replace only file-search with native Pi search. Preserve snippets and all other extensions.
- Do not vendor or patch DonSeTch. Mitigate ownership in the kit and record upstream limitations.
- Preserve native startup header, custom dashboard/editor, memory data and remote jobs.

## Parent integration

- Archived `extensions/file-search` at `archive/file-search` (source retained, not auto-loaded).
- Enabled native grep/find/ls in private and example settings. Pi provisions rg/fd itself.
- Added a real native-search fixture and removed the old package's active test/benchmark wiring.
- Git fallback polling: 60 seconds parent / 120 seconds Herdr worker; idle fallback five minutes.
  Input/mutation/explicit refresh paths remain eager and debounced.
- Git diff overlay uses injected selection/page/close keybindings and accurately reports them;
  Vim navigation aliases remain supported. Added rebound-key behavioral test.
- Moved fullscreen scroll assignments from ineffective settings keys to keybindings.json.
  Half-page scrolling and previous/next prompt have non-conflicting assignments.
- OM completed fixes verified independently: dead footer computations removed, bounded shutdown
  drain for all workers, theme-aware bounded transient widget, responsive /om:status overlay.
  Status uses committed coverage (including empty chunks) and labels worker spend as an estimate.

## UI integration completed

- Recaps remain in automatic mode, skip trivial runs below minToolCalls (default one), and add
  `/summary-mode auto|manual|off` plus on-demand `/recap`. Session/tree/shutdown invalidate pending
  recaps. Local fallback content matches pt-BR model content; warning messages are bounded.
- Footer labels the parent-session estimate explicitly; auxiliary worker spend is not silently
  merged into that number. Expanded recap detail exposes reported auxiliary cost.
- Snippet composition is unchanged; the active widget stays one line and collapses overflow to +N.
- Kit/account text now identifies Pi provider credentials, not Codex CLI or an active-model switch.
- Dashboard selection-cancel closes without cancelling jobs. `x` arms cancellation for an active
  selected job; a second `x` confirms. Transcript takeover clear likewise requires two presses,
  while Esc closes. Subagent count appears once and hints follow configured keybindings.

## Remote integration completed

- Remote jobs record the originating session id. Unowned legacy jobs remain inspectable and can
  be adopted explicitly by remote_check/send/wait/cancel; other sessions cannot steal owned results.
- Claim leases carry a unique manager token, session and run generation. Owner checks and registry
  locking serialize live delivery; late releases/settles cannot invalidate a newer claimant.
- Stale wholesale saves preserve authoritative delivery fields; older generations are ignored.
- Deliveries refresh before claiming, then recheck session/owner/generation synchronously before
  queueing a Pi message. Errors notify only the live originating UI, without console writes.
- Herdr child startup does not initialize remote polling. All remote_* tools are excluded by
  child policy, and DonSeTch is filtered from all in-process SDK child extension resources.
- Historical worker discovery and tail reads use asynchronous file handles and remain inspect-only.
  Detached restoration is epoch-guarded across session replacement/shutdown, and discovery failures
  are caught so they cannot produce an unhandled rejection.

## Verification

- Native search fixture passed with actual Pi-provisioned fd/rg.
- Git-owned regression suite: 18 passed.
- OM: 37 passed / 1 POSIX-only skip plus 115 vendor tests, including parent status-label refinement.
- UI agent: 144 owned tests passed; overlay controls: 20 owned tests passed.
- First integrated run found only an outdated Herdr tool-denylist expectation; that expectation
  was corrected and its 24 parser tests passed. Remote agent's final full suite passed after fixing
  same-session claim races, stale state and ownership guards. Parent's independent run also passed.
- Final parent `npm run check && npm test`: exit 0, **819 passed / 0 failed / 10 skipped**.
  Native search 1; OM regression script 37 + 1 skip; vendor OM 115; background terminals 76 +
  4 skips; kit Node tests 590 + 5 skips. Post-review restoration guard: 13 targeted tests and
  both typecheck projects also passed.
- Changed-file formatting passed. Global `npm run format:check` still reports style drift in
  76 existing unrelated files; no repo-wide cosmetic rewrite was performed.

## Codemode setup follow-up

- Enabled codemode in `on` mode alongside direct tool calls in private and example settings.
- `planner` and `reviewer` explicitly allow `read`, `grep`, `find`, `ls`, and `codemode`;
  their model-only clarification tool remains available.
- Narrowed SDK children load codemode separately from native MCP/tool search. Narrowed Herdr
  launches disable native MCP; both backends must prevent unlisted MCP tools from remaining
  callable, since Pi's ordinary non-MCP allowlist intentionally preserves MCP registrations.
- Full-surface coders and workflow children keep native MCP support. No MCP server was added,
  and no upstream package was patched.
- Integrated `npm run check && npm test`: exit 0, **831 passed / 0 failed / 2 skipped**.
  This includes a fresh/resume Herdr regression for the read-only codemode allowlist.
- Also ran five native-extension/codemode security tests against the installed Pi **1.0.4**
  SDK, not just the repository's **1.0.0** dependency: all passed. Actual scripts can read,
  but cannot call shell/mutation, unlisted extension/deferred, or unauthorized MCP tools.
  A real MCP process fixture verifies no narrowed-child startup, with a full-child positive control.
- Global and changed-file formatting checks passed; private settings JSON was separately
  validated and formatted because it is gitignored.

## Pi 1.0.4 maintenance follow-up

- Aligned the four Pi development dependencies and the lockfile with the installed 1.0.4
  runtime, including its native MCP/codemode and security-related transitive updates.
- Personal `defaultTools` now adds `grep`, `find`, `ls`, and `codemode` while retaining
  inherited defaults. Preserved `defaultProjectTrust: "always"` at the user's request.
- Added `npm run test:runtime`, also included in `npm test`, to smoke-test isolated child
  lifecycle, native-extension loading, and callable-tool restrictions against the installed SDK.
- Dependency audit still reports four development-tooling advisories (three moderate and one
  high, via Vitest/Vite/source-map-js). No unrelated automatic audit fix was applied.
- Integrated `npm run check && npm test`: exit 0, **834 passed / 0 failed / 2 skipped**.
  The installed-runtime wrapper adds three tests and verifies six actual SDK child tests against
  `/usr/bin/pi`'s 1.0.4 package, not npm's prepended local `.bin/pi`.
- Required-runtime smoke test passed. Missing-runtime skip, required-runtime failure, and
  invalid-override failure were also exercised independently; none silently used the local SDK.
- Typechecks, global formatting, private-settings formatting, and `git diff --check` passed.
  No real model requests, remote execution, trust changes, or upstream package patches were used.

## Limitations intentionally retained

- DonSeTch upstream remains unchanged and may still start daemons in independent Herdr processes.
  Excluding it from all in-process SDK children prevents their shutdown from affecting the parent;
  those children do not receive the package's web tools. Parent web tools remain active.
- Narrow tool surfaces are policy, not an OS sandbox.
- Subagents/workflows are not crash-resumable durable applications. No Pi Durable migration.
- Estimated parent-session cost is not a provider invoice or aggregate orchestration spend.
