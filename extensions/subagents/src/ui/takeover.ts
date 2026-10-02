/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: full popup (overlay) listing all subagents.
 * - TakeoverView: full interactive view of one subagent with an input line
 *   to steer/continue it.
 *
 * Inside Herdr, take-over hands the subagent over to its real interactive
 * TUI in the shared workspace's Subagents tab (the read model's
 * requestTakeOver focuses the live pane or reopens+sessions-resumes it) —
 * the overlay stays for outside-Herdr / in-process fallback sessions.
 */

import {
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sliceViewport, viewportRows } from "../../../shared/ui/viewport.ts";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization, isStalled } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { createTranscriptLineCache } from "./transcript.ts";

/** Explicit ellipsis: the pi-tui default `...` must not appear in overlays. */
const ELLIPSIS = "…";

/**
 * Hint keys must come from the manager the component was actually built with,
 * not the process-global `keyText()`: a user remap would otherwise make the
 * hint lie about the key the handler accepts.
 */
function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  if (snap.status === "running" && isStalled(snap)) {
    return theme.fg("error", "stalled");
  }
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

// --- Entry points --------------------------------------------------------------

export interface TakeoverOptions {
  readonly badge?: string;
}

/**
 * Try to open this subagent's live Herdr TUI pane as the takeover surface:
 * running subagents focus the existing pane (never interrupted) and keep it
 * open; settled subagents reopen + resume the exact native session. Resolves
 * true when a pane is showing the session; in-process fallback sessions (or
 * no Herdr workspace) resolve false and callers keep the overlay.
 */
export async function tryOpenInHerdrPane(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
  id: string,
): Promise<boolean> {
  const snap = view.get(id);
  if (!snap) return false;
  const takenOver = await view.requestTakeOver(id);
  if (takenOver) {
    const paneId = view.get(id)?.meta.herdrPaneId;
    ctx.ui.notify(
      paneId
        ? `Subagent ${id} taken over in Herdr pane ${paneId}`
        : `Subagent ${id} taken over in Herdr`,
      "info",
    );
  }
  return takenOver;
}

export async function openSubagentTakeover(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
  id: string,
  options?: TakeoverOptions,
): Promise<boolean> {
  if (!view.get(id)) return false;
  if (await tryOpenInHerdrPane(ctx, view, id)) return true;
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(tui, theme, keybindings, id, view, done, options),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
  return false;
}

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    const openedPane = await openSubagentTakeover(ctx, view, picked);
    if (openedPane) return;
    // After leaving the in-session takeover view, return to the dashboard.
  }
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

export class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;

  private closed = false;
  /** Id of a running subagent whose abort is armed (awaiting a second `x`). */
  private armedAbortId: string | undefined;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    // Elapsed times, token counts, and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
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
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    // The destructive `x` is armed by its first press and confirmed by the
    // second; any other key (including close) disarms it.
    const wasArmed = this.armedAbortId;
    if (data !== "x") this.armedAbortId = undefined;

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + subs.length) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = subs[this.selection.index];
      if (snap && snap.status === "running") {
        if (wasArmed === snap.id) {
          this.view.requestAbort(snap.id);
        } else {
          this.armedAbortId = snap.id;
        }
      }
      this.tui.requestRender();
      return;
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width, ELLIPSIS);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, width - 3), ELLIPSIS)} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    const rows = this.tui.terminal.rows || 30;
    // Render exactly terminal rows - 1 so the overlay covers the header,
    // chat, editor, and extra footer lines while leaving pi's final footer
    // row visible.
    const bodyHeight = viewportRows(rows, 5, 6);
    const innerWidth = width - 2;

    const lines: string[] = [];

    // Header: title left, settled/total right. The count appears exactly once;
    // the panel border below carries only the section label.
    const settled = subs.filter((s) => s.status !== "running").length;
    const headerLeft = theme.fg("accent", theme.bold("Subagents"));
    const headerRight = theme.fg("dim", `${settled}/${subs.length}`);
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
        ELLIPSIS,
      ),
    );

    // Top border with panel title
    lines.push(
      theme.fg("border", "╭") +
        this.borderSegment(innerWidth, "subagents") +
        theme.fg("border", "╮"),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(subs, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider);
    }

    // Bottom border
    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );

    // Hints. The armed abort is called out so the confirmation is explicit.
    lines.push(
      truncateToWidth(
        [
          theme.fg(
            "dim",
            `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk`,
          ) + theme.fg("muted", " select"),
          theme.fg(
            "dim",
            configuredKeys(this.keybindings, "tui.select.confirm"),
          ) + theme.fg("muted", " take over"),
          this.armedAbortId !== undefined
            ? theme.fg("error", "x again to abort")
            : theme.fg("dim", "x") + theme.fg("muted", " abort"),
          theme.fg(
            "dim",
            configuredKeys(this.keybindings, "tui.select.cancel"),
          ) + theme.fg("muted", " close"),
        ].join(theme.fg("dim", " · ")),
        width,
        ELLIPSIS,
      ),
    );

    return lines;
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window centered on the selection; sliceViewport clamps the
    // offset to the maximum window so the ". . . more" markers stay truthful.
    const centered = Math.max(0, this.selection.index - Math.floor(height / 2));
    const window = sliceViewport(subs, centered, height);
    const visible = window.items;

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = window.offset + i;
      const isSelected = index === this.selection.index;

      // Left: marker, question badge, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const question = snap.question ? theme.fg("warning", "❓") : " ";
      const title = isSelected
        ? theme.fg("accent", snap.title)
        : theme.fg("text", snap.title);
      const left = ` ${marker}${question} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;

      // Right: backend · model · context utilization · elapsed · status
      const utilization = formatContextUtilization(snap.usage);
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", snap.backend),
        theme.fg("muted", snap.meta.modelLabel ?? "?"),
        ...(utilization ? [theme.fg("muted", utilization)] : []),
        theme.fg("muted", formatElapsed(snap)),
        statusWord(snap, theme),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax, ELLIPSIS);
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(
        truncateToWidth(
          leftTruncated + " ".repeat(gap) + right,
          width,
          ELLIPSIS,
        ),
      );
    }

    if (window.above > 0) {
      out[0] = truncateToWidth(
        theme.fg("dim", `   ${ELLIPSIS} ${window.above} more`),
        width,
        ELLIPSIS,
      );
    }
    if (window.below > 0) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ${ELLIPSIS} ${window.below} more`),
        width,
        ELLIPSIS,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view ------------------------------------------------------------

