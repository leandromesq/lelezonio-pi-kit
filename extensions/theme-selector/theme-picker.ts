/**
 * Theme picker for Pi: discovery, preview rendering, and the picker UI.
 *
 * Pure-ish logic (discovery, var resolution, theme building) is exported for
 * tests; the picker component is used by index.ts via `ctx.ui.custom()`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  getSelectListTheme,
  Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// --- theme JSON model -------------------------------------------------------

export interface ThemeJson {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
}

export interface ThemeInfo {
  name: string;
  sourcePath?: string;
  json: ThemeJson;
}

/** Mirrors ThemeBg (not re-exported by the package index). */
export type BgToken =
  | "selectedBg"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

const BG_TOKENS: ReadonlySet<string> = new Set([
  "selectedBg",
  "scrollbarThumb",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);

const BUILTIN_THEMES = ["dark", "light"] as const;

// --- discovery --------------------------------------------------------------

export interface DiscoverOptions {
  /** `getAgentDir()` — global themes live in `<agentDir>/themes`. */
  agentDir: string;
  /** `getPackageDir()` — built-in themes ship inside the package. */
  packageDir: string;
  /** Current working directory; project themes live in `<cwd>/.pi/themes`. */
  cwd: string;
  /** Only include project themes for trusted projects. */
  projectTrusted: boolean;
  /** Config dir name for project-local resources (usually "pi"). */
  configDirName: string;
}

export function loadThemeFile(path: string) {
  try {
    const raw = readFileSync(path, "utf-8");
    const json = JSON.parse(raw) as Partial<ThemeJson>;
    if (
      typeof json.name !== "string" ||
      json.name.length === 0 ||
      json.name.includes("/")
    ) {
      return undefined;
    }
    if (!json.colors || typeof json.colors !== "object") {
      return undefined;
    }
    return { name: json.name, sourcePath: path, json: json as ThemeJson };
  } catch {
    return undefined;
  }
}

/**
 * Discover themes from built-ins, the global themes dir, and the project
 * themes dir. First definition of a name wins, matching Pi's own dedupe.
 */
export function discoverThemes(options: DiscoverOptions) {
  const found = new Map<string, ThemeInfo>();
  const addFile = (path: string) => {
    const info = loadThemeFile(path);
    if (info && !found.has(info.name)) {
      found.set(info.name, info);
    }
  };
  const addDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      addFile(join(dir, file));
    }
  };

  for (const name of BUILTIN_THEMES) {
    addFile(
      join(
        options.packageDir,
        "dist",
        "modes",
        "interactive",
        "theme",
        `${name}.json`,
      ),
    );
  }
  addDir(join(options.agentDir, "themes"));
  if (options.projectTrusted) {
    addDir(join(options.cwd, options.configDirName, "themes"));
  }
  return [...found.values()];
}

/** Current theme from settings.json; resolves "light/dark" auto settings. */
export function getCurrentThemeName(agentDir: string) {
  try {
    const settings = JSON.parse(
      readFileSync(join(agentDir, "settings.json"), "utf-8"),
    ) as { theme?: unknown };
    if (typeof settings.theme !== "string") return undefined;
    const auto = settings.theme.split("/");
    if (auto.length === 2 && auto[0] && auto[1]) {
      // Auto setting "light/dark"; assume a dark terminal (safe default).
      return auto[1];
    }
    return settings.theme || undefined;
  } catch {
    return undefined;
  }
}

// --- theme construction -----------------------------------------------------

/** Resolve `vars` references inside a colors map, cycle-safe. */
export function resolveVarRefs(
  colors: Record<string, string | number>,
  vars: Record<string, string | number> | undefined,
): Record<string, string | number> {
  const resolved: Record<string, string | number> = {};
  const resolving = new Set<string>();
  const resolve = (value: string | number): string | number => {
    if (typeof value !== "string" || !vars || !(value in vars)) return value;
    if (resolving.has(value)) return value;
    resolving.add(value);
    const result = resolve(vars[value]);
    resolving.delete(value);
    return result;
  };
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolve(value);
  }
  return resolved;
}

