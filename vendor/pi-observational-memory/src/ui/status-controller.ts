/**
 * TUI observability for observational memory, driven entirely by the in-process orchestrator
 * (subprocess workers are headless). The footer remains free; details live in /om:status.
 *
 *   - Single "om-workers" widget: all active/settling workers rendered side-by-side on one
 *     bounded line so parallel observers appear next to each other, not stacked vertically.
 *       ◐ [observer]   ◐ [observer]   ✓ [observer] +4
 *   - The widget is a component factory: it re-renders with the CURRENT theme (no stale ANSI
 *     cached from an earlier theme) and clamps to the available width, collapsing overflow into
 *     a trailing "+N".
 *   - Toasts via notify (start/finish/error), gated on hasUI by the caller.
 */
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export type WorkerType = "observer" | "consolidator";

interface Theme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

export interface StatusUI {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: string[] | undefined | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }),
	): void;
	readonly theme: Theme;
}

type WorkerState = { kind: "running" } | { kind: "done"; delta?: number } | { kind: "error" };

const FOOTER_KEY = "om";
const WORKERS_WIDGET_KEY = "om-workers";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
/** Separator between worker indicators on the single combined line. */
export const WORKER_SEP = "   ";

export interface StatusControllerOptions {
	spinnerIntervalMs?: number;
	settleMs?: number;
}

interface WorkerEntry {
	type: WorkerType;
	state: WorkerState;
	settleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Fit as many worker indicator parts as possible on one line, collapsing the remainder into a
 * trailing "+N". Width is measured with `visibleWidth` (never `.length`) so wide glyphs are
 * accounted for. Falls back to a truncated first indicator when even one part cannot fit.
 */
export function fitWorkerParts(parts: string[], width: number, sep = WORKER_SEP): string {
	if (parts.length === 0) return "";
	const cap = Math.max(1, width);
	const full = parts.join(sep);
	if (visibleWidth(full) <= cap) return full;
	for (let shown = parts.length - 1; shown >= 1; shown--) {
		const candidate = `${parts.slice(0, shown).join(sep)}${sep}+${parts.length - shown}`;
		if (visibleWidth(candidate) <= cap) return candidate;
	}
	return truncateToWidth(parts[0]!, cap, "…");
}

/**
 * Reads live controller state on every render, so worker add/settle/remove is reflected without
 * remounting the widget factory, and the theme is resolved at render time.
 */
class WorkersWidget implements Component {
	constructor(
		private readonly controller: StatusController,
		private readonly fallbackTheme: Theme,
	) {}

	render(width: number): string[] {
		const parts = this.controller.workerParts(this.controller.themeNow(this.fallbackTheme));
		if (parts.length === 0) return [];
		return [fitWorkerParts(parts, width)];
	}

	invalidate(): void {}
}

export class StatusController {
	private ui: StatusUI | undefined;
	private frame = 0;
	private readonly workers = new Map<string, WorkerEntry>();
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;
	private requestRender: (() => void) | undefined;
	private widgetMounted = false;
	private readonly spinnerIntervalMs: number;
	private readonly settleMs: number;

	constructor(options: StatusControllerOptions = {}) {
		this.spinnerIntervalMs = options.spinnerIntervalMs ?? 120;
		this.settleMs = options.settleMs ?? 5000;
	}

	attach(ui: StatusUI): void {
		this.ui = ui;
		// A fresh UI may have dropped the previous widget; remount from current worker state.
		this.widgetMounted = false;
		this.requestRender = undefined;
		// Clear a prior version's footer without adding a replacement status line.
		this.ui.setStatus(FOOTER_KEY, undefined);
		this.syncWidget();
	}

	detach(): void {
		this.stopSpinner();
		for (const entry of this.workers.values()) {
			if (entry.settleTimer) clearTimeout(entry.settleTimer);
		}
		this.workers.clear();
		this.requestRender = undefined;
		this.widgetMounted = false;
		if (this.ui) {
			this.ui.setWidget(WORKERS_WIDGET_KEY, undefined);
			this.ui.setStatus(FOOTER_KEY, undefined);
		}
		this.ui = undefined;
	}

	/** Live theme: prefer the attached UI's current theme (survives a theme switch), else fallback. */
	themeNow(fallback: Theme): Theme {
		return this.ui?.theme ?? fallback;
	}

	workerStart(type: WorkerType, runId: string): void {
		if (!this.ui) return;
		const existing = this.workers.get(runId);
		if (existing?.settleTimer) clearTimeout(existing.settleTimer);
		this.workers.set(runId, { type, state: { kind: "running" } });
		this.startSpinner();
		this.syncWidget();
	}

	workerDone(runId: string, delta?: number): void {
		this.settle(runId, { kind: "done", delta });
	}

	workerError(runId: string): void {
		this.settle(runId, { kind: "error" });
	}

	/** Build the per-worker indicator strings for the current frame (caller supplies the theme). */
	workerParts(theme: Theme): string[] {
		const parts: string[] = [];
		for (const entry of this.workers.values()) {
			if (entry.state.kind === "running") {
				parts.push(`${theme.fg("accent", SPINNER_FRAMES[this.frame])} ${theme.fg("accent", `[${entry.type}]`)}`);
			} else if (entry.state.kind === "error") {
				parts.push(`${theme.fg("error", "✗")} ${theme.fg("muted", `[${entry.type}]`)}`);
			} else {
				const delta =
					entry.state.delta && entry.state.delta > 0 ? ` ${theme.fg("success", `+${entry.state.delta}`)}` : "";
				parts.push(`${theme.fg("success", "✓")} ${theme.fg("muted", `[${entry.type}]`)}${delta}`);
			}
		}
		return parts;
	}

	private settle(runId: string, state: WorkerState): void {
		if (!this.ui) return;
		const entry = this.workers.get(runId);
		if (!entry) return;
		if (entry.settleTimer) clearTimeout(entry.settleTimer);
		entry.state = state;
		this.syncWidget();
		entry.settleTimer = setTimeout(() => {
			this.workers.delete(runId);
			this.syncWidget();
			if (!this.hasRunningWorker()) this.stopSpinner();
		}, this.settleMs);
		entry.settleTimer.unref?.();
		if (!this.hasRunningWorker()) this.stopSpinner();
	}

	private hasRunningWorker(): boolean {
		for (const entry of this.workers.values()) {
			if (entry.state.kind === "running") return true;
		}
		return false;
	}

	private startSpinner(): void {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			// One re-render of the combined widget per tick covers all running workers.
			if (this.hasRunningWorker()) this.requestRender?.();
		}, this.spinnerIntervalMs);
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (!this.spinnerTimer) return;
		clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	/**
	 * Mount the widget factory once, then drive it with `requestRender()`. The component reads live
	 * controller state, so adding/removing/settling a worker no longer churns `setWidget` (which
	 * would recreate the component) on every change. Cleared when the last worker leaves.
	 */
	private syncWidget(): void {
		const ui = this.ui;
		if (!ui) return;
		if (this.workers.size === 0) {
			if (this.widgetMounted) {
				ui.setWidget(WORKERS_WIDGET_KEY, undefined);
				this.widgetMounted = false;
				this.requestRender = undefined;
			}
			return;
		}
		if (!this.widgetMounted) {
			ui.setWidget(WORKERS_WIDGET_KEY, (tui, theme) => {
				this.requestRender = () => tui.requestRender();
				return new WorkersWidget(this, theme);
			});
			this.widgetMounted = true;
		}
		this.requestRender?.();
	}
}
