# Lelezonio Pi Kit

My complete, opinionated setup for [Pi](https://github.com/earendil-works/pi-mono): local extensions, skills, theme, subagent profiles, and development tooling.

This repository is the setup itself. It is **not an npm package or Pi package**—install it by cloning it as your Pi agent directory.

## Highlights

- Fixed-bottom editor with a compact custom dashboard and color-coded thinking level
- GitHub Dark Default theme
- Named Pi/Codex subagent profiles with configurable models and thinking effort
- Fast Codex CLI account saving and switching with `/codex`
- Multi-agent workflows with phased and parallel execution
- Background terminals for servers, watchers, and long-running commands
- Persistent remote Pi agents over SSH and Herdr, with context handoff and reconnectable monitoring
- First-class `fd` and `rg` tools
- Git status, changed-file browser, PR information, `/yeet`, and guarded `/git <target-branch>` workflows
- Multiple-choice `ask_user` tool
- Automatic run summaries and conversation export
- No Claude Code, Firecrawl, or external memory package dependencies

## Extensions

| Extension              | What it adds                                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| `ask-user`             | Interactive multiple-choice questions with a free-form option               |
| `background-terminals` | Background process tools and the `/ps` dashboard                            |
| `copy-all`             | `/copy-all` conversation export                                             |
| `codex-accounts`       | Save and switch Codex CLI accounts with `/codex`                            |
| `file-search`          | Typed `fd` and `rg` model tools                                             |
| `git-info`             | Branch/PR dashboard state, `/lg`, and `/pr`                                 |
| `git-pr`               | `/yeet` and guarded `/git <target-branch>` workflows                        |
| `model-info`           | Model, thinking, context, and cost state for the dashboard                  |
| `remote-agents`        | Persistent remote Pi jobs over SSH and Herdr with `/remote` and `/remotes`  |
| `subagents`            | Headless Pi and Codex children, profiles, result delivery, and `/subagents` |
| `summaries`            | Asynchronous post-run recaps and `/summary-model`                           |
| `ui-customization`     | Startup logo, footer, thinking colors, and fixed-bottom editor              |
| `workflows`            | Scriptable phased/parallel multi-agent workflows and `/workflows`           |

## Install

> Back up an existing `~/.pi/agent` directory first. Authentication, sessions, trust data, and settings are intentionally not tracked by this repository.

```sh
mv ~/.pi/agent ~/.pi/agent.backup
git clone https://github.com/leandromesq/lelezonio-pi-kit.git ~/.pi/agent
cd ~/.pi/agent
npm ci --omit=dev
cp settings.example.json settings.json
```

Restore any private state you want to keep from the backup, especially `auth.json`, `trust.json`, `sessions/`, and local memory directories. Merge rather than blindly replacing `settings.json`; keep `"packages": []` so stale npm-installed Pi packages are not loaded.

Start Pi and use `/login` if authentication was not restored. See [SETUP.md](SETUP.md) for migration instructions, Windows commands, prerequisites, updates, and configuration.

## Subagent profiles

Profiles live in [`subagents.json`](subagents.json):

| Profile    | Harness | Model                         | Thinking | Intended use                        |
| ---------- | ------- | ----------------------------- | -------- | ----------------------------------- |
| `planner`  | Codex   | `gpt-5.6-sol`                 | `high`   | Difficult planning and architecture |
| `coder`    | Pi      | `opencode-go/deepseek-v4-pro` | `max`    | Implementation                      |
| `reviewer` | Pi      | `opencode-go/kimi-k3`         | `max`    | Review and research                 |

Explicit spawn fields override profile values. Profile values override per-harness defaults. The concurrency cap is also configured in this file.

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

## Development

Install development dependencies, then run the checks:

```sh
npm ci
npm run check
npm test
npm run format:check
```

Individual extensions also expose focused `check` and `test` scripts.

## Configuration and private state

The `.gitignore` excludes Pi runtime/private state, including authentication, settings, sessions, trust data, remote-agent job metadata, generated workflow artifacts, downloaded binaries, and private summary configuration. Never commit those files.

Remote agents require an SSH-accessible host running Herdr. Copy `remote-agents.example.json` to `remote-agents.json`, then customize the SSH executable, helper path, and explicit local-to-remote project mappings. See [SETUP.md](SETUP.md#remote-agents) for details.

## Credits

This setup was rebuilt from [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) and then substantially customized for a smaller Windows-friendly Pi/Codex workflow.