/** Build a standalone Theme instance from theme JSON for preview rendering. */
export function buildPreviewTheme(json: ThemeJson) {
  const mode = getCapabilities().trueColor ? "truecolor" : "256color";
  const resolved = resolveVarRefs(json.colors, json.vars);
  if (!("thinkingMax" in resolved))
    resolved.thinkingMax = resolved.thinkingXhigh;
  if (!("scrollbarThumb" in resolved))
    resolved.scrollbarThumb = resolved.selectedBg;

  const fg: Record<string, string | number> = {};
  const bg: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (BG_TOKENS.has(key)) bg[key] = value;
    else fg[key] = value;
  }
  return new Theme(
    fg as Record<ThemeColor, string | number>,
    bg as Record<BgToken, string | number>,
    mode,
    { name: json.name },
  );
}

/** Fallback used when no theme JSON can be built for preview. */
const NEUTRAL_THEME_JSON: ThemeJson = {
  name: "preview",
  colors: {
    accent: "#ffb597",
    dim: "#a68b81",
    error: "#ffb4ab",
    mdCode: "#8fc7b2",
    mdHeading: "#8fc7b2",
    mdLink: "#ffb597",
    mdListBullet: "#ffa67a",
    mdQuote: "#dec0b5",
    success: "#d9c85e",
    syntaxKeyword: "#ffd1cb",
    syntaxNumber: "#8fc7b2",
    syntaxOperator: "#f3ded7",
    syntaxPunctuation: "#a68b81",
    syntaxString: "#f0cfc4",
    syntaxVariable: "#ffa67a",
    text: "#f3ded7",
    thinkingHigh: "#d9a3a8",
    thinkingText: "#dec0b5",
    toolErrorBg: "#3d231f",
    toolOutput: "#dec0b5",
    toolSuccessBg: "#2b1e16",
    toolTitle: "#ffb597",
    userMessageBg: "#2b1e16",
    userMessageText: "#f3ded7",
    warning: "#f0b15a",
  },
};

// --- preview ----------------------------------------------------------------

const PREVIEW_HEIGHT = 16;

/**
 * Renders a miniature mock of the Pi transcript using a theme's actual color
 * tokens — user message box, markdown, tool boxes, syntax highlighting,
 * thinking border, and status colors.
 */
export class ThemePreview {
  private theme: Theme;
  private width?: number;
  private lines?: string[];

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.invalidate();
  }

  invalidate() {
    this.width = undefined;
    this.lines = undefined;
  }

  render(width: number) {
    if (this.lines && this.width === width) return this.lines;
    const t = this.theme;
    const pad = (text: string) =>
      text + " ".repeat(Math.max(0, width - visibleWidth(text)));
    const box = (key: BgToken, text: string) => t.bg(key, pad(text));
    const line = (text: string) => truncateToWidth(text, width);

    const rows: string[] = [];
    rows.push(pad(t.fg("accent", t.bold(`▞ ${t.name ?? "preview"}`))));
    rows.push(line(t.fg("dim", "live preview")));
    rows.push("");
    rows.push(
      box(
        "userMessageBg",
        ` ${t.fg("userMessageText", "❯ make pi match my desktop")}`,
      ),
    );
    rows.push("");
    rows.push(line(t.fg("mdHeading", "# Markdown heading")));
    rows.push(
      line(
        t.fg("text", "Body with ") +
          t.fg("mdCode", "inline code") +
          t.fg("text", ", a ") +
          t.fg("mdLink", "link") +
          t.fg("text", ", and a ") +
          t.fg("mdQuote", "quote"),
      ),
    );
    rows.push(line(t.fg("mdListBullet", "• ") + t.fg("text", "list item")));
    rows.push("");
    rows.push(
      box(
        "toolSuccessBg",
        ` ${t.fg("toolTitle", "✓ read ")}${t.fg("toolOutput", "kitty.conf")}`,
      ),
    );
    rows.push(
      box(
        "toolErrorBg",
        ` ${t.fg("error", "✗ fetch ")}${t.fg("toolOutput", "failed — retrying")}`,
      ),
    );
    rows.push("");
    rows.push(
      line(
        t.fg("syntaxKeyword", "const ") +
          t.fg("syntaxVariable", "theme ") +
          t.fg("syntaxOperator", "= ") +
          t.fg("syntaxString", '"noctalia"') +
          t.fg("syntaxPunctuation", "; ") +
          t.fg("syntaxNumber", "42"),
      ),
    );
    rows.push(
      line(
        t.getThinkingBorderColor("high")("╭─ ") +
          t.fg("thinkingText", "thinking: high"),
      ),
    );
    rows.push("");
    rows.push(
      line(
        t.fg("success", "✓ ok    ") +
          t.fg("warning", "⚠ warn    ") +
          t.fg("error", "✗ fail"),
      ),
    );

    while (rows.length < PREVIEW_HEIGHT) rows.push("");
    this.lines = rows
      .slice(0, PREVIEW_HEIGHT)
      .map((row) => truncateToWidth(row, width));
    this.width = width;
    return this.lines;
  }
}

