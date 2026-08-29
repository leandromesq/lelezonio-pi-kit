import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { viewportRows, wrapViewportText } from "../shared/ui/viewport.ts";

interface KitAction extends SelectItem {
  command?: string;
  category: string;
  detail: string;
}

const ACTIONS: KitAction[] = [
  {
    value: "model",
    label: "Model",
    description: "Choose the main model",
    command: "/model",
    category: "Session",
    detail: "Open Pi's model picker for this session.",
  },
  {
    value: "settings",
    label: "Settings",
    description: "Pi and theme preferences",
    command: "/settings",
    category: "Session",
    detail:
      "Open Pi's settings, including the current theme and TUI preferences.",
  },
  {
    value: "snippets",
    label: "Prompt snippets",
    description: "Compose one-turn behavior rules",
    command: "/snippets",
    category: "Prompting",
    detail: "Toggle reusable prompt snippets. Shortcut: Alt+S.",
  },
  {
    value: "browser",
    label: "Browser",
    description: "Enable or disable browser tools",
    command: "/browser",
    category: "Tools",
    detail:
      "Manage the default-off Playwright browser tool set for this session.",
  },
  {
    value: "subagents",
    label: "Subagents",
    description: "Inspect and take over workers",
    command: "/subagents",
    category: "Agents",
    detail:
      "Open the local worker dashboard and inspect, steer, cancel, or take over a child.",
  },
  {
    value: "terminals",
    label: "Background terminals",
    description: "Inspect servers, builds, and watchers",
    command: "/ps",
    category: "Agents",
    detail:
      "Open the background-terminal dashboard and inspect output or stop a process.",
  },
  {
    value: "workflows",
    label: "Workflows",
    description: "Inspect multi-agent workflow runs",
    command: "/workflows",
    category: "Agents",
    detail: "Open phased and parallel workflow history.",
  },
  {
    value: "remotes",
    label: "Remote agents",
    description: "Inspect persistent homelab jobs",
    command: "/remotes",
    category: "Agents",
    detail: "Open the persistent remote-agent dashboard.",
  },
  {
    value: "git",
    label: "Changed files",
    description: "Browse the working-tree diff",
    command: "/lg",
    category: "Git",
    detail: "Open the changed-file and diff browser.",
  },
  {
    value: "pr",
    label: "Refresh pull request",
    description: "Refresh Git and PR dashboard state",
    command: "/pr",
    category: "Git",
    detail: "Refresh branch, working-tree, and pull-request information.",
  },
  {
    value: "summary",
    label: "Summary model",
    description: "Configure post-run recaps",
    command: "/summary-model",
    category: "Models",
    detail:
      "Choose the model and reasoning level used for asynchronous run recaps.",
  },
  {
    value: "title",
    label: "Title model",
    description: "Configure automatic naming",
    command: "/title-model",
    category: "Models",
    detail:
      "Choose the model and reasoning level used for session, subagent, and workspace names.",
  },
  {
    value: "codex",
    label: "Codex account",
    description: "Save or switch CLI accounts",
    command: "/codex",
    category: "Accounts",
    detail: "Open the Codex CLI account manager.",
  },
  {
    value: "copy",
    label: "Copy conversation",
    description: "Export the current conversation",
    command: "/copy-all",
    category: "Session",
    detail: "Copy a clean conversation export to the clipboard.",
  },
  {
    value: "perf",
    label: "Performance",
    description: "Inspect lightweight runtime metrics",
    command: "/perf",
    category: "Diagnostics",
    detail:
      "Show bounded turn/tool latency samples, runtime initialization latency, and process memory without enabling a polling timer.",
  },
];

export function kitViewportRows(
  terminalRows: number,
  itemCount: number,
): number {
  const overlayRows = Math.max(1, Math.floor((terminalRows || 30) * 0.9));
  return Math.min(itemCount, viewportRows(overlayRows, 15, 1));
}

export function kitHealth(ctx: ExtensionContext, pi: ExtensionAPI): string[] {
  const usage = ctx.getContextUsage();
  const active = pi.getActiveTools().length;
  const available = pi.getAllTools().length;
  const commands = pi
    .getCommands()
    .filter((command) => command.source === "extension").length;
  return [
    `${ctx.model?.provider ?? "no provider"}/${ctx.model?.id ?? "no model"} · thinking ${ctx.thinkingLevel}`,
    `${active}/${available} tools active · ${commands} extension commands`,
    usage
      ? `context ${Math.round((usage.percent ?? 0) * 10) / 10}% · ${usage.tokens} tokens`
      : "context usage unavailable",
  ];
}

function renderDetail(
  action: KitAction,
  health: string[],
  width: number,
  theme: Theme,
): string[] {
  const contentWidth = Math.max(10, width - 4);
  const wrappedDetail = wrapViewportText(
    theme.fg("muted", action.detail),
    contentWidth,
  );
  const body = [
    theme.fg("accent", theme.bold(`${action.category} · ${action.label}`)),
    ...wrappedDetail.slice(0, 3),
    ...(wrappedDetail.length > 3
      ? [theme.fg("dim", `… ${wrappedDetail.length - 3} more detail line(s)`)]
      : []),
    ...(action.command ? [theme.fg("dim", `Command: ${action.command}`)] : []),
    ...(health.length > 0 ? ["", theme.fg("dim", health.join("\n"))] : []),
  ];
  return body
    .flatMap((line) => line.split("\n"))
    .map((line) => truncateToWidth(`  ${line}`, width));
}

export default function kitExtension(pi: ExtensionAPI) {
  pi.registerCommand("kit", {
    description: "Open the Lelezonio Pi Kit control centre",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The Pi Kit control centre requires the interactive TUI.",
          "warning",
        );
        return;
      }

      const selected = await ctx.ui.custom<string | null>(
        (tui, theme, keybindings, done) => {
          let current = ACTIONS[0]!;
          const list = new SelectList(
            ACTIONS,
            kitViewportRows(tui.terminal.rows || 30, ACTIONS.length),
            {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
            { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 30 },
          );
          list.onSelectionChange = (item) => {
            current = item as KitAction;
            tui.requestRender();
          };
          list.onSelect = (item) => done((item as KitAction).command ?? null);
          list.onCancel = () => done(null);

          return {
            render(width: number) {
              const line = (text: string) => truncateToWidth(text, width);
              return [
                theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
                line(
                  ` ${theme.fg("accent", theme.bold("Lelezonio Pi Kit"))} ${theme.fg("dim", "— control centre")}`,
                ),
                line(
                  theme.fg(
                    "dim",
                    " Select a feature to place its command in the editor.",
                  ),
                ),
                "",
                ...list.render(width),
                "",
                ...renderDetail(
                  current,
                  tui.terminal.rows >= 24 ? kitHealth(ctx, pi) : [],
                  width,
                  theme,
                ),
                "",
                line(
                  theme.fg(
                    "dim",
                    `${keybindings.getKeys("tui.select.up").join("/")}/${keybindings.getKeys("tui.select.down").join("/")} navigate · Enter choose · Esc close`,
                  ),
                ),
                theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
              ];
            },
            handleInput(data: string) {
              if (matchesKey(data, Key.escape)) return done(null);
              list.handleInput(data);
              tui.requestRender();
            },
            invalidate() {
              list.invalidate();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "95%",
            maxHeight: "90%",
            margin: 1,
          },
        },
      );

      if (selected) {
        ctx.ui.setEditorText(selected);
        ctx.ui.notify(`${selected} is ready — press Enter to run it.`, "info");
      }
    },
  });
}
