import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function zedExtension(pi: ExtensionAPI) {
  pi.registerCommand("zed", {
    description: "Open the current directory in Zed",
    handler: async (_args, ctx) => {
      try {
        const result = await pi.exec("zed", [ctx.cwd], {
          cwd: ctx.cwd,
          signal: ctx.signal,
        });

        if (result.code !== 0) {
          ctx.ui.notify(
            result.stderr.trim() || `Zed exited with code ${result.code}`,
            "error",
          );
          return;
        }

        ctx.ui.notify(`Opened ${ctx.cwd} in Zed`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Could not open Zed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