const TRANSCRIPT_SCROLL_STEP = 6;

export class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;
  private options?: TakeoverOptions;

  private input = new Input();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private transcriptCache = createTranscriptLineCache();
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;
  /** True while `app.clear` is armed and awaiting a second press to abort. */
  private cancelArmed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
    options?: TakeoverOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.options = options;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
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
    const clearPressed = this.keybindings.matches(data, "app.clear");
    const wasArmed = this.cancelArmed;
    if (!clearPressed) this.cancelArmed = false;

    // `app.clear` (ctrl+c by default) is the only cancel/abort trigger: it
    // arms on the first press and confirms on the second. It is checked before
    // the generic overlay cancel because ctrl+c matches both; escape and every
    // other close path must never abort a running worker.
    if (clearPressed) {
      const snap = this.snap();
      if (snap?.status === "running") {
        if (wasArmed) {
          this.cancelArmed = false;
          this.view.requestAbort(this.id);
        } else {
          this.cancelArmed = true;
        }
      } else {
        // Nothing to cancel: `app.clear` falls back to closing the view.
        this.close();
        return;
      }
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
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
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    // The complete view renders viewport + 7 chrome rows; reserving terminal
    // rows - 8 makes the overlay exactly terminal rows - 1.
    return viewportRows(this.tui.terminal.rows || 30, 8, 6);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      lines.push(border);
      lines.push(theme.fg("dim", `${this.id} is no longer tracked`));
      lines.push(border);
      return lines;
    }

    lines.push(border);
    const utilization = formatContextUtilization(snap.usage);
    const header =
      `${statusGlyph(snap, theme)} ` +
      theme.fg("accent", theme.bold(`${snap.id} · ${snap.title}`)) +
      theme.fg("muted", ` · ${snap.status} · ${formatElapsed(snap)}`) +
      (this.options?.badge
        ? theme.fg("muted", ` · ${this.options.badge}`)
        : "") +
      theme.fg("dim", ` · ${snap.backend}: ${snap.meta.modelLabel ?? "?"}`) +
      (utilization ? theme.fg("dim", ` · ${utilization}`) : "");
    lines.push(truncateToWidth(header, width, ELLIPSIS));
    lines.push(border);

    // Fixed-height transcript viewport. Error and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    // The lines are memoized by (revision, width, theme): the 1 Hz clock,
    // scrolling and keystrokes reuse the previous frame instead of re-wrapping
    // the whole history.
    const transcript = this.transcriptCache.get(snap, width, theme);
    const viewport = this.viewportHeight();
    const errorRows = snap.errorText ? 1 : 0;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows - scrollRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (snap.errorText) {
      body.push(
        truncateToWidth(
          theme.fg("error", `error: ${snap.errorText}`),
          width,
          ELLIPSIS,
        ),
      );
    }

    const capacity = Math.max(
      1,
      viewport - body.length - (this.scrollOffset > 0 ? 1 : 0),
    );
    const window = sliceViewport(
      transcript,
      transcript.length - capacity - this.scrollOffset,
      capacity,
    );
    if (window.items.length === 0) {
      body.push(theme.fg("dim", "(no output yet)"));
    } else {
      body.push(...window.items);
    }

    if (window.below > 0) {
      body.push(
        truncateToWidth(
          theme.fg(
            "dim",
            `${ELLIPSIS} ${window.below} lines below · ${configuredKeys(this.keybindings, "tui.editor.pageDown")}`,
          ),
          width,
          ELLIPSIS,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(border);
    lines.push(...this.input.render(width));
    const hintParts = [
      theme.fg("dim", configuredKeys(this.keybindings, "tui.input.submit")) +
        theme.fg("muted", " send"),
      theme.fg("dim", configuredKeys(this.keybindings, "app.interrupt")) +
        theme.fg("muted", " back"),
    ];
    if (snap.status === "running") {
      hintParts.push(
        this.cancelArmed
          ? theme.fg(
              "error",
              `${configuredKeys(this.keybindings, "app.clear")} again to cancel`,
            )
          : theme.fg("dim", configuredKeys(this.keybindings, "app.clear")) +
              theme.fg("muted", " cancel"),
      );
    }
    hintParts.push(
      theme.fg(
        "dim",
        `${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")}`,
      ) + theme.fg("muted", " scroll"),
      theme.fg(
        "dim",
        `${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")}`,
      ) + theme.fg("muted", " page"),
    );
    lines.push(
      truncateToWidth(hintParts.join(theme.fg("dim", " · ")), width, ELLIPSIS),
    );
    lines.push(border);
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
    this.transcriptCache.invalidate();
  }
}
