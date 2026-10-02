import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { buildOmStatusModel, StatusOverlay, type OmStatusTheme } from "../ui/status-overlay.js";

/** Identity theme for the non-TUI (RPC) plain-text fallback. */
const PLAIN_THEME: OmStatusTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (workers, buffer, clocks)",
		handler: async (_args: string, ctx: any) => {
			if (!runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);

			// Interactive TUI: a bordered, scrollable overlay with live data.
			if (ctx.mode === "tui") {
				await ctx.ui.custom(
					(tui: any, theme: OmStatusTheme, keybindings: any, done: () => void) => {
						const maxRows = Math.max(3, Math.floor((tui.terminal.rows || 30) * 0.85) - 4);
						return new StatusOverlay({
							build: (currentTheme, width) => buildOmStatusModel(runtime, ctx, currentTheme, width),
							themeAt: () => ctx.ui.theme ?? theme,
							maxRows,
							done,
							requestRender: () => tui.requestRender(),
							keybindings,
						});
					},
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
					},
				);
				return;
			}

			// RPC (and any other dialog-capable client): a plain read-only report.
			if (!ctx.hasUI) return;
			const model = buildOmStatusModel(runtime, ctx, PLAIN_THEME, 60);
			ctx.ui.notify([`om status · ${model.subtitle}`, ...model.lines].join("\n"), "info");
		},
	});
}