// --- picker -----------------------------------------------------------------

/** Side-by-side theme selector: SelectList + live preview pane. */
export class ThemePicker {
  private selectList: SelectList;
  private preview: ThemePreview;
  private chrome: Theme;
  private done?: (name: string | null) => void;
  private width?: number;
  private lines?: string[];

  constructor(
    themes: ThemeInfo[],
    currentName: string | undefined,
    chrome: Theme,
  ) {
    this.chrome = chrome;

    const items: SelectItem[] = themes.map((theme) => ({
      value: theme.name,
      label: theme.name,
      description: theme.name === currentName ? "(current)" : undefined,
    }));

    const previews = new Map<string, Theme>();
    for (const theme of themes) {
      try {
        previews.set(theme.name, buildPreviewTheme(theme.json));
      } catch {
        // Skip themes that cannot be built for preview.
      }
    }

    this.selectList = new SelectList(
      items,
      Math.min(items.length, 10),
      getSelectListTheme(),
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 32,
      },
    );
    const currentIndex = themes.findIndex(
      (theme) => theme.name === currentName,
    );
    if (currentIndex !== -1) this.selectList.setSelectedIndex(currentIndex);

    const initial =
      previews.get(themes[currentIndex]?.name ?? "") ??
      previews.values().next().value ??
      buildPreviewTheme(NEUTRAL_THEME_JSON);
    this.preview = new ThemePreview(initial);

    this.selectList.onSelectionChange = (item) => {
      const next = previews.get(item.value);
      if (next) this.preview.setTheme(next);
    };
    this.selectList.onSelect = (item) => this.done?.(item.value);
    this.selectList.onCancel = () => this.done?.(null);
  }

  setDone(done: (name: string | null) => void) {
    this.done = done;
  }

  invalidate() {
    this.width = undefined;
    this.lines = undefined;
    this.selectList.invalidate();
    this.preview.invalidate();
  }

  handleInput(data: string) {
    this.selectList.handleInput(data);
  }

  render(width: number) {
    if (this.lines && this.width === width) return this.lines;
    const c = this.chrome;

    const top = c.fg("accent", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
    const title =
      c.fg("accent", c.bold(" Theme Selector ")) +
      c.fg("dim", "↑↓ navigate · type to filter · enter apply · esc cancel");
    const bottom = c.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);

    const body: string[] = [];
    if (width >= 46) {
      const leftW = Math.max(18, Math.min(34, Math.floor(width * 0.36)));
      const rightW = width - leftW - 1;
      const left = this.selectList.render(leftW);
      const right = this.preview.render(rightW);
      const rows = Math.max(left.length, right.length);
      for (let i = 0; i < rows; i++) {
        const l = truncateToWidth(left[i] ?? "", leftW);
        const r = truncateToWidth(right[i] ?? "", rightW);
        const lPad = leftW - visibleWidth(l);
        body.push(
          l + " ".repeat(Math.max(0, lPad)) + c.fg("borderMuted", "│") + r,
        );
      }
    } else {
      // Narrow terminal: stack the list above the preview.
      body.push(...this.selectList.render(width));
      body.push("");
      body.push(...this.preview.render(width));
    }

    this.lines = [top, truncateToWidth(title, width), ...body, bottom];
    this.width = width;
    return this.lines;
  }
}
