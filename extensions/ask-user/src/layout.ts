import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { wrapViewportText } from "../../shared/ui/viewport.ts";

export interface AskUserLayoutOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

export interface AskUserLayoutTheme {
  accent: (text: string) => string;
  bold: (text: string) => string;
  border: (text: string) => string;
  dim: (text: string) => string;
  muted: (text: string) => string;
  text: (text: string) => string;
}

export interface AskUserLayoutInput {
  width: number;
  terminalRows: number;
  question: string;
  options: AskUserLayoutOption[];
  optionIndex: number;
  questionScroll: number;
  detailsExpanded: boolean;
  editMode: boolean;
  editorLines?: string[];
}

export interface AskUserLayoutResult {
  lines: string[];
  questionLineCount: number;
  questionVisibleLines: number;
  questionScroll: number;
}

interface ViewportResult {
  lines: string[];
  scroll: number;
  visibleLines: number;
}

const COMPACT_LAYOUT_HEIGHT = 14;
const COLLAPSED_DETAIL_LINES = 2;
const EXPANDED_DETAIL_LINES = 8;

function layoutHeight(terminalRows: number): number {
  // The overlay is capped at 90% too. Keep a small usable floor so that the
  // compact layout can still show every option and its controls on short TTYs.
  return Math.max(8, Math.floor(Math.max(1, terminalRows) * 0.9));
}

function visibleQuestionLines(maxLines: number): number {
  return maxLines >= 3 ? maxLines - 2 : 1;
}

function clampScroll(
  scroll: number,
  lineCount: number,
  maxLines: number,
): number {
  return Math.min(
    Math.max(0, scroll),
    Math.max(0, lineCount - visibleQuestionLines(maxLines)),
  );
}

/** Move a question viewport by one page while keeping its bounds valid. */
export function pageQuestionScroll(
  scroll: number,
  direction: -1 | 1,
  lineCount: number,
  visibleLines: number,
): number {
  const page = Math.max(1, visibleLines - 1);
  return Math.min(
    Math.max(0, scroll + direction * page),
    Math.max(0, lineCount - Math.max(1, visibleLines)),
  );
}

function renderViewport(
  sourceLines: string[],
  requestedScroll: number,
  maxLines: number,
  width: number,
  formatLine: (line: string) => string,
  formatIndicator: (text: string) => string,
): ViewportResult {
  const safeMaxLines = Math.max(1, maxLines);
  const visibleLines = visibleQuestionLines(safeMaxLines);
  const scroll = clampScroll(requestedScroll, sourceLines.length, safeMaxLines);
  const clipped = sourceLines.length > visibleLines;

  if (!clipped) {
    return {
      lines: sourceLines.map(formatLine),
      scroll,
      visibleLines,
    };
  }

  const visible = sourceLines.slice(scroll, scroll + visibleLines);
  const above = scroll;
  const below = sourceLines.length - scroll - visible.length;
  const indicator = (arrow: "↑" | "↓", count: number) =>
    truncateToWidth(formatIndicator(`${arrow} ${count} more`), width, "");

  if (safeMaxLines >= 3) {
    return {
      lines: [
        above > 0 ? indicator("↑", above) : "",
        ...visible.map(formatLine),
        below > 0 ? indicator("↓", below) : "",
      ],
      scroll,
      visibleLines,
    };
  }

  if (safeMaxLines === 2) {
    const marker = below > 0 ? indicator("↓", below) : indicator("↑", above);
    return {
      lines: [formatLine(visible[0] ?? ""), marker],
      scroll,
      visibleLines,
    };
  }

  // A one-line question viewport still shows its current text and an explicit
  // overflow marker. This is important on very short terminals, where there
  // is no room for separate indicator rows.
  const marker = below > 0 ? ` ↓ ${below} more` : ` ↑ ${above} more`;
  const formattedMarker = truncateToWidth(formatIndicator(marker), width, "");
  const markerWidth = visibleWidth(formattedMarker);
  const contentWidth = Math.max(0, width - markerWidth);
  return {
    lines: [
      `${truncateToWidth(formatLine(visible[0] ?? ""), contentWidth, "")}${formattedMarker}`,
    ],
    scroll,
    visibleLines,
  };
}

function wrapAnsi(text: string, width: number): string[] {
  return wrapViewportText(text, Math.max(1, width));
}

function optionLine(
  option: AskUserLayoutOption,
  index: number,
  selected: boolean,
  width: number,
  theme: AskUserLayoutTheme,
): string {
  const prefix = selected ? theme.accent(" ❯ ") : "   ";
  const marker = option.isOther ? "✎" : `${index + 1}.`;
  const label = `${marker} ${option.label}`;
  const styled = selected
    ? theme.accent(label)
    : theme.text(option.isOther ? theme.muted(label) : label);
  return truncateToWidth(`${prefix}${styled}`, width);
}

function detailLine(line: string, width: number, theme: AskUserLayoutTheme) {
  return truncateToWidth(`      ${theme.muted(line)}`, width);
}

function questionLine(line: string, width: number, theme: AskUserLayoutTheme) {
  return truncateToWidth(` ${theme.text(theme.bold(line))}`, width);
}

/**
 * Render the ask_user component within a height budget derived from the TTY.
 * Options and the footer are fixed-cost rows; question/detail text gets the
 * remaining space and is always represented by a bounded viewport.
 */
