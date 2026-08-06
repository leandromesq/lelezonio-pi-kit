/**
 * Theme Selector extension.
 *
 * `/theme` opens an interactive theme picker with a live preview pane. Navigate
 * with ↑/↓ (or type to filter), press Enter to apply, Esc to cancel. Applying
 * persists the choice to settings.json and reloads Pi so the theme takes
 * effect immediately.
 *
 * `/theme <name>` applies a theme directly without the picker.
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  discoverThemes,
  getCurrentThemeName,
  ThemePicker,
} from "./theme-picker.ts";

interface SessionLike {
  cwd: string;
  isProjectTrusted(): boolean;
}

function discoverNames(ctx: SessionLike) {
  return discoverThemes({
    agentDir: getAgentDir(),
    packageDir: getPackageDir(),
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    configDirName: CONFIG_DIR_NAME,
  }).map((theme) => theme.name);
}

let cachedNames: string[] = [];

async function applyTheme(
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir());
  settings.setTheme(name);
  await settings.flush();
  ctx.ui.notify(`Switching to theme "${name}"…`, "info");
  // Reloading re-applies the theme from settings (and hot-reloads this extension).
  await ctx.reload();
}

async function pickTheme(ctx: ExtensionCommandContext) {
  const themes = discoverThemes({
    agentDir: getAgentDir(),
    packageDir: getPackageDir(),
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    configDirName: CONFIG_DIR_NAME,
  });
  if (themes.length === 0) {
    ctx.ui.notify("No themes found", "error");
    return;
  }

  const currentName = getCurrentThemeName(getAgentDir());

  const chosen = await ctx.ui.custom<string | null>(
    (_tui, chrome, _keybindings, done) => {
      const picker = new ThemePicker(themes, currentName, chrome);
      picker.setDone(done);
      return picker;
    },
  );

  if (!chosen) return;
  if (chosen === currentName) {
    ctx.ui.notify(`Already on theme "${chosen}"`, "info");
    return;
  }
  await applyTheme(ctx, chosen);
}

function handleThemeCommand(
  args: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const requested = args?.trim();
  if (requested) {
    const names = cachedNames.length > 0 ? cachedNames : discoverNames(ctx);
    const exact = names.find((name) => name === requested);
    const fuzzy = names.find((name) => name.startsWith(requested));
    const match = exact ?? fuzzy;
    if (!match) {
      ctx.ui.notify(
        `Unknown theme "${requested}". Available: ${names.join(", ")}`,
        "error",
      );
      return Promise.resolve();
    }
    return applyTheme(ctx, match);
  }

  if (ctx.mode === "tui") return pickTheme(ctx);

  ctx.ui.notify(
    "The interactive theme picker needs the TUI. Pass a name: /theme <name>",
    "warning",
  );
  return Promise.resolve();
}

function completionItems(prefix: string) {
  const items: AutocompleteItem[] = cachedNames.map((name) => ({
    value: name,
    label: name,
  }));
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    cachedNames = discoverNames(ctx);
  });

  const describe = () => "Browse and apply themes with a live preview";

  pi.registerCommand("theme", {
    description: describe(),
    getArgumentCompletions: completionItems,
    handler: (args, ctx) => handleThemeCommand(args, ctx),
  });

  pi.registerCommand("themes", {
    description: `${describe()} (alias of /theme)`,
    getArgumentCompletions: completionItems,
    handler: (args, ctx) => handleThemeCommand(args, ctx),
  });
}
