# Extension setup corrections — 2026-10-02

## Latest remote-agent reliability changes — 2026-10-22 UTC

- Busy Herdr history reads fall back to the visible screen only for agent_not_idle; real transport failures remain unreachable, never successful completion.
- New submissions carry unique markers and persist their binding with the generation. Session extraction rejects stale earlier answers, excludes later user turns and classifies error/aborted/output-limit responses instead of assuming success. Pending session flushes remain pending; remote_wait rechecks final validation, and delayed older-generation responses cannot overwrite a follow-up.
- Read-only preflight reports resolved Python/Pi/Herdr paths/versions and server health. NixOS per-user profiles precede legacy ~/.local/bin. Default remote concurrency is two; explicit configuration remains respected.
- Mac source changes prepare the Nix Herdr executable and required Worktrees backup scope. Parse/flake/build, isolated merged-unit verification and real candidate backup preflight passed; 16 Mac backup fixture tests pass. Candidate yaqspp83... is NOT activated; generation 41 and existing Herdr process remain untouched. A real successful expanded backup is still needed before claiming Worktrees coverage.
- Machine-only Mac resource guidance was applied (two light agents / one heavy job); no kernel quota or automatic process restart was introduced. No credentials, auth settings, firewall or backup retention changes.
- Full-suite runs exposed observer/watchdog tests relying solely on unref'ed deadlines with mocked requests and no live socket/process. Isolated cancellation was reproduced; both fixtures now explicitly keep the event loop alive, without changing production background-terminal or workflow behavior. Both isolated tests pass.
- A real SSH preflight through an isolated copy of the new helper selected Nix Pi 1.3.0 / Herdr 0.9.5, confirmed the server and Worktrees, and wrote metadata-only proof without changing the production helper or starting an agent/service.
- Extension source was promoted to the Mac only after exact preimage checks; 13 targeted files (extension plus the two test-only fixes) have backed-up preimages and recorded hashes. Local and remote TypeScript/format/required installed-runtime/full-suite gates pass: 630 tests, 628 passed, 2 skipped, zero failures/cancellations. Remote validation finished without a Pi reload or service/system restart; generation 41 and Herdr PID1052 remain active. Manual Nix activation and a successful actual Worktrees-expanded backup are pending.
- On continuation, the notebook installed runtime was found at Pi 1.4.0, while Mac and development pins remain 1.3.0. Required installed-runtime smoke and complete local suite were rerun successfully against the current notebook runtime; remote gates passed against Nix Pi 1.3.0. This task did not upgrade runtime/dependencies; coordinated alignment remains separate.
- Runbook and final validation: `~/homelab-migration/2026-10-19/pi-persistence-review/20261022-hardening/`. Physical notebook shutdown/reattach remains a separate human acceptance test. No pi-durable runner was installed.

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

## Homelab resumption and Pi 1.3 alignment (2026-10-19)

- A clean NixOS validation install exposed an undeclared `proper-lockfile` import in
  `codex-accounts`; declare it as a runtime dependency and its types for development.
- The laptop actually runs Pi 1.3.0. The user approved aligning all four SDK development
  pins, the lockfile, documentation, and the Mac mini's declarative runtime to 1.3.0.
- Pi 1.3 adds custom-message `before_agent_start` events without a user `prompt`.
  Auto-naming now ignores them before consuming its first-user naming opportunity;
  a regression test covers the custom-message path.
- Typechecks, formatting, the full local suite, and the required installed-runtime smoke
  test passed against `/usr/bin/pi` 1.3.0. The main extension block passed 598 tests,
  with two intentionally skipped tests; the other script and memory suites also passed.
  Remote runtime/build validation is separate; no system activation is authorized
  for the agent, and no successful remote result is implied by local tests.
- Preserve remote authentication and sessions. The user explicitly authorized transferring
  only the `opencode-go` credential over SSH and choosing `deepseek-v4.1-flash` on the Mac.
