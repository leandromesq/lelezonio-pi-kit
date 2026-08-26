import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodexAccountStore, validateAccountName } from "./src/account-store.ts";

const COMMAND_NAME = "codex";

export type CodexCommand =
  { action: "select" } | { action: "save"; name: string };

export function parseCodexCommand(args: string): CodexCommand {
  const input = args.trim();
  if (!input) return { action: "select" };

  const [action, ...rest] = input.split(/\s+/);
  if (action !== "save" || rest.length !== 1) {
    throw new Error(`Usage: /${COMMAND_NAME} or /${COMMAND_NAME} save <name>`);
  }

  return { action: "save", name: validateAccountName(rest[0] ?? "") };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function codexAccounts(pi: ExtensionAPI) {
  const store = new CodexAccountStore();

  pi.registerCommand(COMMAND_NAME, {
    description: "Save or switch Codex CLI accounts: /codex save <name>",
    getArgumentCompletions: (prefix) => {
      const item = {
        value: "save ",
        label: "save <name>",
        description: "Save the currently authenticated Codex account",
      };
      return "save ".startsWith(prefix) ? [item] : null;
    },
    handler: async (args, ctx) => {
      let command: CodexCommand;
      try {
        command = parseCodexCommand(args);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "warning");
        return;
      }

      try {
        if (command.action === "save") {
          // Saving the same Codex identity under a second name (e.g. after a
          // re-login that returned the same account) creates two files that
          // both match "current" and confuse switching. Offer an explanation
          // and a confirmation before duplicating.
          const sameIdentityName = await store.findCurrentIdentityName(
            command.name,
          );
          if (sameIdentityName !== undefined) {
            const message = `Current Codex credentials are already saved as "${sameIdentityName}" (same account id). They are the same identity — saving "${command.name}" only duplicates it.`;
            if (!ctx.hasUI) {
              ctx.ui.notify(message, "warning");
              return;
            }
            const duplicateAnyway = await ctx.ui.confirm(
              "Duplicate Codex identity",
              `${message} Save it anyway under "${command.name}"?`,
            );
            if (!duplicateAnyway) return;
          }

          const exists = await store.hasAccount(command.name);
          if (exists) {
            if (!ctx.hasUI) {
              ctx.ui.notify(
                `Codex account "${command.name}" already exists; interactive confirmation is required to overwrite it.`,
                "warning",
              );
              return;
            }

            const overwrite = await ctx.ui.confirm(
              "Overwrite Codex account?",
              `Replace the saved credentials for "${command.name}" with the current Codex credentials?`,
            );
            if (!overwrite) return;
          }

          await store.save(command.name, { overwrite: exists });
          ctx.ui.notify(`Saved Codex account "${command.name}"`, "info");
          return;
        }

        const accounts = await store.list();
        if (accounts.length === 0) {
          ctx.ui.notify(
            `No saved Codex accounts. Use /${COMMAND_NAME} save <name> first.`,
            "warning",
          );
          return;
        }

        if (!ctx.hasUI) {
          const names = accounts
            .map((account) =>
              account.active ? `${account.name} (current)` : account.name,
            )
            .join(", ");
          ctx.ui.notify(`Saved Codex accounts: ${names}`, "info");
          return;
        }

        const labels = accounts.map((account) =>
          account.active ? `${account.name} (current)` : account.name,
        );
        const selected = await ctx.ui.select("Codex account", labels);
        if (!selected) return;

        const account = accounts[labels.indexOf(selected)];
        if (!account || account.active) return;

        await store.switchTo(account.name);
        ctx.ui.notify(
          `Switched Codex CLI to "${account.name}". New Codex processes will use this account.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}
