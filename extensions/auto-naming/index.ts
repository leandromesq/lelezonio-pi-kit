import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadNamingConfig, saveNamingConfig } from "./src/config.ts";
import { generateTaskTitle } from "./src/title-generator.ts";
import { openModelPicker, openReasoningPicker } from "./src/ui.ts";

function hasUserMessage(ctx: ExtensionContext) {
  return ctx.sessionManager
    .getEntries()
    .some((entry) => entry.type === "message" && entry.message.role === "user");
}

export default function (pi: ExtensionAPI) {
  let sessionActive = true;
  let namingStarted = false;

  pi.on("session_start", () => {
    sessionActive = true;
    namingStarted = false;
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    namingStarted = true;
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Print/JSON child sessions either have no useful selector or already
    // receive an explicit name from their owning integration.
    if (ctx.mode === "print" || ctx.mode === "json") return;

    const existingName =
      pi.getSessionName() ?? ctx.sessionManager.getSessionName();
    if (namingStarted || existingName || hasUserMessage(ctx)) return;
    namingStarted = true;

    const config = loadNamingConfig();
    if (!config.enabled) return;

    void generateTaskTitle({
      modelRegistry: ctx.modelRegistry,
      config,
      prompt: event.prompt,
      signal: ctx.signal,
    }).then((title) => {
      if (!sessionActive || pi.getSessionName()) return;
      try {
        pi.setSessionName(title);
      } catch {
        // Session replacement or shutdown can race the best-effort title call.
      }
    });
  });

  pi.registerCommand("title-model", {
    description: "Choose the model and reasoning level used for auto-naming",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Title model selection is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const current = loadNamingConfig();
      const model = await openModelPicker(ctx);
      if (!model) return;

      const reasoning = await openReasoningPicker(
        ctx,
        model,
        current.reasoning,
      );
      if (!reasoning) return;

      const config = {
        ...current,
        provider: model.provider,
        model: model.id,
        reasoning,
      };
      try {
        await saveNamingConfig(config);
      } catch {
        ctx.ui.notify(
          "Could not save the private title model config.",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Title model: ${config.provider}/${config.model} · ${config.reasoning}`,
        "info",
      );
    },
  });

  pi.registerCommand("title-naming", {
    description: "Enable or disable automatic task naming",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value !== "on" && value !== "off") {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /title-naming on|off", "error");
        }
        return;
      }

      const config = { ...loadNamingConfig(), enabled: value === "on" };
      try {
        await saveNamingConfig(config);
      } catch {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Could not save the private title naming config.",
            "error",
          );
        }
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Automatic task naming ${config.enabled ? "enabled" : "disabled"}.`,
          "info",
        );
      }
    },
  });
}