- The external APFS disk contains old macOS volumes and possible Windows backup data;
  inspection must remain read-only. No deletion, repartitioning, or formatting is approved.
- Remote staging typechecks and formatting passed after a clean dependency install.
  The Pi 1.3.0 Nix runtime built successfully; its required installed-runtime smoke test and
  the full kit suite passed on the Mac (main extension block: 598 passed, two skipped).
  A minimal no-tools DeepSeek request returned OK. The final full NixOS build completed;
  its output link resolves to a valid `nixos-system-macmini-26.11.20261015.fe13242` store path.
  The user activated the system in test mode. A stale standalone Home Manager profile and
  npm launcher shadowed the integrated runtime; declarative session/Bash PATH now prioritizes
  `config.home.profileDirectory/bin`, without removing either legacy installation.
- Runtime detection now recognizes the Nix `lib/node_modules/pi-monorepo` prefix through
  canonical Home Manager symlinks, validates its package manifest, and still rejects project-local
  SDKs. Regression coverage proves correct PATH priority over a later old npm installation.
  Required runtime smoke tests and full suites passed locally and in the active Mac kit;
  the Mac tests detected `/etc/profiles/per-user/leandrom/bin/pi` 1.3.0 without an override.
- The active Mac kit was fast-forwarded to the reference commit plus the same uncommitted
  local corrections. Auth/sessions were preserved; the user approved migrating memory to the
  vendored package. Main, observer/consolidator, naming and recap models use DeepSeek V4.1 Flash.
  A private Mac-specific AGENTS override replaces laptop-only assumptions without modifying
  the shared policy. DonSeTch updated successfully, and a real no-tools Pi run with the migrated
  extensions/memory returned OK. The user completed permanent activation to generation 37,
  retaining generation 36 for rollback, then rebooted successfully into kernel 6.18.56.
  Post-boot Wi-Fi/wl, SSH, Tailscale, Cockpit (HTTP 200), Home Manager, Pi 1.3.0 and Herdr
  0.9.5 were validated, with zero failed system/user units. Herdr's pre-reboot failed user unit
  was a duplicate-server conflict with a healthy manually started instance; reboot cleared it.
  The external HDD remains unchanged/APFS. SMART health is not yet established.
- The user approved temporary copies split between laptop and Mac SSDs, omitting only the
  previously identified photos in juceleia's Desktop. Rsync copy/checksum verification jobs
  completed and were verified by successful rsync checksum dry-runs plus strict review.
  The only accepted differences are symlink permission bits (`.L...p.....`): 8,667 on
  leandrom and 11,682 on juceleia; no content, target, or other differences remain.
  Durable status/summary records and the runbook are under `~/homelab-migration/2026-10-19`
  on the respective machines. The extended SMART test subsequently completed without error,
  with zero reallocated/pending/uncorrectable sectors or CRC errors. After the GPT/ext4
  explanation, the user explicitly authorized replacing ONLY the identified external Apple
  HDD's partitions with GPT and one ext4 partition. A guarded manual script was prepared;
  syntax/help/error checks and actual read-only preflight passed. The agent has not executed
  formatting. Both temporary SSD copies must remain until restoration is verified.
- The user's manual script created GPT/partition 1 but stopped before mkfs on the USB
  bridge's inconsistent optimal-I/O hint (65,535 sectors, not a 4 KiB multiple). The prepared
  partition begins at 1 MiB and is correctly aligned to the actual drive's SMART-reported
  4 KiB physical sectors. A separate guarded continuation binds the new PARTUUID, checks
  raw signatures and physical/minimum alignment, and formats only that partition with 4 KiB
  ext4 blocks. It does not recreate GPT. Its syntax/help/error and unprivileged preflight
  checks passed. After correcting the blkid guard to accept only the exact GPT-entry metadata
  (not filesystem signatures), the user successfully created ext4/HOMELAB with UUID
  `6a95d9a5-eb52-4d4f-80d0-03a9109cfd20`. The declarative `/srv/homelab` mount by this UUID,
  with nofail/10-second device timeout/nodev/nosuid/noexec, passed checks/build and was manually
  activated as generation 38. Its UUID/type/options and service health were verified.
  Private legacy/backups directories were manually provisioned as leandrom:users (0700).
