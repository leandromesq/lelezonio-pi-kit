#!/usr/bin/env node
/**
 * Generates Pi themes into themes/*.json.
 *
 * Each theme is built from a base palette (bg/panel/surface/border/... + accent
 * colors) mapped onto Pi's 51 required color tokens via a shared, consistent
 * layout (mirroring the kit's github-dark-default theme, which is battle-tested).
 *
 * Run:  npm run gen:themes
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "themes");
const SCHEMA_URL =
  "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

/**
 * Base palette definition. All values are hex unless noted.
 * `selectedBg`/`toolErrorBg`/`comment`/`softGreen`/`softRed` may be derived
 * per theme (see below) but are pinned here for control.
 */
const PALETTES = {
  /** Warm Material-style "neutral" scheme — matches ~/.config/kitty/themes/noctalia.conf */
  noctalia: {
    description:
      "Warm dark with peach accents — matches the Noctalia desktop shell palette",
    bg: "#1b110d",
    panel: "#140b08",
    surface: "#2b1e16",
    border: "#57423a",
    borderMuted: "#3a2c24",
    accent: "#ffb597",
    focus: "#ffc9ae",
    text: "#f3ded7",
    muted: "#dec0b5",
    dim: "#a68b81",
    green: "#d9c85e",
    red: "#ffb4ab",
    yellow: "#f0b15a",
    orange: "#ffa67a",
    purple: "#d9a3a8",
    cyan: "#8fc7b2",
    string: "#f0cfc4",
    comment: "#8a776b",
    softGreen: "#e6dd9a",
    softRed: "#ffd1cb",
    selectedBg: "#45342a",
    toolErrorBg: "#3d231f",
  },

  catppuccinMocha: {
    description: "Catppuccin Mocha — soft purple, high-coziness",
    bg: "#1e1e2e",
    panel: "#181825",
    surface: "#313244",
    border: "#45475a",
    borderMuted: "#313244",
    accent: "#89b4fa",
    focus: "#b4befe",
    text: "#cdd6f4",
    muted: "#a6adc8",
    dim: "#6c7086",
    green: "#a6e3a1",
    red: "#f38ba8",
    yellow: "#f9e2af",
    orange: "#fab387",
    purple: "#cba6f7",
    cyan: "#89dceb",
    string: "#94e2d5",
    comment: "#7f849c",
    softGreen: "#b5e8b0",
    softRed: "#eba0ac",
    selectedBg: "#313244",
    toolErrorBg: "#3b2733",
  },

  tokyoNight: {
    description: "Tokyo Night — deep blue with neon accents",
    bg: "#1a1b26",
    panel: "#16161e",
    surface: "#24283b",
    border: "#414868",
    borderMuted: "#2a2f45",
    accent: "#7aa2f7",
    focus: "#7dcfff",
    text: "#c0caf5",
    muted: "#a9b1d6",
    dim: "#565f89",
    green: "#9ece6a",
    red: "#f7768e",
    yellow: "#e0af68",
    orange: "#ff9e64",
    purple: "#bb9af7",
    cyan: "#7dcfff",
    string: "#73daca",
    comment: "#565f89",
    softGreen: "#c0e698",
    softRed: "#f999a9",
    selectedBg: "#2a3047",
    toolErrorBg: "#3a2530",
  },

  nord: {
    description: "Nord — cold, calm arctic blues",
    bg: "#2e3440",
    panel: "#272c36",
    surface: "#3b4252",
    border: "#4c566a",
    borderMuted: "#3b4252",
    accent: "#88c0d0",
    focus: "#8fbcbb",
    text: "#d8dee9",
    muted: "#b8c4d8",
    dim: "#7b88a1",
    green: "#a3be8c",
    red: "#bf616a",
    yellow: "#ebcb8b",
    orange: "#d08770",
    purple: "#b48ead",
    cyan: "#88c0d0",
    string: "#8fbcbb",
    comment: "#6b7a93",
    softGreen: "#b6d0a2",
    softRed: "#d08b92",
    selectedBg: "#434c5e",
    toolErrorBg: "#46303a",
  },

  gruvbox: {
    description: "Gruvbox Dark — warm retro with high contrast",
    bg: "#282828",
    panel: "#1d2021",
    surface: "#3c3836",
    border: "#504945",
    borderMuted: "#3c3836",
    accent: "#d79921",
    focus: "#fabd2f",
    text: "#ebdbb2",
    muted: "#a89984",
    dim: "#928374",
    green: "#b8bb26",
    red: "#fb4934",
    yellow: "#fabd2f",
    orange: "#fe8019",
    purple: "#d3869b",
    cyan: "#8ec07c",
    string: "#a9b665",
    comment: "#928374",
    softGreen: "#c8cc6e",
    softRed: "#ff6a5f",
    selectedBg: "#504945",
    toolErrorBg: "#402124",
  },

  rosePine: {
    description: "Rose Pine — soft, muted, dreamy",
    bg: "#191724",
    panel: "#13111e",
    surface: "#1f1d2e",
    border: "#26233a",
    borderMuted: "#1f1d2e",
    accent: "#c4a7e7",
    focus: "#9ccfd8",
    text: "#e0def4",
    muted: "#908caa",
    dim: "#6e6a86",
    green: "#a5c9a8",
    red: "#eb6f92",
    yellow: "#f6c177",
    orange: "#ebbcba",
    purple: "#c4a7e7",
    cyan: "#9ccfd8",
    string: "#f6c177",
    comment: "#6e6a86",
    softGreen: "#bcd9c0",
    softRed: "#f0a0b5",
    selectedBg: "#26233a",
    toolErrorBg: "#332330",
  },

  dracula: {
    description: "Dracula — dark purple with neon highlights",
    bg: "#282a36",
    panel: "#21222c",
    surface: "#343746",
    border: "#44475a",
    borderMuted: "#343746",
    accent: "#bd93f9",
    focus: "#ff79c6",
    text: "#f8f8f2",
    muted: "#a9b0c2",
    dim: "#6272a4",
    green: "#50fa7b",
    red: "#ff5555",
    yellow: "#f1fa8c",
    orange: "#ffb86c",
    purple: "#bd93f9",
    cyan: "#8be9fd",
    string: "#50fa7b",
    comment: "#6272a4",
    softGreen: "#7dffa0",
    softRed: "#ff7b7b",
    selectedBg: "#44475a",
    toolErrorBg: "#3d2b33",
  },

  solarizedDark: {
    description: "Solarized Dark — classic, scientifically tuned contrast",
    bg: "#002b36",
    panel: "#002029",
    surface: "#073642",
    border: "#073642",
    borderMuted: "#013240",
    accent: "#268bd2",
    focus: "#2aa198",
    text: "#93a1a1",
    muted: "#839496",
    dim: "#586e75",
    green: "#859900",
    red: "#dc322f",
    yellow: "#b58900",
    orange: "#cb4b16",
    purple: "#6c71c4",
    cyan: "#2aa198",
    string: "#8aa000",
    comment: "#586e75",
    softGreen: "#9daa3d",
    softRed: "#e05850",
    selectedBg: "#073642",
    toolErrorBg: "#432f30",
  },
};

