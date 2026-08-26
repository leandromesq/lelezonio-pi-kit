# Lelezonio Pi Kit

My complete, opinionated setup for [Pi](https://github.com/earendil-works/pi-mono): local extensions, skills, theme, subagent profiles, and development tooling.

This repository is the setup itself. It is **not an npm package or Pi package**—install it by cloning it as your Pi agent directory.

## Highlights

- Fixed-bottom editor with a compact custom dashboard and color-coded thinking level
- Curated theme collection (Noctalia by default)
- Named Pi/Codex subagent profiles with configurable models and thinking effort
- Fast Codex CLI account saving and switching with `/codex`
- Multi-agent workflows with phased and parallel execution
- Subagents spawn as real interactive Pi/Codex TUIs in a shared `Pi Workers` Herdr workspace when running inside Herdr (in-process fallback outside Herdr), with live pane take-over from `/subagents`
- Background terminals for servers, watchers, and long-running commands
- Persistent remote Pi agents over SSH and Herdr, with context handoff and reconnectable monitoring
- First-class `fd` and `rg` tools
- Default-off Playwright browser tools for live web-app debugging
- Composable one-turn prompt snippets via `Alt+S`
- YouTube transcript extraction through a cross-platform skill
- Git status, changed-file browser, PR information, `/yeet`, and guarded `/git <target-branch>` workflows
- Multiple-choice `ask_user` tool
- Automatic run summaries and conversation export
- No Claude Code, Firecrawl, or external memory package dependencies

## Extensions

| Extension              | What it adds                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ask-user`             | Interactive multiple-choice questions with a free-form option                                                       |
| `auto-naming`          | Automatic Pi session, subagent, and Herdr workspace titles via `/title-model`                                       |
| `background-terminals` | Background process tools and the `/ps` dashboard                                                                    |
| `browser`              | Default-off Playwright tools, enabled per session with `/browser on`                                                |
| `copy-all`             | `/copy-all` conversation export                                                                                     |
| `codex-accounts`       | Save and switch Codex CLI accounts with `/codex`                                                                    |
| `file-search`          | Typed `fd` and `rg` model tools                                                                                     |
| `git-info`             | Branch/PR dashboard state, `/lg`, and `/pr`                                                                         |
| `git-pr`               | `/yeet` and guarded `/git <target-branch>` workflows                                                                |
| `model-info`           | Model, thinking, context, and cost state for the dashboard                                                          |
| `prompt-snippets`      | One-turn composable behavior rules selected with `Alt+S` or `/snippets`                                             |
| `remote-agents`        | Persistent remote Pi jobs over SSH and Herdr with `/remote` and `/remotes`                                          |
| `subagents`            | Pi and Codex children (Herdr-native TUIs in Herdr, in-process outside), profiles, result delivery, and `/subagents` |
| `summaries`            | Asynchronous post-run recaps and `/summary-model`                                                                   |
| `ui-customization`     | Startup logo, footer, thinking colors, and fixed-bottom editor                                                      |
| `workflows`            | Scriptable phased/parallel multi-agent workflows and `/workflows`                                                   |
| `zed`                  | Open the current directory in Zed with `/zed`                                                                       |

## Themes

Theme JSON files live in [`themes/`](themes/). The kit ships eight curated
themes, defaulting to **Noctalia** (warm dark with peach accents, matched to the
Noctalia desktop shell palette):

| Theme             | Vibe                                                    |
| ----------------- | ------------------------------------------------------- |
| `noctalia`        | Warm dark with peach accents — matches the DE (default) |
| `catppuccinMocha` | Soft purple, high-coziness                              |
| `tokyoNight`      | Deep blue with neon accents                             |
| `nord`            | Cold, calm arctic blues                                 |
| `gruvbox`         | Warm retro with high contrast                           |
| `rosePine`        | Soft, muted, dreamy                                     |
| `dracula`         | Dark purple with neon highlights                        |
| `solarizedDark`   | Classic, scientifically tuned contrast                  |

To switch themes, set `theme` in `settings.json` to a bundled theme name and
restart Pi:

```json
{ "theme": "tokyoNight" }
```

Add your own theme by dropping a JSON file into `themes/` — see
[themes.md](https://github.com/earendil-works/pi-mono/blob/main/docs/themes.md)
for the token reference. The bundled generator
([`scripts/gen-themes.mjs`](scripts/gen-themes.mjs)) rebuilds all eight themes
from a single palette table:

```sh
npm run gen:themes
```

## Install

> Back up an existing `~/.pi/agent` directory first. Authentication, sessions, trust data, and settings are intentionally not tracked by this repository.

```sh
mv ~/.pi/agent ~/.pi/agent.backup
git clone https://github.com/leandromesq/lelezonio-pi-kit.git ~/.pi/agent
cd ~/.pi/agent
npm ci --omit=dev
npm --prefix extensions/browser ci --omit=dev
node extensions/browser/node_modules/playwright-core/cli.js install chromium
cp settings.example.json settings.json
```

Restore any private state you want to keep from the backup, especially `auth.json`, `trust.json`, `sessions/`, and local memory directories. Merge rather than blindly replacing `settings.json`; keep `"packages": []` unless you deliberately install an optional package such as Hound.

Start Pi and use `/login` if authentication was not restored. See [SETUP.md](SETUP.md) for migration instructions, Windows commands, prerequisites, updates, and configuration.

## Subagent profiles

Profiles live in [`subagents.json`](subagents.json):

| Profile    | Harness | Model                           | Thinking | Intended use                        |
| ---------- | ------- | ------------------------------- | -------- | ----------------------------------- |
| `planner`  | Codex   | `gpt-5.6-luna`                  | `max`    | Difficult planning and architecture |
| `coder`    | Pi      | `opencode-go/deepseek-v4-flash` | `high`   | Implementation                      |
| `reviewer` | Codex   | `gpt-5.6-luna`                  | `high`   | Review and research                 |

Explicit spawn fields override profile values. Profile values override per-harness defaults. The concurrency cap is also configured in this file.

The main agent executes small tasks directly and delegates only independent, complex, long, or parallelizable work to subagents. Codex runs `planner` and `reviewer` (gpt-5.6-luna), Pi runs `coder` (opencode-go/deepseek-v4-flash), and profile-less spawns default to the `pi` harness. See AGENTS.md for the full delegation policy.

These model names reflect my accounts and preferences. Replace them with models available from `pi --list-models` and your Codex CLI installation.

Save the Codex CLI account that is currently authenticated, then repeat after logging into each account you use:

```text
/codex save personal
/codex save work
```

Run `/codex` to select an account. The switch updates Codex CLI credentials for new Codex processes, including future Codex subagents. Saved credentials remain private under `~/.codex/accounts/` (or `$CODEX_HOME/accounts/`).

## Git workflows

- `/yeet [instructions]` stages all changes, generates a concise commit message, commits, and pushes the current branch.
- `/git <target-branch>` inspects the repository, proposes logical commits and PR text for approval, pushes, and creates a GitHub PR with an explicit base branch.

The PR workflow requires an authenticated [GitHub CLI](https://cli.github.com/) installation.

## Watch in Herdr panes

When Pi runs inside Herdr (`HERDR_ENV=1`), subagents spawn as **real
interactive TUI processes** in a shared ephemeral `Pi Workers · <project> ·
<short-session>` workspace (Subagents tab): the parent launches Pi or Codex
through a zero-dependency launcher (`node worker-launcher.mjs <spec.json>` —
the pane command line never carries the worker's real argv, so PowerShell
quoting cannot mangle it), drives Pi and active-pane follow-ups through
Herdr's low-level `pane send-text` + `pane send-keys enter` surface (Codex's
initial/resumed prompt is a native positional argv from inside the JSON
spec), and tails the native session file (Pi session JSONL persisted under
`<agentDir>/sessions/workers/<parent>/<sa-id>`, Codex rollout JSONL matched
by a run marker + cwd) to power the existing subagent dashboard. Marking a
subagent in `/subagents` takes it over in its live pane (running: focus,
never interrupt; settled: reopen and resume the exact native session with the
full launch policy — Pi model/thinking/exclusions/trust, Codex
cwd/model/reasoning effort/sandbox/approval) and exits the dashboard.
Outside Herdr — or when the pane cannot be opened — subagents run in-process
(Pi SDK / `codex app-server`) and `/subagents` uses the in-session overlay
exactly as before.

Background terminals (`/ps`) open a **watcher pane** in the same workspace
(Terminals tab) that tails the terminal's full-output spill files with a plain
shell command (two merged `Get-Content -Wait` jobs / `tail -F`) — display-only, never a
second Pi. Selecting a terminal in `/ps` focuses its pane; when the terminal
settles, the watcher stops and the pane closes unless you took it over.

`/remotes` keeps its in-session overlay (native remote takeover is deferred),
and `/btw` keeps launching a real `pi -p` in a pane. The design and lifecycle
are documented in [docs/takeover-herdr.md](docs/takeover-herdr.md).

## Development

Install development dependencies, then run the checks:

```sh
npm ci
npm run check
npm test
npm run format:check
```

Individual extensions also expose focused `check` and `test` scripts.

To rebuild the bundled themes after editing the palette table:

```sh
npm run gen:themes
```

## Configuration and private state

The `.gitignore` excludes Pi runtime/private state, including authentication, settings, sessions, trust data, remote-agent job metadata, generated workflow artifacts, downloaded binaries, and private summary/title-model configuration. Auto-naming defaults to `opencode-go/deepseek-v4-flash`, redacts common credentials before sending the first task prompt to its selected model, and can be configured with `/title-model` or disabled with `/title-naming off`. Never commit those files.

Remote agents require an SSH-accessible host running Herdr. Copy `remote-agents.example.json` to `remote-agents.json`, then customize the SSH executable, helper path, and explicit local-to-remote project mappings. See [SETUP.md](SETUP.md#remote-agents) for details.

## Credits

This setup was rebuilt from [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) and then substantially customized for a smaller Windows-friendly Pi/Codex workflow.
