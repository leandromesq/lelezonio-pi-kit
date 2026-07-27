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
- System `fd` and `rg` binaries; the file-search extension can provision supported builds when they are missing

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
