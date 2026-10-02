/**
 * Responsive `/om:status` overlay.
 *
 * The plain-text report used to be dumped through `ui.notify` (16 lines at a fixed 60-col
 * timeline), which clipped on narrow terminals. This renders the same data as a bordered,
 * scrollable overlay via `ctx.ui.custom`: live values are read on demand (not on the hot path),
 * the timeline uses the real overlay width, and the theme is resolved per render so a theme
 * switch never leaves stale ANSI behind.
 *
 * Non-TUI clients (RPC) still get a plain read-only notify via the caller.
 */
import { Key, matchesKey, truncateToWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import {
	foldLedger,
	poolTokens,
	rawTokensSinceCommittedCoverage,
	sumSessionCost,
	type Entry,
} from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { estimateStringTokens } from "../tokens.js";
import { renderTimeline } from "./timeline.js";

export interface OmStatusTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface OmStatusModel {
	/** Themed content lines (no title, hint, or border; the component adds those). */
	lines: string[];
	/** Short status shown next to the title. */
	subtitle: string;
}

/** Build the report content for one render. Reads the live runtime/branch, so it is on-demand. */
export function buildOmStatusModel(runtime: Runtime, ctx: any, theme: OmStatusTheme, width: number): OmStatusModel {
	if (!runtime.enabled) {
		return { lines: [theme.fg("dim", "om is off (use /om on to enable)")], subtitle: "" };
	}
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const folded = foldLedger(branch);
	const sinceObservation = rawTokensSinceCommittedCoverage(branch);
	const contextTokens = ctx.getContextUsage?.()?.tokens ?? null;
	const pool = poolTokens(folded.activeObservations);
	const topicCount = listTopics(runtime.memoryRoot).length;
	const journey = readJourney(runtime.memoryRoot);
	const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);

	const row = (label: string, value: string) => `${theme.fg("muted", label)}${theme.fg("text", value)}`;
	const timelineWidth = Math.max(20, width - 2);
	const timeline = renderTimeline(branch, runtime.config, timelineWidth)
		.split("\n")
		.map((line) => theme.fg("text", line));

	const lines = [
		row("observers in flight: ", `${runtime.pendingObservers.size} / ${runtime.config.observerConcurrency}`),
		row("active observations: ", `${folded.activeObservations.length}`),
		row("next observer: ", `${sinceObservation.toLocaleString()} / ${runtime.config.chunkTokens.toLocaleString()} tok`),
		row(
			"pool: ",
			`${pool.toLocaleString()} tok (target ${runtime.config.poolTargetTokens.toLocaleString()}, consolidate at ${runtime.config.consolidateAtPoolTokens.toLocaleString()})`,
		),
		row("consolidator: ", runtime.consolidatorInFlight ? "running" : "idle"),
		row("last compaction wait: ", runtime.lastCompactionObserverWait ?? "n/a"),
		row("topic files: ", `${topicCount}`),
		row(
			"journey: ",
			journey
				? `~${estimateStringTokens(journey).toLocaleString()} / ${runtime.config.journeyTargetTokens.toLocaleString()} tok`
				: "none yet",
		),
		row(
			"proactive compaction: ",
			runtime.config.compactAtContextTokens > 0
				? `at ${runtime.config.compactAtContextTokens.toLocaleString()} tok`
				: "disabled (Pi pressure compaction)",
		),
		row(
			"worker bounds: ",
			`${runtime.config.maxTurns > 0 ? `${runtime.config.maxTurns} turns` : "no turn cap"}, ${runtime.config.timeoutMs > 0 ? `${Math.round(runtime.config.timeoutMs / 1000)}s` : "no timeout"}`,
		),
		row("context: ", contextTokens != null ? `${contextTokens.toLocaleString()} tok` : "?"),
		runtime.lastWorkerError
			? `${theme.fg("muted", "last error: ")}${theme.fg("error", runtime.lastWorkerError)}`
			: row("last error: ", "none"),
		"",
		...timeline,
	];

	return {
		lines,
		// The honest OM-worker spend (sum of om2.cost entries), not the whole-session bill.
		subtitle: `OM worker estimate $${costUsd.toFixed(4)} · ${runs} run${runs === 1 ? "" : "s"}`,
	};
}

export interface StatusOverlayOptions {
	build: (theme: OmStatusTheme, width: number) => OmStatusModel;
	/** Resolved per render so a theme switch is reflected immediately. */
	themeAt: () => OmStatusTheme;
	maxRows: number;
	done: () => void;
	requestRender: () => void;
	keybindings: KeybindingsManager;
}

/** Bordered, scrollable report overlay. Height is fixed per open (content is snapshotted live). */
export class StatusOverlay implements Component {
	private offset = 0;

	constructor(private readonly options: StatusOverlayOptions) {}

	render(width: number): string[] {
		const theme = this.options.themeAt();
		const rule = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		const contentWidth = Math.max(10, width - 2);
		const model = this.options.build(theme, contentWidth);
		const rows = Math.max(1, Math.min(model.lines.length, this.options.maxRows));
		const maxOffset = Math.max(0, model.lines.length - rows);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
		const window = model.lines.slice(this.offset, this.offset + rows);
		while (window.length < rows) window.push("");
		const scrollInfo = model.lines.length > rows ? ` · ${this.offset + rows}/${model.lines.length}` : "";
		return [
			rule,
			truncateToWidth(
				` ${theme.fg("accent", theme.bold("om status"))}${theme.fg("dim", ` · ${model.subtitle}${scrollInfo}`)}`,
				width,
				"…",
			),
			...window.map((line) => truncateToWidth(` ${line}`, width, "…")),
			truncateToWidth(` ${theme.fg("dim", this.hint())}`, width, "…"),
			rule,
		];
	}

	handleInput(data: string): void {
		const { keybindings, done, requestRender } = this.options;
		if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel") || data === "q") {
			done();
			return;
		}
		const page = Math.max(1, this.options.maxRows - 1);
		if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) this.offset -= 1;
		else if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) this.offset += 1;
		else if (matchesKey(data, Key.pageUp) || keybindings.matches(data, "tui.select.pageUp")) this.offset -= page;
		else if (matchesKey(data, Key.pageDown) || keybindings.matches(data, "tui.select.pageDown")) this.offset += page;
		else if (matchesKey(data, Key.home)) this.offset = 0;
		else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
		requestRender();
	}

	invalidate(): void {}

	private hint(): string {
		const { keybindings } = this.options;
		const close = keybindings.getKeys("tui.select.cancel").join("/") || "esc";
		const up = keybindings.getKeys("tui.select.up").join("/") || "up";
		const down = keybindings.getKeys("tui.select.down").join("/") || "down";
		return `${up}/${down} scroll · ${close} close`;
	}
}