/** Shared mapping from palette keys onto Pi's 51 required color tokens. */
const COLORS = {
  accent: "accent",
  border: "border",
  borderAccent: "focus",
  borderMuted: "borderMuted",
  success: "green",
  error: "red",
  warning: "yellow",
  muted: "muted",
  dim: "dim",
  text: "text",
  thinkingText: "muted",

  selectedBg: "selectedBg",
  scrollbarThumb: "selectedBg",
  userMessageBg: "surface",
  userMessageText: "text",
  customMessageBg: "surface",
  customMessageText: "text",
  customMessageLabel: "accent",
  toolPendingBg: "surface",
  toolSuccessBg: "surface",
  toolErrorBg: "toolErrorBg",
  toolTitle: "accent",
  toolOutput: "muted",

  mdHeading: "cyan",
  mdLink: "accent",
  mdLinkUrl: "muted",
  mdCode: "cyan",
  mdCodeBlock: "text",
  mdCodeBlockBorder: "border",
  mdQuote: "muted",
  mdQuoteBorder: "border",
  mdHr: "borderMuted",
  mdListBullet: "orange",

  toolDiffAdded: "green",
  toolDiffRemoved: "red",
  toolDiffContext: "muted",

  syntaxComment: "comment",
  syntaxKeyword: "softRed",
  syntaxFunction: "purple",
  syntaxVariable: "orange",
  syntaxString: "string",
  syntaxNumber: "cyan",
  syntaxType: "softGreen",
  syntaxOperator: "text",
  syntaxPunctuation: "dim",

  thinkingOff: "dim",
  thinkingMinimal: "muted",
  thinkingLow: "accent",
  thinkingMedium: "cyan",
  thinkingHigh: "purple",
  thinkingXhigh: "softRed",
  thinkingMax: "softRed",

  bashMode: "green",
};

