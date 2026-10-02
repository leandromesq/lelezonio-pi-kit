import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatElapsed,
  isRemoteAgentActive,
  type RemoteAgentSnapshot,
} from "../domain.ts";
import { viewportRows } from "../../../shared/ui/viewport.ts";
import type { RemoteAgentReadModel } from "../manager.ts";
import { createTranscriptCache, sanitizeText } from "./transcript.ts";

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function glyph(snapshot: RemoteAgentSnapshot, theme: Theme) {
  switch (snapshot.status) {
    case "working":
    case "starting":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "blocked":
    case "unreachable":
    case "unknown":
      return theme.fg("warning", "■");
    case "failed":
      return theme.fg("error", "■");
    case "cancelled":
      return theme.fg("muted", "■");
  }
}

function oneLine(text: string) {
  return sanitizeText(text.replace(/\s+/g, " "));
}

export async function openRemotePicker(
  ctx: ExtensionCommandContext,
  view: RemoteAgentReadModel,
  openSelected: (id: string) => Promise<void>,
) {
  const selection = { index: 0, id: undefined as string | undefined };
  while (true) {
    if (view.list().length === 0) {
      ctx.ui.notify("No remote agents", "info");
      return;
    }
    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new RemoteDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (!picked) return;
    await openSelected(picked);
    return;
  }
}

