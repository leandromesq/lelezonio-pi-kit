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
- Python 3.11+ if you want the optional Hound web-research tools

## Clean installation

Use this when `~/.pi/agent` does not exist or contains no state you need:

```sh
git clone https://github.com/leandromesq/lelezonio-pi-kit.git ~/.pi/agent
cd ~/.pi/agent
npm ci --omit=dev
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
  "theme": "github-dark-default",
  "packages": []
}
```

Merge any model, provider, retry, or keybinding preferences from your previous settings. Keep `packages` empty unless you deliberately want additional Pi packages alongside this repository.

## Hound web research

Hound is an optional local MCP service that adds `web_search`, `web_fetch`, `web_crawl`, and `web_screenshot` to Pi. It has two parts: the Pi extension and the Python engine. Install both; the commands below keep the engine isolated from system Python and install the extension globally rather than adding it to this repository's `packages` array.

### Install on Linux or macOS

```sh
python3 -m venv ~/.local/share/hound-venv
~/.local/share/hound-venv/bin/python -m pip install --upgrade "hound-mcp[all]"
~/.local/share/hound-venv/bin/python -m playwright install chromium

mkdir -p ~/.local/bin
ln -sfn ~/.local/share/hound-venv/bin/hound ~/.local/bin/hound
```

Make sure `~/.local/bin` is on `PATH` before starting Pi:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Install the Pi extension globally:

```sh
pi install npm:@houndmcp/hound-mcp-pi
```

Verify the engine and browser dependencies:

```sh
hound --version
hound --doctor
```

Restart Pi after installing or updating the extension. Hound's keyless search needs no API key. Keep the extension and engine reasonably up to date together; the extension warns when their major versions diverge:

```sh
hound -u
pi update npm:@houndmcp/hound-mcp-pi
```

## Subagents

Configure named roles, per-harness defaults, and the concurrency cap in [`subagents.json`](subagents.json). A spawn can select a `profile`; explicit `harness`, `model`, and `reasoning_effort` values override it. Profile values override the selected harness defaults.

The included configuration reserves Codex for the `planner` profile and uses OpenCode models for `coder` and `reviewer` to conserve Codex subscription usage. Replace unavailable models with entries from:

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

## Fixed editor compatibility

The custom editor is pinned to the terminal bottom by default. If a terminal does not render it correctly, start Pi with:

```sh
PI_UI_FIXED_EDITOR=0 pi
```

PowerShell:

```powershell
$env:PI_UI_FIXED_EDITOR = "0"
pi
```

## Updating

```sh
cd ~/.pi/agent
git pull --ff-only
npm ci --omit=dev
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