const REQUIRED_TOKENS = new Set(Object.keys(COLORS));
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const VARS = Object.keys(PALETTES.noctalia); // palette keys become vars

function toVars(palette) {
  const vars = {};
  for (const [key, value] of Object.entries(palette)) {
    if (key === "description") continue;
    vars[key] = value;
  }
  return vars;
}

function buildColors(palette) {
  const colors = {};
  for (const [token, varName] of Object.entries(COLORS)) {
    if (!(varName in palette)) {
      throw new Error(
        `Palette missing var "${varName}" needed by token "${token}"`,
      );
    }
    colors[token] = varName;
  }
  return colors;
}

function validate(name, palette, colors) {
  const missing = [...REQUIRED_TOKENS].filter((token) => !(token in colors));
  if (missing.length > 0) {
    throw new Error(`Theme "${name}" missing tokens: ${missing.join(", ")}`);
  }
  if (name.includes("/")) {
    throw new Error(`Theme name "${name}" must not contain "/"`);
  }
  const allVars = toVars(palette);
  for (const [key, value] of Object.entries(allVars)) {
    if (typeof value !== "string" || !HEX_RE.test(value)) {
      throw new Error(
        `Theme "${name}" var "${key}" must be a #rrggbb hex string, got ${JSON.stringify(value)}`,
      );
    }
  }
  for (const [token, value] of Object.entries(colors)) {
    if (typeof value !== "string" || !(value in allVars)) {
      throw new Error(
        `Theme "${name}" token "${token}" must reference a var, got ${JSON.stringify(value)}`,
      );
    }
  }
}

function buildTheme(name, palette) {
  const vars = toVars(palette);
  const colors = buildColors(palette);
  validate(name, palette, colors);
  return {
    $schema: SCHEMA_URL,
    name,
    vars,
    colors,
    export: {
      pageBg: "bg",
      cardBg: "panel",
      infoBg: "surface",
    },
  };
}

// Order: noctalia first (the kit's default), then the rest alphabetically.
const ORDER = [
  "noctalia",
  ...Object.keys(PALETTES)
    .filter((n) => n !== "noctalia")
    .sort(),
];

mkdirSync(OUT_DIR, { recursive: true });

const themes = ORDER.map((name) => buildTheme(name, PALETTES[name]));
for (const theme of themes) {
  const file = join(OUT_DIR, `${theme.name}.json`);
  writeFileSync(file, `${JSON.stringify(theme, null, 2)}\n`);
  console.log(`✓ themes/${theme.name}.json`);
}

// Cross-check: names must be unique across the themes dir (incl. existing files).
const { readdirSync } = await import("node:fs");
const existing = [];
for (const file of readdirSync(OUT_DIR)) {
  if (!file.endsWith(".json")) continue;
  const content = JSON.parse(readFileSync(join(OUT_DIR, file), "utf-8"));
  existing.push(content.name);
}
const dupes = existing.filter((n, i) => existing.indexOf(n) !== i);
if (dupes.length > 0) {
  console.error(`✗ Duplicate theme names in ${OUT_DIR}: ${dupes.join(", ")}`);
  process.exit(1);
}

console.log(
  `\nGenerated ${themes.length} themes into ${OUT_DIR} — all ${REQUIRED_TOKENS.size} tokens validated.`,
);
