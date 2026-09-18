/**
 * One source of truth for stripping untrusted terminal text before it is
 * styled and wrapped by an overlay.
 *
 * Every dashboard used to carry its own OSC/CSI/escape matchers, and they
 * drifted: one variant removed tabs while another preserved them, and OSC/CSI
 * leaked in some overlays and disappeared in others. The escape sequences only
 * need to be recognized once; the policies on top of them (tabs, newlines) are
 * passed in by the caller because a body line and a one-line label genuinely
 * want different treatment.
 *
 * The policy itself never adds styling: callers keep using theme.fg/theme.bg,
 * so terminal-expanded tabs and stray escapes can never desync the width the
 * TUI believes a line has.
 */

// OSC strings (window titles, hyperlinks, etc.) end in BEL or ST. Strip them
// before the generic escape/control pass so their payload never becomes
// visible text after only the leading ESC byte is removed.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// Standards-shaped CSI matcher: parameters are deliberately unbounded; a
// five-digit cursor movement is still one control sequence, not visible text.
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// Remaining two-byte/charset escape forms (for example ESC ( 0).
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;
// C0/C1 controls, keeping `\t` and `\n` for the caller's policy to decide.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Single-line labels also drop tab, CR and LF.
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export interface SanitizeTerminalTextOptions {
  /**
   * Expand tabs to this many spaces. Omit to keep tabs intact: the diff
   * viewer expands them itself so source indentation stays aligned.
   */
  tabWidth?: number;
  /** Collapse to a single line: drop tabs, CR and LF along with the controls. */
  singleLine?: boolean;
}

/**
 * Strip terminal control sequences, expand or drop tabs, and remove remaining
 * control characters. Newlines survive unless `singleLine` is set.
 */
export function sanitizeTerminalText(
  text: string,
  options: SanitizeTerminalTextOptions = {},
): string {
  const escaped = text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "");
  if (options.singleLine) {
    return escaped.replace(SINGLE_LINE_CONTROL_PATTERN, "");
  }
  const tabWidth = options.tabWidth ?? 0;
  const expanded =
    tabWidth > 0 ? escaped.replaceAll("\t", " ".repeat(tabWidth)) : escaped;
  return expanded.replace(CONTROL_PATTERN, "");
}
