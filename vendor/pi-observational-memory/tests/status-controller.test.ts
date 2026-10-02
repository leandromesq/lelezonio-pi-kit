import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { fitWorkerParts, StatusController, WORKER_SEP, type StatusUI } from "../src/ui/status-controller.js";

interface FakeTheme {
	fg(color: string, text: string): string;
}

function fakeUI() {
	const status = new Map<string, string | undefined>([["om", "old footer"]]);
	const widgetContent = new Map<string, unknown>();
	let theme: FakeTheme = { fg: (_color, text) => text };
	let renders = 0;
	const fakeTui = { requestRender: () => renders++ };
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: (key, content) => {
			widgetContent.set(key, typeof content === "function" ? content(fakeTui as never, theme) : content);
		},
		get theme() {
			return theme;
		},
	};
	const renderWidget = (key: string, width = 80): string[] => {
		const component = widgetContent.get(key) as { render(width: number): string[] } | undefined;
		return component ? component.render(width) : [];
	};
	return {
		ui,
		footer: () => status.get("om"),
		widgetContent,
		renderWidget,
		renders: () => renders,
		setTheme: (next: FakeTheme) => {
			theme = next;
		},
	};
}

describe("StatusController widget (no footer status)", () => {
	it("clears a prior footer when attached", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBeUndefined();
		sc.detach();
	});

	it("renders a bounded single line and never reintroduces the footer", () => {
		const { ui, footer, renderWidget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		try {
			sc.workerStart("observer", "worker-1");
			const lines = renderWidget("om-workers");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("[observer]");
			expect(footer()).toBeUndefined();
		} finally {
			sc.detach();
		}
	});

	it("collapses overflow into +N within the supplied width", () => {
		const { ui, renderWidget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		try {
			for (let i = 0; i < 8; i++) sc.workerStart("observer", `w${i}`);
			const [line] = renderWidget("om-workers", 40);
			expect(line).toContain("+");
			expect(line).not.toContain("[observer]   [observer]   [observer]   [observer]   [observer]");
		} finally {
			sc.detach();
		}
	});

	it("re-renders with the current theme, leaving no stale ANSI behind", () => {
		const { ui, renderWidget, setTheme } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		try {
			sc.workerStart("observer", "worker-1");
			const before = renderWidget("om-workers")[0]!;
			// The fake theme wraps every token in a marker so a stale theme is visible.
			setTheme({ fg: (color, text) => `<${color}>${text}</>` });
			const after = renderWidget("om-workers")[0]!;
			expect(after).toContain("<accent>");
			expect(after).not.toBe(before);
		} finally {
			sc.detach();
		}
	});

	it("removes the widget once the last worker settles", async () => {
		const { ui, widgetContent } = fakeUI();
		const sc = new StatusController({ settleMs: 5 });
		sc.attach(ui);
		sc.workerStart("observer", "worker-1");
		expect(widgetContent.get("om-workers")).toBeDefined();
		sc.workerDone("worker-1", 1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(widgetContent.get("om-workers")).toBeUndefined();
		sc.detach();
	});

	it("clears the widget and footer on detach", () => {
		const { ui, footer, widgetContent } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.workerStart("consolidator", "c-1");
		expect(widgetContent.get("om-workers")).toBeDefined();
		sc.detach();
		expect(widgetContent.get("om-workers")).toBeUndefined();
		expect(footer()).toBeUndefined();
	});
});

describe("fitWorkerParts", () => {
	it("returns every part when the line fits", () => {
		const parts = ["a", "b", "c"];
		expect(fitWorkerParts(parts, 100, WORKER_SEP)).toBe("a   b   c");
	});

	it("collapses overflow into +N and stays within the width", () => {
		const parts = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];
		const line = fitWorkerParts(parts, 20, WORKER_SEP);
		expect(line).toContain("+");
		expect(line.length).toBeLessThanOrEqual(20);
	});

	it("truncates a single oversized part", () => {
		expect(visibleWidth(fitWorkerParts(["x".repeat(100)], 10))).toBe(10);
	});
});
