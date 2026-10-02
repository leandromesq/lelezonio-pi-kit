import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { Runtime } from "../src/runtime.js";
import { buildOmStatusModel, StatusOverlay, type OmStatusTheme } from "../src/ui/status-overlay.js";

const identity: OmStatusTheme = { fg: (_color, text) => text, bold: (text) => text };

const keybindings = {
	matches: (data: string, binding: string) => (binding === "tui.select.down" ? data === "DOWN" : false),
	getKeys: (binding: string) => (binding === "tui.select.cancel" ? ["esc"] : ["up"]),
};

function makeOverlay(
	input: {
		lines?: string[];
		maxRows?: number;
		themeAt?: () => OmStatusTheme;
		done?: () => void;
		requestRender?: () => void;
	} = {},
): StatusOverlay {
	const lines = input.lines ?? ["line-0", "line-1", "line-2", "line-3"];
	return new StatusOverlay({
		build: (_theme, _width) => ({ lines, subtitle: "test" }),
		themeAt: input.themeAt ?? (() => identity),
		maxRows: input.maxRows ?? 5,
		done: input.done ?? (() => {}),
		requestRender: input.requestRender ?? (() => {}),
		keybindings: keybindings as never,
	});
}

function makeRuntime(root: string): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.memoryRoot = root;
	return runtime;
}

function makeCtx(root: string) {
	return {
		hasUI: true,
		mode: "tui",
		cwd: root,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		getContextUsage: () => ({ tokens: 1234 }),
	};
}

describe("buildOmStatusModel", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-status-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reports the OM worker cost, not the whole-session bill", () => {
		const runtime = makeRuntime(join(cwd, ".memory", "s"));
		const model = buildOmStatusModel(runtime, makeCtx(cwd), identity, 80);
		expect(model.subtitle).toContain("OM worker estimate");
		expect(model.subtitle).toContain("0 runs");
		expect(model.lines.join("\n")).toContain("observers in flight");
	});

	it("renders an off notice when the gate is disabled", () => {
		const runtime = new Runtime();
		runtime.enabled = false;
		const model = buildOmStatusModel(runtime, makeCtx(cwd), identity, 80);
		expect(model.lines.join("\n")).toContain("om is off");
	});
});

describe("StatusOverlay", () => {
	it("keeps every rendered line within the requested width", () => {
		const overlay = makeOverlay();
		for (const width of [20, 40, 80]) {
			for (const line of overlay.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("is bordered and shows a title, subtitle, and close hint", () => {
		const lines = makeOverlay().render(60);
		expect(lines[0]).toContain("─");
		expect(lines[0]).not.toContain("│");
		expect(lines[1]).toContain("om status");
		expect(lines.at(-2)).toContain("esc close");
		expect(lines.at(-1)).toContain("─");
	});

	it("scrolls a viewport that is taller than the content band and clamps at the end", () => {
		let renders = 0;
		const overlay = makeOverlay({
			lines: Array.from({ length: 10 }, (_v, i) => `line-${i}`),
			maxRows: 3,
			requestRender: () => renders++,
		});
		expect(overlay.render(60)[1]).toContain("3/10");
		overlay.handleInput("DOWN");
		expect(renders).toBe(1);
		expect(overlay.render(60)[1]).toContain("4/10");
		for (let i = 0; i < 50; i++) overlay.handleInput("DOWN");
		expect(overlay.render(60)[1]).toContain("10/10");
	});

	it("closes on escape", () => {
		let doneCalls = 0;
		makeOverlay({ done: () => doneCalls++ }).handleInput("\u001b");
		expect(doneCalls).toBe(1);
	});

	it("resolves the theme per render (no stale ANSI)", () => {
		let theme: OmStatusTheme = identity;
		const overlay = makeOverlay({ lines: [], themeAt: () => theme });
		const live = new StatusOverlay({
			build: (t, _width) => ({ lines: [t.fg("accent", "x")], subtitle: "s" }),
			themeAt: () => theme,
			maxRows: 3,
			done: () => {},
			requestRender: () => {},
			keybindings: keybindings as never,
		});
		expect(overlay).toBeDefined();
		expect(live.render(20).join("\n")).not.toContain("<accent>");
		theme = { fg: (color, text) => `<${color}>${text}</>`, bold: (text) => text };
		expect(live.render(20).join("\n")).toContain("<accent>");
	});
});
