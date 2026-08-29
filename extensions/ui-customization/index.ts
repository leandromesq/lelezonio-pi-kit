import { homedir } from "node:os";
import { relative } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
  type GitInfoState,
  type ModelInfoState,
} from "../shared/dashboard-state.ts";
const TITLE_LINES = [
  "▀████████████▀",
  " ╘███    ███  ",
  "  ███    ███  ",
  "  ███    ███  ",
  " ▄███▄  ▄███▄ ",
];
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

/**
 * Left/right columns. When both fit they keep a natural spread; when space
 * runs out the left side is truncated first and the right keeps the rest of
 * the line. `keepLeftTail` truncates the left side from its *head* so e.g.
 * a long directory never loses the final (meaningful) path segments.
 */
function columns(
  left: string,
  right: string,
  width: number,
  keepLeftTail = false,
) {
  if (!right) {
    return keepLeftTail
      ? truncateLeftToWidth(left, width)
      : truncateToWidth(left, width);
  }

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = keepLeftTail
    ? truncateLeftToWidth(left, leftWidth)
    : truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

/**
 * ANSI-safe left truncation that keeps the *tail* of a styled string, used
 * for the directory so a long path shows its last (meaningful) segments
 * instead of a chopped prefix. `sliceByColumn` re-emits the color codes that
 * precede the kept region but drops the reset sitting exactly at the range
 * end, so the trailing reset is restored to keep colors from bleeding into
 * the rest of the line.
 */
export function truncateLeftToWidth(
  text: string,
  maxWidth: number,
  ellipsis = "…",
): string {
  if (maxWidth <= 0) return "";
  const fullWidth = visibleWidth(text);
  if (fullWidth <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  const tailWidth = Math.max(0, maxWidth - ellipsisWidth);
  if (tailWidth === 0) return truncateToWidth(ellipsis, maxWidth);

  const sliced = sliceByColumn(text, fullWidth - tailWidth, tailWidth);
  const tail = text.endsWith("\u001b[39m") ? `${sliced}\u001b[39m` : sliced;
  return `${ellipsis}${tail}`;
}

/**
 * Compact footer line: the directory gets every column it can (tail-
 * preserving truncation) while the fixed-width context percentage holds the
 * right edge, so the directory stays visible at the narrowest widths.
 */
function compactFooterLine(directory: string, right: string, width: number) {
  if (!directory) {
    return `${" ".repeat(Math.max(0, width - visibleWidth(right)))}${right}`;
  }
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(1, width - rightWidth - 1);
  const fitted = truncateLeftToWidth(directory, leftWidth);
  const gap = Math.max(1, width - visibleWidth(fitted) - rightWidth);
  return truncateToWidth(`${fitted}${" ".repeat(gap)}${right}`, width);
}

function thinkingColor(level: string): ThemeColor {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
    default:
      return "muted";
  }
}

/**
 * Uppercase border badge for a thinking level, e.g. `"high"` → `"HIGH"`.
 * The editor's bottom border shows this label (e.g. ` HIGH `, ` MEDIUM `,
 * ` OFF `) so the border color's meaning is explicit.
 */
export function thinkingBadgeLabel(level: string): string {
  return level.trim().toUpperCase();
}

/**
 * Decorates the editor's bottom border with a right-aligned thinking-level
 * badge carved out of the border run, e.g. `────── HIGH `. Badge and border
 * share the same semantic color (the thinking color) via `color`. Safe in
 * narrow terminals: when the badge cannot sit beside at least one border
 * glyph (`badgeWidth >= width`) it is dropped entirely and the original
 * border is returned, so the line never overflows.
 *
 * @param borderLine The raw bottom border from the editor's `render` (ANSI
 *   may wrap it; only its visible text is used, so scroll indicators on the
 *   left are preserved).
 * @param badgeLabel Uppercase thinking level, e.g. `"HIGH"`.
 * @param color Applies the semantic border/thinking color to a text span.
 * @param width Available terminal columns; the result never exceeds it.
 */
export function decorateThinkingBorder(
  borderLine: string,
  badgeLabel: string,
  color: (text: string) => string,
  width: number,
): string {
  const plain = borderLine.replace(ANSI_PATTERN, "");
  const badge = ` ${badgeLabel} `;
  const badgeWidth = visibleWidth(badge);
  // Nothing to show: hand the border back untouched.
  if (badgeLabel.trim() === "") return borderLine;
  // Degrade safely: require room for the badge plus at least one border
  // column; otherwise keep the border untouched and drop the badge.
  if (badgeWidth >= width) return borderLine;
  const kept = truncateToWidth(plain, width - badgeWidth, "").replace(
    ANSI_PATTERN,
    "",
  );
  return `${color(kept)}${color(badge)}`;
}

/**
 * True when a rendered editor line is the bottom border (a plain `─` run or
 * a `↓` scroll indicator, both of which start with `─`). Because the editor
 * always draws the bottom border last (autocomplete rows come after only
 * when active), testing the final line against this is enough.
 */
function isBottomBorder(line: string): boolean {
  const plain = line.replace(ANSI_PATTERN, "");
  return plain.startsWith("─");
}

/**
 * Threshold color for the context indicator: below 60% is `muted`, 60–80%
 * (both ends inclusive) is `warning`, and above 80% is `error`. Unknown
 * (`null`) stays `muted`. Percents are expected to be clamped to 0–100 by
 * `computeContextUsage`.
 */
export function contextColor(percent: number | null): ThemeColor {
  if (percent === null || percent < 60) return "muted";
  if (percent <= 80) return "warning";
  return "error";
}

/** Bar cells for the full context indicator (medium/wide bands). */
export const CONTEXT_BAR_CELLS = 10;
/** Bar cells for the compact context indicator (narrow band). */
export const CONTEXT_MINI_BAR_CELLS = 6;

const BAR_FILL = "▓";
const BAR_EMPTY = "░";

/** Visual usage bar, e.g. `▓▓▓▓▓▓░░░░` for 63% of 10 cells. */
export function contextBar(percent: number | null, cells: number): string {
  const filled = percent === null ? 0 : Math.round((percent / 100) * cells);
  const clamped = Math.min(cells, Math.max(0, filled));
  return BAR_FILL.repeat(clamped) + BAR_EMPTY.repeat(cells - clamped);
}

/** Structured context usage; `null` fields mean "unknown". */
export interface ContextUsage {
  /** Percent clamped to 0–100, or null when unknown. */
  percent: number | null;
  /** Used tokens, or null when unknown. */
  usedTokens: number | null;
  /** Context window tokens, or null when unknown. */
  windowTokens: number | null;
}

/**
 * Derives context usage from model state. Used tokens come from
 * `contextTokens` when available; otherwise they are derived from
 * `percent × window` when both are valid. The percent comes from
 * `contextPercent` when valid, otherwise from `used / window`. Missing and
 * non-finite values become `null`; percents are clamped to 0–100.
 */
export function computeContextUsage(model: ModelInfoState): ContextUsage {
  const percentValid =
    model.contextPercent !== null && Number.isFinite(model.contextPercent);
  const windowValid =
    model.contextWindow > 0 && Number.isFinite(model.contextWindow);
  const tokensValid =
    model.contextTokens !== null &&
    Number.isFinite(model.contextTokens) &&
    model.contextTokens >= 0;

  let percent: number | null = percentValid
    ? Math.min(100, Math.max(0, model.contextPercent!))
    : null;
  let usedTokens: number | null = null;

  if (tokensValid) {
    usedTokens = model.contextTokens;
  } else if (percent !== null && windowValid) {
    usedTokens = Math.round((percent / 100) * model.contextWindow);
  }

  if (percent === null && usedTokens !== null && windowValid) {
    percent = Math.min(
      100,
      Math.max(0, (usedTokens / model.contextWindow) * 100),
    );
  }

  return {
    percent,
    usedTokens,
    windowTokens: windowValid ? model.contextWindow : null,
  };
}

/** Full context indicator: `▓▓▓▓▓▓░░░░ 63% · 126k/200k`. */
function buildContextIndicator(
  usage: ContextUsage,
  cells: number,
  theme: FooterTheme,
): string {
  const bar = contextBar(usage.percent, cells);
  const percentLabel =
    usage.percent === null ? "?" : `${Math.round(usage.percent)}`;
  const tokensLabel = `${usage.usedTokens === null ? "?" : formatTokens(usage.usedTokens)}/${
    usage.windowTokens === null ? "?" : formatTokens(usage.windowTokens)
  }`;
  return theme.fg(
    contextColor(usage.percent),
    `${bar} ${percentLabel}% · ${tokensLabel}`,
  );
}

/**
 * Compact context indicator for the narrow band: `63% ▓▓▓▓░░`. The
 * percentage sits right after the label so right-side truncation never eats
 * it; the mini-bar is the first thing sacrificed when space runs out.
 */
function buildCompactContextIndicator(
  usage: ContextUsage,
  cells: number,
  theme: FooterTheme,
): string {
  const bar = contextBar(usage.percent, cells);
  const percentLabel =
    usage.percent === null ? "?" : `${Math.round(usage.percent)}`;
  return theme.fg(contextColor(usage.percent), `${percentLabel}% ${bar}`);
}

/**
 * Footer breakpoints, in terminal columns. At or above `WIDE_MIN_WIDTH`
 * every data point is shown (directory|model on top, git|context · cost
 * below). Between `MEDIUM_MIN_WIDTH` and `WIDE_MIN_WIDTH` the directory
 * replaces the git line as the priority info, sitting beside the model with
 * the full context indicator underneath. Below `MEDIUM_MIN_WIDTH` a single
 * line pairs the directory with the compact context percentage, so the
 * directory stays visible no matter how narrow the footer gets.
 */
export const MEDIUM_MIN_WIDTH = 80;
export const WIDE_MIN_WIDTH = 100;

export interface FooterTheme {
  fg(color: ThemeColor, text: string): string;
}

/** Pre-colored content pieces; each layout band decides what to show. */
export interface FooterContent {
  directory: string;
  git: string;
  model: string;
  usage: string;
  context: string;
  contextPercent: string;
}

/**
 * Detached HEAD detection: `git-info` reports a detached HEAD as
 * `detached@<short-head>` (or bare `detached` when the short head is
 * unavailable), because `git branch --show-current` is empty there. Any
 * branch following that convention counts as detached.
 */
export function isDetachedGit(branch: string): boolean {
  return branch === "detached" || branch.startsWith("detached@");
}

/**
 * Compact, per-segment colored git line, e.g. `main · +3 · PR #12` or
 * `detached@abc1234 · clean`. Each segment keeps its own semantic color
 * instead of one color for the whole line: the branch is `muted` — or
 * `warning` when detached, a common legitimate state (inspecting a commit
 * or tag) that is worth flagging as "not on a branch" but is not an error;
 * the working tree is `success` when clean and `warning` when it has
 * changes; the PR is `accent` and `dim` when it is a draft, keeping its
 * hyperlink when the terminal supports it. Empty when there is no branch,
 * which also covers non-repositories.
 */
export function buildGitLine(
  git: GitInfoState,
  theme: FooterTheme,
  hyperlinksEnabled: boolean,
): string {
  if (!git.branch) return "";

  const branchColor: ThemeColor = isDetachedGit(git.branch)
    ? "warning"
    : "muted";
  const treeColor: ThemeColor = git.changedFiles === 0 ? "success" : "warning";
  const treeLabel = git.changedFiles === 0 ? "clean" : `+${git.changedFiles}`;
  let line = `${theme.fg(branchColor, git.branch)} · ${theme.fg(
    treeColor,
    treeLabel,
  )}`;

  if (git.pullRequest) {
    const prLabel = `PR #${git.pullRequest.number}`;
    const linkedPr = hyperlinksEnabled
      ? hyperlink(prLabel, git.pullRequest.url)
      : prLabel;
    line += ` · ${theme.fg(
      git.pullRequest.isDraft ? "dim" : "accent",
      linkedPr,
    )}`;
  }
  return line;
}

export function buildFooterContent(
  cwd: string,
  git: GitInfoState,
  model: ModelInfoState,
  theme: FooterTheme,
  hyperlinksEnabled: boolean,
): FooterContent {
  const directory = theme.fg("text", formatDirectory(cwd));

  const gitLine = buildGitLine(git, theme, hyperlinksEnabled);

  const contextUsage = computeContextUsage(model);
  const contextIndicator = buildContextIndicator(
    contextUsage,
    CONTEXT_BAR_CELLS,
    theme,
  );
  const compactIndicator = buildCompactContextIndicator(
    contextUsage,
    CONTEXT_MINI_BAR_CELLS,
    theme,
  );
  const modelIdentity = model.provider
    ? `${model.provider}/${model.modelId}`
    : model.modelId;

  return {
    directory,
    git: gitLine,
    // The thinking level lives on the editor's bottom-border badge only
    // (see `decorateThinkingBorder`), not in the footer.
    model: theme.fg("muted", modelIdentity),
    usage: `${contextIndicator} · ${theme.fg(
      "muted",
      `$${model.cost.toFixed(2)}`,
    )}`,
    context: contextIndicator,
    contextPercent: compactIndicator,
  };
}

export function footerLayout(content: FooterContent, width: number): string[] {
  if (width >= WIDE_MIN_WIDTH) {
    // All data: directory | model, then git | context · cost.
    return [
      columns(content.directory, content.model, width),
      columns(content.git, content.usage, width),
    ];
  }
  if (width >= MEDIUM_MIN_WIDTH) {
    // The directory replaces git as the priority info: directory | model,
    // with the full context indicator underneath; git and cost are kept for
    // the wide band only.
    return [
      columns(content.directory, content.model, width, true),
      columns(content.context, "", width),
    ];
  }
  // Compact: directory on the left (tail preserved when truncated) with the
  // context percentage on the right.
  return [compactFooterLine(content.directory, content.contextPercent, width)];
}

export function appendStatusLines(
  lines: string[],
  statuses: ReadonlyMap<string, string>,
  width: number,
  theme: FooterTheme,
): string[] {
  const statusLines = Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, text]) => text.split("\n"));
  for (const statusLine of statusLines) {
    lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
  }
  return lines;
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  function renderFooterLines(
    ctx: ExtensionContext,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
    width: number,
  ) {
    const content = buildFooterContent(
      ctx.cwd,
      gitInfo,
      modelInfo,
      theme,
      getCapabilities().hyperlinks,
    );
    const lines = footerLayout(content, width);
    return appendStatusLines(
      lines,
      footerData.getExtensionStatuses(),
      width,
      theme,
    );
  }

  function installEditor(ctx: ExtensionContext) {
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
        class ThemedEditor extends CustomEditor {
          borderColor = (text: string) =>
            ctx.ui.theme.fg(thinkingColor(modelInfo.thinking), text);

          /**
           * Decorates the bottom border with a right-aligned thinking-level
           * badge (e.g. ` HIGH `) sharing the border's semantic color, so the
           * border color's meaning is explicit. Everything else (content,
           * cursor, autocomplete, keybindings) is handled by the parent.
           */
          render(width: number) {
            const lines = super.render(width);
            const last = lines[lines.length - 1];
            if (last !== undefined && isBottomBorder(last)) {
              lines[lines.length - 1] = decorateThinkingBorder(
                last,
                thinkingBadgeLabel(modelInfo.thinking),
                this.borderColor,
                width,
              );
            }
            return lines;
          }
        }

        return new ThemedEditor(tui, theme, keybindings);
      },
    );
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      requestRender = () => tui.requestRender();

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line) =>
            center(theme.fg("accent", line), width),
          );
          const subtitle = center(theme.fg("accent", theme.bold(title)), width);
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();
      const stopBranchListener = footerData.onBranchChange(() =>
        tui.requestRender(),
      );

      return {
        invalidate() {},
        render(width: number) {
          return renderFooterLines(ctx, theme, footerData, width);
        },
        dispose() {
          stopBranchListener();
        },
      };
    });

    installEditor(ctx);
    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    install(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
