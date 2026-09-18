/**
 * /ps UI — two-stage full-screen overlay over the synchronous
 * TerminalReadModel:
 * - TerminalDashboard: list of all tracked terminals (select, kill, open).
 * - TerminalDetailView: read-only inspector for one terminal — metadata,
 *   stdout/stderr toggle, scrolling, live tail. No input surface: background
 *   terminals have no stdin by design.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TerminalObserverCoordinator } from "../observer.ts";
import { formatElapsed, formatExit, type TerminalSnapshot } from "../domain.ts";
import type { TerminalReadModel } from "../manager.ts";
import { viewportRows } from "../../../shared/ui/viewport.ts";
import { createOutputLineCache, sanitizeText } from "./output-view.ts";

/** One-line-safe rendering of model-provided text (titles, commands): a
 * newline or control char inside a fixed-height row desyncs the renderer. */
function oneLine(text: string) {
  return sanitizeText(text.replace(/\s+/g, " "));
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

/** Pad to `width` cells (or truncate with `…`) so a bordered row stays square. */
function pad(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Top/bottom border segment of a `border` panel, carrying its title. */
function borderSegment(theme: Theme, width: number, title: string): string {
  const label = title
    ? ` ${truncateToWidth(title, Math.max(0, width - 3), "…")} `
    : "";
  const labelWidth = visibleWidth(label);
  return (
    theme.fg("border", "─") +
    (label ? theme.fg("text", label) : "") +
    theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
  );
}

function statusGlyph(snap: TerminalSnapshot, theme: Theme) {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "failed":
      return theme.fg("error", "■");
    case "killed":
      return theme.fg("muted", "■");
  }
}

function statusWord(snap: TerminalSnapshot, theme: Theme) {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "failed":
      return theme.fg("error", "failed");
    case "killed":
      return theme.fg("muted", "killed");
  }
}

// --- Entry point ---------------------------------------------------------------

/**
 * Try to take the terminal over in its Herdr observer pane: marks the
 * observer taken over (it then survives the terminal's settle) and focuses
 * the Pi Workers workspace. Returns true when a live observer pane exists;
 * callers keep the in-session overlay otherwise.
 */
export async function tryOpenTerminalObserver(
  ctx: ExtensionCommandContext,
  coordinator: TerminalObserverCoordinator | undefined,
  id: string,
): Promise<boolean> {
  if (!coordinator) return false;
  if (!(await coordinator.takeOver(id))) return false;
  ctx.ui.notify(`Terminal ${id} opened in the Pi Workers workspace`, "info");
  return true;
}

export async function openTerminalPicker(
  ctx: ExtensionCommandContext,
  view: TerminalReadModel,
  coordinator: TerminalObserverCoordinator | undefined,
) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No background terminals", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new TerminalDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    if (await tryOpenTerminalObserver(ctx, coordinator, picked)) return;

    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
        new TerminalDetailView(tui, theme, keybindings, picked, view, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    // After leaving the detail view, fall back to the dashboard. A successful
    // observer take-over returns above: the workspace replaces the UI, so
    // reopening the dashboard here would loop.
  }
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  terminals: ReadonlyArray<Pick<TerminalSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? terminals.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(
          Math.max(0, selection.index),
          Math.max(0, terminals.length - 1),
        );
  selection.id = terminals[selection.index]?.id;
}

class TerminalDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: TerminalReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;

  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: TerminalReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    // Elapsed times and output sizes tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private terminals(): ReadonlyArray<TerminalSnapshot> {
    return this.view.list();
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    return true;
  }

  private close(result: string | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const terminals = this.terminals();
    reconcileDashboardSelection(this.selection, terminals);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = terminals[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (terminals.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + terminals.length) % terminals.length;
        this.selection.id = terminals[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (terminals.length > 0) {
        this.selection.index = (this.selection.index + 1) % terminals.length;
        this.selection.id = terminals[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = terminals[this.selection.index];
      if (snap && snap.status === "running") this.view.requestKill(snap.id);
      return;
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const terminals = this.terminals();
    reconcileDashboardSelection(this.selection, terminals);

    // Render exactly terminal rows - 1 so the overlay covers the header,
    // chat, editor, and extra footer lines while leaving pi's final footer
    // row visible.
    const bodyHeight = viewportRows(this.tui.terminal.rows, 5, 6);
    const innerWidth = width - 2;

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("Background terminals"));
    const headerRight = theme.fg(
      "muted",
      `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`,
    );
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
        "…",
      ),
    );

    // Top border with panel title
    const running = terminals.filter((s) => s.status === "running").length;
    lines.push(
      theme.fg("border", "╭") +
        borderSegment(
          theme,
          innerWidth,
          `terminals · ${running} running / ${terminals.length}`,
        ) +
        theme.fg("border", "╮"),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(terminals, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + pad(rowLines[i] ?? "", innerWidth) + divider);
    }

    // Bottom border
    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
        theme.fg("border", "╯"),
    );

    // Hints
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} inspect · x kill · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
        "…",
      ),
    );

    return lines;
  }

  private renderRows(
    terminals: ReadonlyArray<TerminalSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (terminals.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        terminals.length - height,
      );
    }
    const visible = terminals.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      // Left: marker, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", oneLine(snap.title))
        : theme.fg("text", oneLine(snap.title));
      const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;

      // Right: pid · elapsed · exit/status
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", `pid ${snap.pid ?? "?"}`),
        theme.fg("muted", formatElapsed(snap)),
        snap.status === "running"
          ? statusWord(snap, theme)
          : theme.fg("muted", formatExit(snap)),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax, "…");
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(
        truncateToWidth(leftTruncated + " ".repeat(gap) + right, width, "…"),
      );
    }

    if (start > 0) {
      out[0] = truncateToWidth(
        theme.fg("dim", `   … ${start} more`),
        width,
        "…",
      );
    }
    if (start + height < terminals.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   … ${terminals.length - start - height} more`),
        width,
        "…",
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Detail view (read-only inspector) --------------------------------------------

const OUTPUT_SCROLL_STEP = 6;

class TerminalDetailView implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: TerminalReadModel;
  private done: (value: null) => void;

  /** Active output stream shown in the viewport; `t` toggles. */
  private stream: "stdout" | "stderr" = "stdout";
  /** Scroll offset in lines from the bottom. 0 = pinned to bottom (live tail). */
  private scrollOffset = 0;
  private lineCache = createOutputLineCache();
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: TerminalReadModel,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
  }

  private snap(): TerminalSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // A chatty process emits a chunk per write. Limit terminal repaints so
    // this view cannot starve input handling.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (data === "t") {
      this.stream = this.stream === "stdout" ? "stderr" : "stdout";
      this.lineCache = createOutputLineCache();
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "x") {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestKill(this.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k") {
      this.scrollOffset += OUTPUT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.editor.cursorDown") ||
      data === "j"
    ) {
      this.scrollOffset = Math.max(0, this.scrollOffset - OUTPUT_SCROLL_STEP);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffset = Number.MAX_SAFE_INTEGER; // clamped to top in render
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
  }

  private viewportHeight(): number {
    // The complete view renders viewport + 6 chrome rows (header, top border,
    // command, tab, bottom border, hints), leaving pi's final footer row
    // visible.
    return viewportRows(this.tui.terminal.rows, 7, 6);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const innerWidth = Math.max(1, width - 2);
    const divider = theme.fg("border", "│");
    const lines: string[] = [];
    const snap = this.snap();

    // Panel frame of `docs/ui-conventions.md` section 1: `border` box with
    // the title on the top border, like the dashboard above it.
    const topBorder = (label: string) =>
      theme.fg("border", "╭") +
      borderSegment(theme, innerWidth, label) +
      theme.fg("border", "╮");
    const bottomBorder =
      theme.fg("border", "╰") +
      theme.fg("border", "─".repeat(innerWidth)) +
      theme.fg("border", "╯");
    const row = (text: string) => divider + pad(text, innerWidth) + divider;

    if (!snap) {
      lines.push(topBorder(`terminal · ${oneLine(this.id)}`));
      lines.push(row(theme.fg("dim", `${this.id} is no longer tracked`)));
      lines.push(bottomBorder);
      return lines;
    }

    const header =
      `${statusGlyph(snap, theme)} ` +
      theme.fg("accent", theme.bold(`${snap.id} · ${oneLine(snap.title)}`)) +
      theme.fg(
        "muted",
        ` · ${snap.status} · ${formatElapsed(snap)} · pid ${snap.pid ?? "?"}`,
      ) +
      (snap.status !== "running"
        ? theme.fg("muted", ` · ${formatExit(snap)}`)
        : "") +
      theme.fg("dim", ` · ${snap.cwd}`);
    lines.push(truncateToWidth(header, width, "…"));
    lines.push(topBorder(`terminal · ${oneLine(snap.id)}`));
    lines.push(
      row(theme.fg("dim", "$ ") + theme.fg("text", oneLine(snap.command))),
    );

    // Stream tab line: which stream is active, both sizes.
    const active = this.stream;
    const viewData = active === "stdout" ? snap.stdout : snap.stderr;
    const tab = (name: "stdout" | "stderr", size: number) =>
      name === active
        ? theme.fg("accent", theme.bold(`${name} (${formatSize(size)})`))
        : theme.fg("dim", `${name} (${formatSize(size)})`);
    lines.push(
      row(
        `  ${tab("stdout", snap.stdout.totalBytes)}${theme.fg("dim", " | ")}${tab("stderr", snap.stderr.totalBytes)}${theme.fg("dim", " · t to switch")}`,
      ),
    );

    // Fixed-height output viewport. Notes and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    const buffer = viewData;
    const version =
      // The cached view text identity changes with the buffer; totalBytes is a
      // monotonically increasing proxy for a version counter.
      buffer.totalBytes;
    const output = this.lineCache.get(
      buffer.text,
      version,
      width - 2,
      buffer.truncatedChars,
    );
    const viewport = this.viewportHeight();

    const noteRows: string[] = [];
    if (snap.errorText) {
      noteRows.push(theme.fg("error", `error: ${oneLine(snap.errorText)}`));
    }
    if (buffer.truncatedBytes > 0) {
      noteRows.push(
        theme.fg(
          "dim",
          `first ${formatSize(buffer.truncatedBytes)} dropped from view — full log: ${buffer.spillPath ?? "(unavailable)"}`,
        ),
      );
    }

    const body: string[] = [...noteRows];
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const capacity = Math.max(1, viewport - body.length - scrollRows);
    const maxOffset = Math.max(0, output.length - capacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const end = output.length - this.scrollOffset;
    const visible = output.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) {
      body.push(theme.fg("dim", `(no ${active} yet)`));
    } else {
      for (const line of visible) {
        body.push(`  ${line}`);
      }
    }

    if (this.scrollOffset > 0) {
      body.push(
        theme.fg(
          "dim",
          `… ${this.scrollOffset} lines below · ${configuredKeys(this.keybindings, "tui.editor.cursorDown")}`,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    for (const line of body.slice(0, viewport)) lines.push(row(line));

    lines.push(bottomBorder);
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.select.cancel")} back · t stdout/stderr · x kill · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")}/jk scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page · g/G top/bottom`,
        ),
        width,
        "…",
      ),
    );
    return lines;
  }

  invalidate(): void {}
}