export async function openRemoteTakeover(
  ctx: ExtensionCommandContext,
  view: RemoteAgentReadModel,
  id: string,
): Promise<boolean> {
  const snap = view.get(id);
  if (!snap) return false;
  // Native remote takeover is deferred: /remotes always uses the in-session
  // overlay (the previous behavior). Remote jobs live on the remote host;
  // there is no local pane surface to take over yet.
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new RemoteTakeover(tui, theme, keybindings, id, view, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
  return false;
}

export class RemoteDashboard implements Component {
  private closed = false;
  /** Id of an active remote job whose cancel is armed (second `x`). */
  private armedCancelId: string | undefined;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly view: RemoteAgentReadModel;
  private readonly selection: { index: number; id?: string };
  private readonly done: (value: string | null) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: RemoteAgentReadModel,
    selection: { index: number; id?: string },
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    this.ticker = setInterval(() => tui.requestRender(), 1_000);
    this.unsubscribe = view.subscribe(() => tui.requestRender());
  }

  private reconcile(jobs: ReadonlyArray<RemoteAgentSnapshot>) {
    const stable = this.selection.id
      ? jobs.findIndex((job) => job.id === this.selection.id)
      : -1;
    this.selection.index =
      stable >= 0
        ? stable
        : Math.min(this.selection.index, Math.max(0, jobs.length - 1));
    this.selection.id = jobs[this.selection.index]?.id;
  }

  private close(value: string | null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
    this.done(value);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
  }

  handleInput(data: string) {
    const jobs = this.view.list();
    this.reconcile(jobs);
    // The destructive `x` is armed by its first press and confirmed by the
    // second; any other key (including close) disarms it.
    const wasArmed = this.armedCancelId;
    if (data !== "x") this.armedCancelId = undefined;
    if (this.keybindings.matches(data, "tui.select.cancel"))
      return this.close(null);
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = jobs[this.selection.index];
      if (selected) this.close(selected.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (jobs.length)
        this.selection.index =
          (this.selection.index - 1 + jobs.length) % jobs.length;
    } else if (
      this.keybindings.matches(data, "tui.select.down") ||
      data === "j"
    ) {
      if (jobs.length)
        this.selection.index = (this.selection.index + 1) % jobs.length;
    } else if (data === "x") {
      const selected = jobs[this.selection.index];
      if (selected && isRemoteAgentActive(selected.status)) {
        if (wasArmed === selected.id) {
          this.view.requestCancel(selected.id);
        } else {
          this.armedCancelId = selected.id;
        }
      }
    } else if (data === "r") {
      const selected = jobs[this.selection.index];
      if (selected) this.view.requestRefresh(selected.id);
    } else if (data === "d") {
      const selected = jobs[this.selection.index];
      if (selected) this.view.requestDelete(selected.id);
    }
    this.selection.id = jobs[this.selection.index]?.id;
    this.tui.requestRender();
  }

  render(width: number) {
    const jobs = this.view.list();
    this.reconcile(jobs);
    const height = viewportRows(this.tui.terminal.rows, 5, 6);
    const lines = [
      truncateToWidth(
        `  ${this.theme.fg("accent", this.theme.bold("Remote agents"))} ${this.theme.fg("dim", `· ${jobs.length} on macmini`)}`,
        width,
        "…",
      ),
    ];
    lines.push(this.theme.fg("border", "─".repeat(width)));
    const start = Math.min(
      Math.max(0, this.selection.index - Math.floor(height / 2)),
      Math.max(0, jobs.length - height),
    );
    const visible = jobs.slice(start, start + height);
    for (let index = 0; index < height; index++) {
      const job = visible[index];
      if (!job) {
        lines.push("");
        continue;
      }
      const selected = start + index === this.selection.index;
      const left = ` ${selected ? this.theme.fg("accent", "❯") : " "} ${glyph(job, this.theme)} ${selected ? this.theme.fg("accent", oneLine(job.title)) : oneLine(job.title)} ${this.theme.fg("dim", job.id)}`;
      const right = this.theme.fg(
        "muted",
        `${job.status} · ${formatElapsed(job)} `,
      );
      const leftWidth = Math.max(1, width - visibleWidth(right) - 2);
      const clipped = truncateToWidth(left, leftWidth, "…");
      lines.push(
        truncateToWidth(
          clipped +
            " ".repeat(
              Math.max(1, width - visibleWidth(clipped) - visibleWidth(right)),
            ) +
            right,
          width,
          "…",
        ),
      );
    }
    lines.push(this.theme.fg("border", "─".repeat(width)));
    lines.push(
      truncateToWidth(
        [
          this.theme.fg(
            "dim",
            configuredKeys(this.keybindings, "tui.select.confirm"),
          ) + this.theme.fg("muted", " open Herdr"),
          this.armedCancelId !== undefined
            ? this.theme.fg("error", "x again to cancel")
            : this.theme.fg("dim", "x") + this.theme.fg("muted", " cancel"),
          this.theme.fg("dim", "d") + this.theme.fg("muted", " delete"),
          this.theme.fg("dim", "r") + this.theme.fg("muted", " refresh"),
          this.theme.fg(
            "dim",
            configuredKeys(this.keybindings, "tui.select.cancel"),
          ) + this.theme.fg("muted", " close"),
        ].join(this.theme.fg("dim", " · ")),
        width,
        "…",
      ),
    );
    return lines;
  }

  invalidate() {}
}

const SCROLL_STEP = 6;

export class RemoteTakeover implements Component, Focusable {
  private readonly input = new Input();
  private scrollOffset = 0;
  private closed = false;
  /** True while `app.clear` is armed and awaiting a second press to cancel. */
  private cancelArmed = false;
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private readonly transcriptCache = createTranscriptCache();
  private _focused = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly id: string;
  private readonly view: RemoteAgentReadModel;
  private readonly done: (value: null) => void;

