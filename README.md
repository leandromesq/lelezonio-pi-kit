# Lelezonio Pi Kit

My complete, opinionated setup for [Pi](https://github.com/earendil-works/pi-mono): local extensions, skills, theme, subagent profiles, and development tooling.

This repository is the setup itself. It is **not an npm package or Pi package**—install it by cloning it as your Pi agent directory.

## Highlights

- Fixed-bottom editor with a compact custom dashboard and color-coded thinking level
- Curated theme collection (Noctalia by default)
- Named Pi/Codex subagent profiles with configurable models and thinking effort
- Fast Codex CLI account saving and switching with `/codex`
- Multi-agent workflows with phased and parallel execution
- Take over subagents, background terminals, and remote agents in a Herdr pane when running inside Herdr (one live viewer, never a second Pi; falls back to the in-session overlays outside Herdr)
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

| Extension              | What it adds                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- |
| `ask-user`             | Interactive multiple-choice questions with a free-form option                 |
| `auto-naming`          | Automatic Pi session, subagent, and Herdr workspace titles via `/title-model` |
| `background-terminals` | Background process tools and the `/ps` dashboard                              |
| `browser`              | Default-off Playwright tools, enabled per session with `/browser on`          |
| `copy-all`             | `/copy-all` conversation export                                               |
| `codex-accounts`       | Save and switch Codex CLI accounts with `/codex`                              |
| `file-search`          | Typed `fd` and `rg` model tools                                               |
| `git-info`             | Branch/PR dashboard state, `/lg`, and `/pr`                                   |
| `git-pr`               | `/yeet` and guarded `/git <target-branch>` workflows                          |
| `model-info`           | Model, thinking, context, and cost state for the dashboard                    |
| `prompt-snippets`      | One-turn composable behavior rules selected with `Alt+S` or `/snippets`       |
| `remote-agents`        | Persistent remote Pi jobs over SSH and Herdr with `/remote` and `/remotes`    |
| `subagents`            | Headless Pi and Codex children, profiles, result delivery, and `/subagents`   |
| `summaries`            | Asynchronous post-run recaps and `/summary-model`                             |
| `ui-customization`     | Startup logo, footer, thinking colors, and fixed-bottom editor                |
| `workflows`            | Scriptable phased/parallel multi-agent workflows and `/workflows`             |
| `zed`                  | Open the current directory in Zed with `/zed`                                 |

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

## Take over in a Herdr pane

When Pi runs inside Herdr (`HERDR_ENV=1`), selecting **take over** for a
subagent (`/subagents`), a background terminal (`/ps`), or a remote agent
(`/remotes`) opens a new Herdr pane that shows and controls the **same
process** — it never starts a second Pi. The pane runs a thin viewer over a
loopback JSONL bridge: live snapshot, `i`/Enter to compose and send for
subagents/remotes (all printable characters type freely), Ctrl+C (with confirmation) to
abort/kill/cancel, `r` to refresh a remote, `t` to toggle terminal
stdout/stderr, `q` to detach (the target keeps running).

Outside Herdr, or whenever the pane cannot be opened (including when the
viewer fails to authenticate), the in-session overlays are used exactly as
before. `/btw` keeps launching a real `pi -p` in a pane. The design, protocol
bounds, and lifecycle are documented in
[docs/takeover-herdr.md](docs/takeover-herdr.md).

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