- User-selected juceleia restoration completed on the HDD with ZERO checksum/metadata
  differences. The guarded persistent unit retained the approved photo exclusions and Mac SSD
  source. Julia's complete folder (including nested old trash) and Documents/wpps were separately
  restored from the notebook and verified with ZERO differences; notebook sources remain.
- Metadata-only review identified a Restic-shaped repository with three snapshot entries,
  old Zen/Safari/Notes/contacts/keychain data, tool history/configs and rebuildable caches.
  No personal documents or credentials were opened; these non-approved items remain preserved.
- Following explicit user approval of the cleanup recommendation, ONLY 13 exact targets were
  permanently removed: nine recorded old-backup trash entries (Windows plus selected caches),
  and old Downloads installers/.nvm/.npm/.homebrew. Original paths, trash timestamps, ownership,
  canonical paths/inodes and mount boundaries were checked. Secure fd-based deletion passed
  a read-only preflight and tests proving symlinks cannot redirect it to outside data. Active
  configuration, unrelated trash, personal source copies and Restic were not touched.
  Free notebook space increased from about 131 to 301 GiB; preserved old profile is 9.477 GiB.
  Historical original-snapshot checksum records predate the intentional scope changes. Final
  audit and durable restoration proofs are under `~/homelab-migration/2026-10-19`.

## Restic setup continuation (2026-10-21)

- Notebook's existing daily timer targeted an absent old Mac-home repository and failed with
  exit 10. The preserved 1.4 GiB Restic was opened read-only: three notebook snapshots from
  August 3/4. User chose fresh repositories and authorized retiring that history AFTER the
  new backup/recovery gates. Old repository/password remain intact during acceptance.
- Independent strong passwords were generated directly on each host, never printed or put in
  Nix store. User saved BOTH to personal Bitwarden through the stdin-only import helper;
  secret-free receipt confirms sync and read-back verification. Default-cloud CLI serverUrl
  can be null; helper resolves `bw config server` while still enforcing HTTPS (regression tested).
- Both new HDD repositories initialized/open-verified. Notebook SFTP uses a UUID/ext4/rw/private
  path/space guard on EVERY server session and relative cwd-pinned repository access; Mac local
  access also pins/checks the device, preventing lazy-unmount SSD fallback. This is not chroot
  or ransomware isolation; the existing trusted SSH account remains unchanged.
- Mac source-of-truth gained a reviewed Restic Home Manager module, with timers DISABLED pending
  acceptance. Nix parse/diff/flake/ShellCheck and full toplevel build pass; active generation 38
  is unchanged. Parent integrated reviewer fixes for runtime diffutils, exact snapshot binding,
  device checks in preflight and final mount revalidation. Mac fixtures: 11 pass, including real
  tiny encryption/wrong-password/integrity/recovery; notebook fixtures: 34 pass and ShellCheck clean.
- BOTH persistent first-backup/recovery jobs completed with full read-data integrity and exact
  receipt-bound marker restoration. Notebook processed about 5.35 GB; source data remains intact.
  No NixOS activation or active notebook-controller replacement has been performed by the agent.
