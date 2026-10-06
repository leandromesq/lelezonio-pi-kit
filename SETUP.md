# Setup

Lelezonio Pi Kit is installed as the Pi agent directory itself. Do not install it with `pi install`, `npm install -g`, or as an npm package.

## Prerequisites

Required:

- [Pi](https://github.com/earendil-works/pi) 1.0
- Git
- Node.js 22.19 or newer
- A Bash-compatible shell available to Pi

Optional:

- [Codex CLI](https://github.com/openai/codex) for Codex subagents
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login` for `/git`
- An SSH-accessible host running [Herdr](https://github.com/epilande/herdr) for persistent remote agents
- System `fd` and `rg` binaries are optional; Pi's native search tools provision supported builds when missing
- A Chromium build (system, Playwright-cached, or Edge on Windows) for the optional DonSeTch tier-2 browser bypasses; tier-1 fetch and keyless search work without one

## Clean installation

Use this when `~/.pi/agent` does not exist or contains no state you need:

```sh
git clone https://github.com/leandromesq/lelezonio-pi-kit.git ~/.pi/agent
cd ~/.pi/agent
npm ci --omit=dev
npm --prefix extensions/browser ci --omit=dev
node extensions/browser/node_modules/playwright-core/cli.js install chromium
cp settings.example.json settings.json
```

Start Pi and authenticate with `/login`.

## Replace an existing setup safely

Pi keeps authentication, sessions, settings, trust decisions, and other private runtime data under `~/.pi/agent`. Back that directory up before replacing it.

### Bash

Exit Pi, then run:

```sh
mv ~/.pi/agent ~/.pi/agent.backup
git clone https://github.com/leandromesq/lelezonio-pi-kit.git ~/.pi/agent
cd ~/.pi/agent
npm ci --omit=dev
npm --prefix extensions/browser ci --omit=dev
node extensions/browser/node_modules/playwright-core/cli.js install chromium
cp settings.example.json settings.json
```

Restore private state selectively:

```sh
cp ~/.pi/agent.backup/auth.json ~/.pi/agent/ 2>/dev/null || true
cp ~/.pi/agent.backup/trust.json ~/.pi/agent/ 2>/dev/null || true
cp -R ~/.pi/agent.backup/sessions ~/.pi/agent/ 2>/dev/null || true
```

Copy any memory directories you intentionally use. Do not copy old `extensions/`, `skills/`, `node_modules/`, or npm package configuration over the new setup.

### PowerShell

Exit Pi, then run:

```powershell
$agent = Join-Path $HOME ".pi\agent"
$backup = Join-Path $HOME ".pi\agent.backup"
Move-Item $agent $backup
git clone https://github.com/leandromesq/lelezonio-pi-kit.git $agent
Set-Location $agent
npm ci --omit=dev
npm --prefix extensions/browser ci --omit=dev
node extensions/browser/node_modules/playwright-core/cli.js install chromium
Copy-Item settings.example.json settings.json
```

Restore private state selectively:

```powershell
Copy-Item "$backup\auth.json" $agent -ErrorAction SilentlyContinue
Copy-Item "$backup\trust.json" $agent -ErrorAction SilentlyContinue
Copy-Item "$backup\sessions" $agent -Recurse -ErrorAction SilentlyContinue
```

Copy any memory directories you intentionally use. Keep the backup until the new setup has been verified.

## Settings

[`settings.example.json`](settings.example.json) enables the bundled theme and disables package-based extension loading:

```json
{
  "theme": "noctalia",
  "tuiMode": "fullscreen",
  "quietStartup": "header",
  "packages": []
}
```

Merge any model, provider, retry, or keybinding preferences from your previous settings. Keep `packages` empty unless you deliberately want additional Pi packages alongside this repository.

## DonSeTch web research

[DonSeTch](https://github.com/dondai44423/donsetch) is an optional local research service that adds `web_search`, `web_fetch`, `web_crawl`, and `web_screenshot` to Pi. It is the successor to Hound (`dondai44423/master-fetch`): one self-contained Rust binary instead of a Python engine plus Playwright, with keyless search and no API keys required. It is recorded only in the user's private `settings.json`, not in this repository's tracked setup:

```sh
pi install npm:donsetch
```

The package ships a Pi extension that spawns the `donsetch mcp` binary and registers its tools natively, so there is no separate MCP client block to write. The install is deliberately unpinned: DonSeTch is actively released and `pi update --extensions` self-updates both the extension and the binary.

### Binary download

npm blocks `postinstall` scripts for packages that are not covered by `allowScripts`, so the binary a fresh install needs is not fetched automatically. The command differs by npm version: `npm install-scripts approve` on npm 12, `npm approve-scripts` on npm 11.17+. Pi's npm directory is approved once — unpinned, so the approval survives a version bump — and installs and updates then fetch the matching binary themselves:

```sh
cd ~/.pi/agent/npm
npm install-scripts approve donsetch --no-allow-scripts-pin   # npm 12
npm approve-scripts donsetch --no-allow-scripts-pin           # npm 11.17+
```

If the binary is ever missing, the extension downloads it at session start. To repair it without restarting Pi:

```sh
node ~/.pi/agent/npm/node_modules/donsetch/install.js
```

### CLI (optional)

The extension resolves the binary through the package; a `PATH` shim makes the CLI (`donsetch doctor`, `donsetch fetch`, `donsetch keys`) available in a terminal:

```sh
mkdir -p ~/.local/bin
ln -sfn ~/.pi/agent/npm/node_modules/donsetch/bin/donsetch.js ~/.local/bin/donsetch
```

Make sure `~/.local/bin` is on `PATH` before starting Pi:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

On Windows no shim is needed: `npm install -g donsetch` puts `donsetch` on `PATH` without administrator access.

### Verify

```sh
donsetch doctor          # fast local sweep, ~1 second
donsetch doctor --deep   # adds live browser and egress probes
```

DonSeTch reuses a Chromium build for tier-2 bot-wall bypasses. It auto-discovers system Chromium, Playwright's cached builds, or Edge on Windows. On Linux, `xvfb` keeps that browser headful/off-screen; without it tier 2 falls back to headless, which is less stealthy but still functional. Keyless search needs no API key; optional BYOK providers are added with `donsetch keys add <provider> <key>`.

### Migrate from Hound

Hound is superseded. Remove the Pi extension, then the Python engine if you no longer want it:

```sh
pi remove git:github.com/dondai44423/master-fetch@v13.2.0
pi remove npm:@houndmcp/hound-mcp-pi
```

Optional cleanup of the Hound engine itself (the Playwright Chromium it installed keeps working as DonSeTch's tier-2 browser):

```sh
rm -rf ~/.local/share/hound-venv ~/.local/bin/hound
```

The four tool names are unchanged, so nothing else in this setup depends on which engine serves them.

### Update

```sh
pi update --extensions   # latest package plus its matching binary
donsetch update          # binary self-update only
donsetch rollback        # revert the binary to the previous release
```

## Subagents

Configure named roles, per-harness defaults, and the concurrency cap in [`subagents.json`](subagents.json). A spawn can select a `profile`; explicit `harness`, `model`, and `reasoning_effort` values override it. Profile values override the selected harness defaults.

The included configuration runs every named profile on the Pi harness with `opencode-go/deepseek-v4.1-flash`: `planner`, `coder`, and `reviewer`. Profile-less spawns also default to the Pi harness and that model. The Codex harness keeps `gpt-5.6-luna` and is the only exception, reserved for subagents that call Codex CLI or when the Pi worker transport is unavailable. Replace unavailable models with entries from:

```sh
pi --list-models
```

Reload Pi after editing the configuration.

### Pi OpenAI account switching

Authenticate through Pi's `/login` with OpenAI (ChatGPT) or legacy OpenAI Codex, then save the current credentials with a portable account name:

```text
/codex save personal
```

Repeat after authenticating other accounts. Run `/codex` to choose a saved account. This switches **Pi's** login for the stored provider, not Codex CLI authentication. The next Pi request uses it; other providers are preserved. If both supported providers have OAuth credentials, `/codex save` prefers `openai` (ChatGPT). API-key entries are not treated as ChatGPT accounts.

Snapshots are stored under `~/.pi/agent/codex-accounts/`, or the configured `PI_CODING_AGENT_DIR`. Old raw `openai-codex` snapshots remain readable; new ChatGPT snapshots retain the provider and associated device metadata. These files contain secrets and must not be committed or shared.

### Native MCP and codemode

Pi 1.0 supports MCP without Codex CLI or an external MCP adapter. Configure user servers in `~/.pi/agent/mcp.json` and trusted-project servers in `.pi/mcp.json`; use `/mcp` for status and authentication. No MCP server is created by this kit.

The CLI loads native MCP/codemode/tool-search built-ins. Full-surface in-process subagents and workflow children explicitly add the same built-ins. Narrowed SDK profiles load codemode alone when their tool allowlist includes it; narrowed Herdr workers disable native MCP with `--no-mcp`. Do not use removal from the active set as a security boundary for `codemode`/`deferred` tools: the session's callable-tool allowlist must exclude unauthorized extension tools too.

This setup enables codemode with `codemode.mode: "on"`, retaining direct tool calls alongside scripts. Private settings use `"defaultTools": ["+grep", "+find", "+ls", "+codemode"]` to add native search and codemode while preserving inherited defaults; the example settings include it in their explicit tool list. The `planner` and `reviewer` profiles allow only `read`, `grep`, `find`, `ls`, and `codemode` (plus their model-only clarification tool), without shell, mutation tools, or native MCP. Codemode is a tool-composition sandbox, not an OS security sandbox. `ask_user`, `workflow` and `subagent_*` stay model-only and are invoked directly, never inside a script. Browser tools remain default-off behind `/browser on` and follow the current history branch.

## Remote agents

The `remote-agents` extension delegates persistent Pi jobs to a host running Herdr. Remote jobs survive local Pi shutdown, reload, and temporary network loss.

Prerequisites:

1. Configure an SSH host alias such as `macmini`.
2. Ensure `ssh -o BatchMode=yes macmini true` succeeds without prompting. On Windows, load an encrypted key into the Windows OpenSSH agent.
3. Install and start Herdr on the remote host.
4. Ensure Herdr can launch Pi on the remote host.
5. Create the local configuration:

   ```sh
   cp remote-agents.example.json remote-agents.json
   ```

Edit `remote-agents.json` for the machine being configured:

```json
{
  "host": "macmini",
  "sshExecutable": "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
  "remoteHelper": "/Users/remote-user/.local/share/pi-remote/helper.py",
  "projectsRoot": "/Users/remote-user/Projects",
  "worktreesRoot": "/Users/remote-user/Worktrees",
  "pollIntervalMs": 3000,
  "maxConcurrent": 3
}
```

Use `"sshExecutable": "ssh"` on systems where SSH is available through `PATH`. Local Git repositories resolve by repository name beneath `projectsRoot`, preserving the current subdirectory. When a project is absent, `/remote` asks before cloning its credential-free origin. Only one active remote writer is allowed per project. Non-Git sessions use `worktreesRoot`. The extension does not synchronize dirty Git state.

The Python helper is uploaded automatically to `remoteHelper` through SSH. It requires Python 3 and invokes `/usr/local/bin/herdr` on the remote host.

Commands:

- `/remote <instructions>` starts a persistent remote job with a filtered, redacted parent-session context capsule.
- `/remotes` opens the remote job dashboard; press `d` to close and forget an entry.
- `/remote-clean` closes and forgets all settled stale workspaces.

The model can use `remote_spawn`, `remote_check`, `remote_list`, `remote_send`, `remote_wait`, and `remote_cancel` when remote execution has been explicitly requested or approved. Blocked-agent questions are delivered to the parent session automatically and can be answered with `remote_send`.

Runtime job metadata is stored under `remote-agents/` and the machine-specific `remote-agents.json` is intentionally ignored by Git.

Automatic results belong to the originating Pi session, not whichever dashboard polls first.
Herdr child workers do not start remote reconciliation, and SDK/Herdr child tool policies exclude
`remote_*`. Legacy unowned jobs remain visible; an explicit `remote_check`, `remote_send`,
`remote_wait`, or `remote_cancel` adopts an unowned job for the current session. Inspection of an
already-owned job does not transfer ownership. Delivery leases prevent concurrent live managers
from sending the same result, but registry and Pi transcript commits are not one transaction:
this is not a promise of exactly-once delivery across a process crash.

Dashboards close with the configured selection-cancel shortcut (normally Esc/Ctrl+C), without
cancelling jobs. Press `x` twice on the same selected active job to cancel it. In a transcript
view, the configured clear shortcut (normally Ctrl+C) similarly requires a second press before
cancellation; Esc closes without stopping work.

## Recaps and auxiliary model work

Recaps remain enabled in automatic mode, but skip runs below the configured `minToolCalls`
threshold (default one tool call). `/summary-mode auto|manual|off` controls automatic generation;
`/recap` requests the latest run's recap on demand, regardless of automatic mode. Generated
content and local fallback stay in pt-BR; interface labels remain English. Expanded recap details
show the recap model's reported cost when available.

The footer's `est. session` amount is the parent session's estimated model usage, not a provider
invoice or aggregate spend for memory, naming, recaps and child agents. `/om:status` labels its
worker estimate separately. No setup presets are created and the existing packages remain active.

## Native file search

The setup enables Pi's native `grep`, `find`, and `ls` tools. `grep` uses ripgrep and `find` uses fd; Pi itself resolves system binaries or provisions supported builds under `~/.pi/agent/bin/` on demand. No separate search extension is required.

The former `file-search` source is preserved in `archive/file-search/`, outside automatic extension discovery. It is not loaded or tested as part of the active kit. Native search returns textual results rather than the old extension's structured output and advanced flag surface.

If automatic provisioning does not support your platform, install both binaries with your system package manager and restart Pi.

## Fullscreen TUI

Fullscreen scroll bindings belong in `keybindings.json`, not `settings.json`. This kit binds
`ctrl+shift+up/down` to half-page scrolling and `alt+shift+up/down` to previous/next prompt,
so the two actions do not compete for the same shortcut.

The setup enables Pi's native fullscreen TUI through `"tuiMode": "fullscreen"` in `settings.json`. The transcript scrolls independently while queued messages, status, widgets, editor, and footer remain fixed at the bottom. The extension leaves Pi 1.0's native startup header untouched. `"quietStartup": "header"` shows the native logo/version/key hints while hiding the verbose resource listing; the custom dashboard and thinking-colored editor remain.

Change `tuiMode` to `"regular"` if you prefer the terminal's native scrollback, or disable `quietStartup` if you want the complete loaded-resource listing on every launch.

## Observational memory (optional)

The kit uses a pinned [local adaptation](vendor/pi-observational-memory/README.md) of
[amosblomqvist/pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory),
not the elpapi42 npm package. Isolated headless Pi workers observe raw-history chunks; a
consolidator writes per-topic Markdown, `INDEX.md`, and `JOURNEY.md` under
`<project>/.memory/<session-id>/`. Compaction renders this memory deterministically.

Add `"./vendor/pi-observational-memory"` to `packages` in private `settings.json`, replacing
any previous observational-memory package entry. Never load both implementations. Restart
Pi after changing the package. This local adaptation preserves the upstream MIT license and
pinned provenance; it does not automatically receive upstream updates.

The new ledger uses `om2.*` to avoid confusing legacy elpapi42 observations with the new
schema. Old session entries and memory data remain intact, but are not automatically converted
into topic files. Historical `recall` IDs belong to the old implementation, not the new one.
Topic files are session-wide: navigating `/tree` changes branch observations/gating but does
not rewind existing Markdown. A fork seeds its own memory directory.

Example private settings (use a cheap authenticated model available in your installation):

```json
{
  "observational-memory": {
    "enabled": true,
    "chunkTokens": 10000,
    "chunkOverlapTokens": 0,
    "poolTargetTokens": 20000,
    "consolidateAtPoolTokens": 30000,
    "compactAtContextTokens": 0,
    "tailTokens": 20000,
    "journeyTargetTokens": 4000,
    "observerConcurrency": 1,
    "timeoutMs": 300000,
    "maxTurns": 16,
    "models": {
      "observer": {
        "provider": "opencode-go",
        "id": "deepseek-v4.1-flash",
        "thinking": "low"
      },
      "consolidator": {
        "provider": "opencode-go",
        "id": "deepseek-v4.1-flash",
        "thinking": "low"
      }
    },
    "passive": false,
    "debugLog": false
  }
}
```

- `enabled` is the initial fallback; `/om on` and `/om off` persist branch-local overrides.
- `compactAtContextTokens: 0` leaves automatic compaction to Pi's native window-pressure
  policy. `/om:compact` remains available. A positive value opts into earlier compaction.
- `/om:status` reports memory/worker state; `/om:consolidate` requests consolidation.
- `chunkOverlapTokens` is reserved by upstream and currently has no effect; leave it at zero.
- `timeoutMs` and `maxTurns` bound worker lifetime/turns; interrupted batches remain eligible
  for retry rather than being marked covered or consolidated. Coverage is committed in order,
  including successfully completed empty chunks. If coverage is missing or too far behind,
  compaction falls back to Pi's native model summary (which can incur additional model cost).
- Worker sessions are inspectable, but incur model cost. Low concurrency limits simultaneous
  process/model load; it does not eliminate total memory-worker spend.
- Memory and worker artifacts can contain sensitive conversation content. Add `.memory/` to
  each project's `.gitignore`; do not commit or publish those files.

This repository keeps the extension out of child sessions, where background memory work is cost
without benefit:

- Herdr workers receive `PI_SUBAGENT=1` / `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` in the launcher spec;
  the local build's factory returns before registering any hooks or tools.
- In-process children filter the package out of their resource loader
  (`CHILD_EXCLUDED_EXTENSION_PATHS` in `extensions/shared/child-session.ts`).
- To disable it, remove the local source from `packages` and drop the `observational-memory`
  block. Keep memory/session data if you may want it later.

Use a modest global compaction reserve (the example uses 24000 with 20000 recent tokens).
For an exact model that needs different budgets, set `compaction.modelOverrides` keyed by
`provider/modelId`. Keep reserve plus recent tokens comfortably below its context window.
A global 120000-token reserve would leave only 8000 tokens before compaction on a 128k model.
The memory package's proactive trigger and Pi's own context-pressure compaction are separate
thresholds; both should leave useful room for raw history.

## Startup performance

Run `npm run benchmark:startup` after a development install to compare fresh-process
extension-loader costs. It does not start sessions, call models, connect SSH, or perform
web-daemon handshakes, so it is not a complete interactive-startup benchmark.

On this Windows setup (2026-10-02), three samples measured roughly 12–17 ms for the empty
loader versus 495–554 ms for the 20 kit extensions, excluding SDK import time and optional
packages. Individual times cannot be added: extensions share dependency/module caches.
The browser was only 31–37 ms; Chromium remains lazy.

- Native `grep`/`find` provision rg/fd on demand; `file-search` has been archived.
- DonSeTch still starts its supervised daemon in an awaited `session_start`; this is an
  additional startup cost not measured above. Keep it for web research, or disable the
  optional package through `pi config` when unused. All in-process SDK children omit
  DonSeTch to prevent a child's shutdown from killing the parent's cached transport.
  Independent Herdr CLI workers still load the upstream package; its code is not patched.
- Pi's native `grep`/`find`/`ls` now replace file-search; its old structured output is not part of the active setup.
- Auto-naming and recaps are optional model work after prompting, not demonstrated startup
  bottlenecks. The custom dashboard is also optional; this setup retains it intentionally.
- No whole extension is removed solely for performance. Further lazy-import changes need
  measurement and lifecycle/isolation regression tests, not guesses.

## Updating

```sh
cd ~/.pi/agent
git pull --ff-only
npm ci --omit=dev
npm --prefix extensions/browser ci --omit=dev
node extensions/browser/node_modules/playwright-core/cli.js install chromium
```

Review local changes to `subagents.json`, `AGENTS.md`, or skills before pulling. Runtime/private files remain untracked.

## Development installation

To run TypeScript checks, formatting, and tests, install dev dependencies:

```sh
cd ~/.pi/agent
npm ci
npm run check
npm test
npm run format:check
```

The Pi development dependencies are pinned to 1.0.4, matching the current installed runtime.
When updating Pi, align these versions and the lockfile, then run both the local suite and
`npm run test:runtime`. The installed-runtime smoke test is also included in `npm test`;
it exercises isolated child lifecycle, native-extension loading, and callable-tool restrictions
without real model requests or personal credentials. Detection scans the `pi` launchers on
`PATH`, skipping this repository's local SDK even when npm prepends `node_modules/.bin`.
Set `PI_INSTALLED_RUNTIME_PATH` to the installed package directory for custom or Windows
installations. If no importable installed SDK is available, the smoke test explicitly skips;
set `PI_INSTALLED_RUNTIME_REQUIRED=1` in CI to fail instead. An invalid explicit path fails.

```sh
PI_INSTALLED_RUNTIME_REQUIRED=1 npm run test:runtime
```

The subprocess runs offline in a temporary agent directory, with a 60-second deadline.
No change to project trust is required; personal `defaultProjectTrust` remains `"always"`.
