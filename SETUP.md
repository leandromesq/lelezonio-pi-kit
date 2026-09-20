# Setup

Lelezonio Pi Kit is installed as the Pi agent directory itself. Do not install it with `pi install`, `npm install -g`, or as an npm package.

## Prerequisites

Required:

- [Pi](https://github.com/earendil-works/pi-mono)
- Git
- Node.js 22 or newer
- A Bash-compatible shell available to Pi

Optional:

- [Codex CLI](https://github.com/openai/codex) for Codex subagents
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login` for `/git`
- An SSH-accessible host running [Herdr](https://github.com/epilande/herdr) for persistent remote agents
- System `fd` and `rg` binaries; the file-search extension can provision supported builds when they are missing
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
  "quietStartup": true,
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

### Codex account switching

Authenticate Codex CLI normally, then save the current credentials with a portable account name:

```text
/codex save personal
```

Repeat after authenticating other Codex accounts. Run `/codex` to choose a saved account. The selected credentials apply to new Codex CLI processes and future Codex subagents; already-running processes are unchanged.

Credential snapshots are stored under `~/.codex/accounts/`, or under `$CODEX_HOME/accounts/` when `CODEX_HOME` is set. They contain secrets and must not be committed or shared.

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

## `fd` and `rg`

The file-search extension registers `fd` and `rg` as model tools. At startup it prefers system-installed binaries, then existing fallback binaries under `~/.pi/agent/bin/`. When neither exists, it can download official release binaries on supported platforms.

If automatic provisioning does not support your platform, install both binaries with your system package manager and restart Pi.

## Fullscreen TUI

The setup enables Pi's native fullscreen TUI through `"tuiMode": "fullscreen"` in `settings.json`. The transcript scrolls independently while queued messages, status, widgets, editor, and footer remain fixed at the bottom. It also enables Pi's supported `"quietStartup": true` setting so the custom header stays clean without mutating Pi's internal component tree; resource conflicts and diagnostics remain available through Pi's configuration surfaces.

Change `tuiMode` to `"regular"` if you prefer the terminal's native scrollback, or disable `quietStartup` if you want the complete loaded-resource listing on every launch.

## Observational memory (optional)

[`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) keeps long
sessions coherent across compactions: it records observations and reflections in the background
and renders that memory deterministically when Pi compacts, instead of asking a model to
re-summarize the session at that moment. It is a third-party package, installed into the private
`settings.json` (not tracked here):

```sh
pi install npm:pi-observational-memory@3.1.3
```

Recommended private settings: use a cheap dedicated worker model instead of the session model,
bound the observer chunk (the derived default is 20% of the worker's context window, which is
200k tokens on a 1M model), and scale the proactive compaction trigger with the active model
window instead of the calibrated ~81k default:

```json
{
  "observational-memory": {
    "model": {
      "provider": "opencode-go",
      "id": "deepseek-v4.1-flash",
      "thinking": "low"
    },
    "observerChunkMaxTokens": 30000,
    "compactAfterTokensMode": "ratio",
    "compactAfterTokensRatio": 0.5,
    "showWorkerNotifications": false
  }
}
```

Tuning notes:

- `compactAfterTokensRatio` is a policy decision, not a bug: 0.5 compacts a 1M-token model around
  500k source tokens, well before Pi's own window-pressure threshold (`contextWindow -
reserveTokens`). Raise it to keep more raw context, lower it if latency matters more than range.
- `/om:status` shows memory counts and the resolved compaction threshold; `/om:view` copies the
  rendered memory. Set `debugLog: true` to write `~/.pi/agent/observational-memory/debug/<session>.ndjson`
  while diagnosing.

This repository keeps the extension out of child sessions, where background memory work is cost
without benefit:

- Herdr workers receive `PI_OBSERVATIONAL_MEMORY_PASSIVE=1` in the launcher spec
  (`extensions/subagents/src/backends/herdr-worker.ts`, `writeWorkerLaunchSpec`).
- In-process children filter the package out of their resource loader
  (`CHILD_EXCLUDED_EXTENSION_PATHS` in `extensions/shared/child-session.ts`).
- Removing it: `pi remove npm:pi-observational-memory` and drop the `observational-memory` block.

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