- User explicitly approved 7 daily / 4 weekly / 6 monthly retention. Weekly maintenance first
  makes a fresh backup and passes full integrity/recovery, validates scoped dry-run JSON, then
  deletes ONLY the immutable planned IDs (never the fresh verified snapshot) and prunes.
  Mac implementation passed 15 fixtures, including real explicit-ID forget/prune/retained-data
  recovery, and REAL maintenance acceptance: exit0, verified snapshot kept, zero snapshots removed.
  User activated final system 13mjpcnp... as generation 39: daily/weekly Mac timers enabled,
  guard passes, zero failed system/user units. Notebook controller/four units are installed
  atomically with old-config preimages; parent tightened plan validation and ShellCheck, all
  44 fixtures pass. Real notebook production maintenance PASSED with full recovery/retention;
  persistent gate verified proof/hashes and enabled the SAME daily timer plus weekly timer.
  The daily timer immediately fired and also SUCCEEDED. Both hosts' timers are enabled/active,
  no failed Restic units; no extra root actions/reboots performed. User-authorized old August
  repo was then permanently retired, requiring exact three snapshot IDs/dates/host, empty locks,
  real owned/inode-checked path, successful production proof and active timers. Durable deletion
  audit is retained; old password and ALL personal SSD/media/config copies remain untouched.
  Backups are operational. User chose LOCAL-only failure alerts: notebook helper, OnFailure
  drop-ins and five-minute pending replay are installed; 10 fixtures plus real desktop and
  end-to-end labelled OnFailure tests pass. No actual backup failed and test units were collected.
  Alerts contain only whitelisted unit/result/time/host metadata, with 0600 records under 0700
  state; no logs/secrets/repository reads, external services or notification recursion.
  User activated Mac alerts ind8jg80... as generation 40, active/default matching. Both failure
  hooks/replay timer and a full labelled OnFailure integration test pass, no failed system/user
  units; backup schedules remain active. Mac has no graphical notification-daemon owner, so
  the test correctly stays local and real failures remain pending until a GUI daemon appears. See restic-alerts-setup/README.md in the
  migration runbook. Access-surface hardening remains the next open topic.
  Exact proofs, candidates, approved policy and manual activation steps are documented in
  `~/homelab-migration/2026-10-19/restic-setup/README.md` on both hosts.

## Gradual access hardening (2026-10-21, active generation 41)

- Read-only review found globally allowed TCP22/9090, SSH password/interactive auth enabled,
  root SSH prohibit-password, Cockpit on all interfaces, and globally routable Wi-Fi IPv6.
  Router/WAN filtering and tailnet ACL/account policy were not audited; no internet-reachability
  claim is made. Fresh non-multiplexed SSH succeeded with confirmed publickey authentication.
- User chose gradual policy: Cockpit allowed only on tailscale0; SSH key-only and no direct root,
  retaining TCP22 exposure as before. Console/sudo/account/Cockpit passwords and SSH forwarding
  unchanged. Direct Wi-Fi IPv4 path was unreachable before change, so LAN recovery isn't claimed
  as tested and it cannot prove before/after filtering. macmini resolves to Tailscale and 9090 works.
- Guarded source change in configuration.nix, backed up under pre-access-hardening-20261021-202714.
  Exact Nix values, parse/diff/flake/build/check-sshd-config all pass. User activated gy8zjgxg...
  as generation 41, active/default matching; agent did not activate or use privileges. Fresh
  non-multiplexed publickey SSH, live auth/root-denial fields, Cockpit HTTP200 via Tailscale and
  actual user-service Restic SFTP/repository preflight pass. Deployed ip46tables script scopes
  9090 accepts to tailscale0; no independent off-tailnet denial/certificate-trust test is claimed.
  Core services/timers active, zero failed units, recovery shell can close. Full rollback and
  retained port22/IPv6/ACL limitations: migration `access-review/README.md`.

## Limitations intentionally retained

- DonSeTch upstream remains unchanged and may still start daemons in independent Herdr processes.
  Excluding it from all in-process SDK children prevents their shutdown from affecting the parent;
  those children do not receive the package's web tools. Parent web tools remain active.
- Narrow tool surfaces are policy, not an OS sandbox.
- Subagents/workflows are not crash-resumable durable applications. No Pi Durable migration.
- Estimated parent-session cost is not a provider invoice or aggregate orchestration spend.