export function renderAskUserLayout(
  input: AskUserLayoutInput,
  theme: AskUserLayoutTheme,
): AskUserLayoutResult {
  const width = Math.max(1, input.width);
  const height = layoutHeight(input.terminalRows);
  const selected = input.options[input.optionIndex];
  const questionLines = wrapAnsi(input.question, Math.max(1, width - 1));
  const compact = height < COMPACT_LAYOUT_HEIGHT;
  const hasDetails = !input.editMode && !!selected?.description;

  const lines: string[] = [];
  let questionMaxLines: number;

  const footer = input.editMode
    ? width < 24
      ? " Enter submit · Esc"
      : " Enter submit · Esc back to options"
    : width < 26
      ? ` ↑↓ Pg↑↓${hasDetails ? " Tab" : ""} Enter Esc`
      : width < 30
        ? ` ↑↓ PgUp/Dn${hasDetails ? " Tab" : ""} Enter Esc`
        : hasDetails
          ? ` ↑↓ select · PgUp/PgDn question · Tab ${input.detailsExpanded ? "collapse" : "details"} · Enter · Esc dismiss`
          : " ↑↓ select · PgUp/PgDn question · Enter confirm · Esc dismiss";

  if (compact) {
    // Compact mode deliberately removes decorative borders and the separate
    // title row. That leaves room for all six rows (five choices + custom),
    // the question, and the footer even on short terminals.
    const fixed = 1 + input.options.length + 1;
    questionMaxLines = 1;
    let remaining = Math.max(0, height - fixed);
    let detailMaxLines = 0;
    if (hasDetails) {
      detailMaxLines = Math.min(
        input.detailsExpanded ? EXPANDED_DETAIL_LINES : COLLAPSED_DETAIL_LINES,
        remaining,
      );
      remaining -= detailMaxLines;
    }

    const question = renderViewport(
      questionLines,
      input.questionScroll,
      questionMaxLines,
      width,
      (line) => questionLine(line, width, theme),
      (text) => theme.dim(text),
    );
    lines.push(...question.lines);

    input.options.forEach((option, index) => {
      lines.push(
        optionLine(option, index, index === input.optionIndex, width, theme),
      );
    });

    if (hasDetails && detailMaxLines > 0) {
      const details = renderViewport(
        wrapAnsi(selected.description!, Math.max(1, width - 6)),
        0,
        detailMaxLines,
        width,
        (line) => detailLine(`↳ ${line}`, width, theme),
        (text) => detailLine(text, width, theme),
      );
      lines.push(...details.lines);
    }

    if (input.editMode && remaining > 0) {
      const editor = input.editorLines ?? [];
      if (remaining === 1) {
        lines.push(
          truncateToWidth(
            ` ${theme.muted("Your answer:")} ${editor[0] ?? ""}`,
            width,
          ),
        );
      } else {
        lines.push(truncateToWidth(` ${theme.muted("Your answer:")}`, width));
        lines.push(
          ...editor
            .slice(0, remaining - 1)
            .map((line) => truncateToWidth(` ${line}`, width)),
        );
      }
    }

    lines.push(truncateToWidth(theme.dim(footer), width));
    return {
      lines,
      questionLineCount: questionLines.length,
      questionVisibleLines: question.visibleLines,
      questionScroll: question.scroll,
    };
  }

  const fixed = 1 + 1 + input.options.length + 1 + 1;
  const available = Math.max(1, height - fixed);
  let detailMaxLines = 0;
  let editorMaxLines = 0;

  if (hasDetails) {
    detailMaxLines = Math.min(
      input.detailsExpanded ? EXPANDED_DETAIL_LINES : COLLAPSED_DETAIL_LINES,
      Math.max(0, available - 1),
    );
  } else if (input.editMode) {
    const editor = input.editorLines ?? [];
    const desired = Math.max(1, Math.min(editor.length || 1, 6));
    editorMaxLines = Math.min(desired, Math.max(1, available - 2));
  }
  questionMaxLines = Math.max(
    1,
    available -
      detailMaxLines -
      editorMaxLines -
      (input.editMode && editorMaxLines > 0 ? 1 : 0),
  );

  lines.push(theme.border("─".repeat(width)));
  lines.push(
    truncateToWidth(` ${theme.accent(theme.bold("Question"))}`, width),
  );

  const question = renderViewport(
    questionLines,
    input.questionScroll,
    questionMaxLines,
    width,
    (line) => questionLine(line, width, theme),
    (text) => theme.dim(text),
  );
  lines.push(...question.lines);

  input.options.forEach((option, index) => {
    lines.push(
      optionLine(option, index, index === input.optionIndex, width, theme),
    );
  });

  if (hasDetails && detailMaxLines > 0) {
    const details = renderViewport(
      wrapAnsi(selected.description!, Math.max(1, width - 6)),
      0,
      detailMaxLines,
      width,
      (line) => detailLine(`↳ ${line}`, width, theme),
      (text) => detailLine(text, width, theme),
    );
    lines.push(...details.lines);
  }

  if (input.editMode && editorMaxLines > 0) {
    lines.push(truncateToWidth(` ${theme.muted("Your answer:")}`, width));
    lines.push(
      ...(input.editorLines ?? [])
        .slice(0, editorMaxLines)
        .map((line) => truncateToWidth(` ${line}`, width)),
    );
  }

  lines.push(truncateToWidth(theme.dim(footer), width));
  lines.push(theme.border("─".repeat(width)));

  return {
    lines,
    questionLineCount: questionLines.length,
    questionVisibleLines: question.visibleLines,
    questionScroll: question.scroll,
  };
}
