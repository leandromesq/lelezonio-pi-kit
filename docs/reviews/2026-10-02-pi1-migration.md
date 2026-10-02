# Pi 1.0 migration — 2026-10-02

## User decisions

- Targeted corrections and modernization, not a Pi Durable migration/prototype.
- Use the amosblomqvist observational-memory alternative, adapted locally.
- Preserve Pi's native startup header; keep the custom dashboard/editor.
- Identify measured startup costs before removing useful extensions.

## Implemented kit changes

- Host packages are peers; development dependencies match Pi 1.0.0.
- Shared SDK child resources/teardown replace duplicated backend helpers.
- Full-surface SDK children explicitly load native MCP/codemode/tool-search;
  narrowed children keep a real callable-tool allowlist and no native MCP servers.
- Orchestration/interactive tools use model-only exposure; fd/rg return structured output.
- Browser opt-in and title-generation history follow the current branch.
- Dashboard accounts for native assistant/tool, cache-warm, compaction and branch-summary usage.
- Auxiliary title/recap requests use the host's provider-neutral stream API.
- Accounts support ChatGPT's openai OAuth provider without dropping legacy openai-codex snapshots;
  no real credentials were inspected or changed during testing.
- Global compaction reserve is 24000, recent history 20000; 256k/272k models have overrides.
- Native startup header is untouched; quietStartup is "header".
- fd/rg resolve binaries on first use, not session_start.
- Narrowed SDK children omit DonSeTch when their allowlist contains no web tools.

## Memory adaptation

Source: https://github.com/amosblomqvist/pi-observational-memory
Pinned commit: `78a1efcfdd46332253fb289724f05b26dfc7769e`.
Local source: `vendor/pi-observational-memory/` (MIT).

The old elpapi42 ledger/data remain intact. New entries use `om2.*`; this is isolation,
not an automatic migration. Historical recall IDs are not the new fork's topic-file format.
Topic Markdown is session-wide and does not rewind with /tree. `.memory/` must stay private.

Private policy: enabled by default, 10000-token chunks, one observer, 20000/30000-token
pool thresholds, five-minute worker deadline, 16-turn cap, cheap dedicated worker models.
Automatic proactive compaction is disabled; native Pi compaction remains authoritative.

Independent review's coverage and acknowledgement blockers are fixed. Observer completions commit
contiguously, successful empty chunks have durable coverage, and failed windows retry from the
last committed frontier. Acknowledgements require durable writes or explicit batch discard.
Consolidator exclusivity lasts until subprocess exit; late workers cannot notify a dead context.
Missing/lagging coverage declines the custom compaction so Pi's native summary can free context
without omitting unobserved history. Worker paths and costs remain pinned to their originating run.

## Follow-up: footer and Windows worker launch

- User requested no persistent OM footer: attach clears the old `om` status, and gauge/cost
  updates no longer publish it. `/om:status` and transient worker widgets remain available.
- `spawn ENAMETOOLONG` came from putting large history chunks in the Windows command line.
  Both observer and consolidator now pipe the initial message to `pi -p` stdin, with EOF and
  EPIPE handling; the message is still recorded in the worker's session.
- Added a real subprocess regression delivering a large Unicode prompt intact via stdin,
  plus early-exit/EPIPE and footer/widget regressions. Memory tests: 33 + 102 passed;
  root/vendor typechecks passed. Full follow-up `npm test`: exit 0, **776 passed, 0 failed,
  9 skipped**. Global formatting still reports the same 88 pre-existing files.

## Startup measurements

`npm run benchmark:startup` uses fresh processes and no session_start/model/SSH calls.
It excludes optional packages, themes, context-file discovery and interactive rendering.

Three samples on this Windows machine:

| Loader case                | milliseconds (range) |
| -------------------------- | -------------------: |
| Empty                      |                12–17 |
| 20 kit extensions          |              495–554 |
| Subagents alone            |              216–256 |
| File-search alone          |              348–367 |
| Git-info alone             |              348–360 |
| Background terminals alone |              190–216 |
| Workflows alone            |                49–57 |
| Browser alone              |                31–37 |

SDK import itself was measured separately (~0.75 s); this is not the native CLI's startup
latency. Individual extension times must not be summed: dependency caches are shared.
DonSeTch's awaited daemon handshake is another startup candidate, not measured by this test.
Chromium already starts lazily. Native grep/find/ls can replace fd/rg if structured results
are unnecessary; that trade-off is optional. No whole extension was removed speculatively.

## Verification and limitations

- Final `npm run check && npm test`: exit 0. Total: **773 passed, 0 failed, 9 skipped**.
  Memory regression script 31; vendored upstream tests 101; background terminals 76 + 4 skipped;
  kit Node tests 541 + 5 skipped; file-search 24.
- `npm run test:memory` includes both local adaptation regressions and the upstream vendor suite.
- Repository-wide `npm run format:check` still fails for pre-existing style drift; changed files
  are checked separately. Vendor adaptation retains upstream tab-based formatting.
- POSIX shebang SSH fixtures now explicitly skip on Windows; this is not a Windows SSH test.
- Git process fixture startup tolerance increased; the actual timeout regression remains short.
- Node test-file concurrency bounded to four to avoid oversubscribing subprocess fixtures.
- Repository-wide formatting already had extensive pre-existing drift; changed files are formatted
  separately rather than rewriting unrelated sources.
- No live model requests, real authentication changes, remote execution, deployment or publication
  were used for verification.