  get focused() {
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
    view: RemoteAgentReadModel,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    this.ticker = setInterval(() => tui.requestRender(), 1_000);
    this.refreshTimer = setInterval(() => view.requestRefresh(id), 2_000);
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      view.requestSend(id, text);
      this.scrollOffset = 0;
      tui.requestRender();
    };
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // The 2s poll and the transcript subscription can fire per chunk. Limit
    // terminal repaints so this view cannot starve input handling.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.unsubscribe();
    this.done(null);
  }

  dispose() {
    if (!this.closed) this.close();
  }

  handleInput(data: string) {
    const clearPressed = this.keybindings.matches(data, "app.clear");
    const wasArmed = this.cancelArmed;
    if (!clearPressed) this.cancelArmed = false;
    // `app.clear` (ctrl+c by default) arms the cancel on the first press and
    // confirms it on the second; it is checked before the generic overlay
    // cancel because ctrl+c matches both under the default keymap. Closing
    // (escape) must never cancel the remote job.
    if (clearPressed) {
      const job = this.view.get(this.id);
      if (job && isRemoteAgentActive(job.status)) {
        if (wasArmed) {
          this.cancelArmed = false;
          this.view.requestCancel(this.id);
        } else {
          this.cancelArmed = true;
        }
      } else {
        this.close();
        return;
      }
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    )
      return this.close();
    if (this.keybindings.matches(data, "tui.editor.cursorUp"))
      this.scrollOffset += SCROLL_STEP;
    else if (this.keybindings.matches(data, "tui.editor.cursorDown"))
      this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
    else if (this.keybindings.matches(data, "tui.editor.pageUp"))
      this.scrollOffset += this.viewportHeight();
    else if (this.keybindings.matches(data, "tui.editor.pageDown"))
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight() {
    return viewportRows(this.tui.terminal.rows, 9, 6);
  }

  render(width: number) {
    const job = this.view.get(this.id);
    const border = this.theme.fg("borderAccent", "─".repeat(width));
    if (!job)
      return [
        border,
        this.theme.fg("error", `${this.id} is not tracked`),
        border,
      ];
    const lines = [border];
    lines.push(
      truncateToWidth(
        `${glyph(job, this.theme)} ${this.theme.fg("accent", this.theme.bold(`${job.id} · ${oneLine(job.title)}`))}${this.theme.fg("muted", ` · ${job.status} · ${formatElapsed(job)}`)}`,
        width,
        "…",
      ),
    );
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          `${job.host}:${job.remoteCwd}${job.workspaceId ? ` · ${job.workspaceId}` : ""}`,
        ),
        width,
        "…",
      ),
    );
    lines.push(border);
    const transcript = this.transcriptCache.get(
      job.transcript,
      job.transcriptVersion,
      width,
      this.theme,
    );
    const viewport = this.viewportHeight();
    const reserved = job.errorText ? 1 : 0;
    const capacity = Math.max(
      1,
      viewport - reserved - (this.scrollOffset > 0 ? 1 : 0),
    );
    this.scrollOffset = Math.min(
      this.scrollOffset,
      Math.max(0, transcript.length - capacity),
    );
    const end = transcript.length - this.scrollOffset;
    const body = job.errorText
      ? [
          truncateToWidth(
            this.theme.fg("error", `error: ${oneLine(job.errorText)}`),
            width,
            "…",
          ),
        ]
      : [];
    const visible = transcript.slice(Math.max(0, end - capacity), end);
    body.push(
      ...(visible.length
        ? visible
        : [this.theme.fg("dim", "(no remote output yet)")]),
    );
    if (this.scrollOffset > 0)
      body.push(this.theme.fg("dim", `… ${this.scrollOffset} lines below`));
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport), border, ...this.input.render(width));
    const hintParts = [
      this.theme.fg(
        "dim",
        configuredKeys(this.keybindings, "tui.input.submit"),
      ) + this.theme.fg("muted", " send"),
      this.theme.fg("dim", configuredKeys(this.keybindings, "app.interrupt")) +
        this.theme.fg("muted", " back"),
    ];
    if (isRemoteAgentActive(job.status)) {
      hintParts.push(
        this.cancelArmed
          ? this.theme.fg(
              "error",
              `${configuredKeys(this.keybindings, "app.clear")} again to cancel`,
            )
          : this.theme.fg(
              "dim",
              configuredKeys(this.keybindings, "app.clear"),
            ) + this.theme.fg("muted", " cancel"),
      );
    }
    hintParts.push(
      this.theme.fg(
        "dim",
        `${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")}`,
      ) + this.theme.fg("muted", " scroll"),
    );
    lines.push(
      truncateToWidth(hintParts.join(this.theme.fg("dim", " · ")), width, "…"),
    );
    lines.push(border);
    return lines;
  }

  invalidate() {
    this.transcriptCache.invalidate();
    this.input.invalidate();
  }
}
