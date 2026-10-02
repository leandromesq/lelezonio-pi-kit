import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CodexAccountStore,
  SUPPORTED_PROVIDERS,
  providerLabel,
  validateAccountName,
  type CodexAccount,
} from "./src/account-store.ts";

const COMMAND_NAME = "codex";
const REMOVE_LABEL = "— remove account…";

export type CodexCommand =
  | { action: "select" }
  | { action: "save"; name: string }
  | { action: "remove"; name: string };

export function parseCodexCommand(args: string): CodexCommand {
  const input = args.trim();
  if (!input) return { action: "select" };

  const [action, ...rest] = input.split(/\s+/);
  if ((action !== "save" && action !== "remove") || rest.length !== 1) {
    throw new Error(
      `Usage: /${COMMAND_NAME}, /${COMMAND_NAME} save <name> or /${COMMAND_NAME} remove <name>`,
    );
  }

  const name = validateAccountName(rest[0] ?? "");
  return action === "save"
    ? { action: "save", name }
    : { action: "remove", name };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** `/login` provider hints for every provider `/codex` understands. */
function loginHint() {
  return SUPPORTED_PROVIDERS.map(providerLabel).join(" or ");
}

/**
 * Label for the account picker. Provider tags only appear when accounts span
 * more than one provider, so legacy `openai-codex`-only users see the same
 * labels as before.
 */
function accountLabel(account: CodexAccount, showProvider: boolean) {
  const name = account.active ? `${account.name} (current)` : account.name;
  return showProvider ? `${name} · ${providerLabel(account.provider)}` : name;
}

function accountLabels(accounts: CodexAccount[]) {
  const showProvider =
    new Set(accounts.map((account) => account.provider)).size > 1;
  return accounts.map((account) => accountLabel(account, showProvider));
}

export default function codexAccounts(pi: ExtensionAPI) {
  const store = new CodexAccountStore();

  pi.registerCommand(COMMAND_NAME, {
    description:
      "Save, switch or remove Pi's OpenAI ChatGPT accounts: /codex, /codex save <name>, /codex remove <name>",
    getArgumentCompletions: async (prefix) => {
      const actionMatches = [
        {
          value: "save ",
          label: "save <name>",
          description:
            "Save the currently logged-in OpenAI (ChatGPT) or OpenAI Codex account",
        },
        {
          value: "remove ",
          label: "remove <name>",
          description: "Delete a saved OpenAI account",
        },
      ].filter((item) => item.value.startsWith(prefix));

      if (prefix.startsWith("remove")) {
        const names = (await store.list()).map((account) => account.name);
        return [
          ...actionMatches,
          ...names
            .filter((name) => `remove ${name}`.startsWith(prefix))
            .map((name) => ({
              value: `remove ${name}`,
              label: `remove ${name}`,
              description: `Delete saved account "${name}"`,
            })),
        ];
      }
      return actionMatches.length > 0 ? actionMatches : null;
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
        if (command.action === "remove") {
          if (!(await store.hasAccount(command.name))) {
            ctx.ui.notify(
              `No saved Codex account "${command.name}".`,
              "warning",
            );
            return;
          }
          if (ctx.hasUI) {
            const confirmRemove = await ctx.ui.confirm(
              "Remove Codex account?",
              `Delete the saved account "${command.name}"? Pi's current login stays untouched.`,
            );
            if (!confirmRemove) return;
          }
          await store.remove(command.name);
          ctx.ui.notify(`Removed Codex account "${command.name}"`, "info");
          return;
        }

        if (command.action === "save") {
          if (!(await store.hasCurrentCredentials())) {
            ctx.ui.notify(
              `Pi has no OpenAI credentials yet. Run /login (provider: ${loginHint()}) first, then /${COMMAND_NAME} save <name>.`,
              "warning",
            );
            return;
          }

          // Saving the same Pi identity under a second name (e.g. after a
          // re-login that returned the same account) creates two files that
          // both match "current" and confuse switching. Offer an explanation
          // and a confirmation before duplicating.
          const sameIdentityName = await store.findCurrentIdentityName(
            command.name,
          );
          if (sameIdentityName !== undefined) {
            const message = `The current OpenAI account is already saved as "${sameIdentityName}" (same account id). They are the same identity — saving "${command.name}" only duplicates it.`;
            if (!ctx.hasUI) {
              ctx.ui.notify(message, "warning");
              return;
            }
            const duplicateAnyway = await ctx.ui.confirm(
              "Duplicate OpenAI identity",
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
              `Replace the saved credentials for "${command.name}" with Pi's current OpenAI credentials?`,
            );
            if (!overwrite) return;
          }

          const providers = await store.currentProviders();
          const provider = await store.save(command.name, {
            overwrite: exists,
          });
          const otherProviders = providers.filter(
            (candidate) => candidate !== provider,
          );
          ctx.ui.notify(
            otherProviders.length > 0
              ? `Saved ${providerLabel(provider)} account "${command.name}". ${otherProviders
                  .map(providerLabel)
                  .join(
                    " and ",
                  )} is also logged in but is not part of this snapshot.`
              : `Saved ${providerLabel(provider)} account "${command.name}"`,
            "info",
          );
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

        const labels = accountLabels(accounts);

        if (!ctx.hasUI) {
          ctx.ui.notify(`Saved Codex accounts: ${labels.join(", ")}`, "info");
          return;
        }

        const selected = await ctx.ui.select("Codex account", [
          ...labels,
          REMOVE_LABEL,
        ]);
        if (!selected) return;

        if (selected === REMOVE_LABEL) {
          const chosen = await ctx.ui.select("Remove account", labels);
          if (!chosen) return;

          const target = accounts[labels.indexOf(chosen)];
          if (!target) return;

          const confirmed = await ctx.ui.confirm(
            "Remove Codex account?",
            `Delete the saved account "${target.name}"? Pi's current login stays untouched.`,
          );
          if (!confirmed) return;

          await store.remove(target.name);
          ctx.ui.notify(`Removed Codex account "${target.name}"`, "info");
          return;
        }

        const account = accounts[labels.indexOf(selected)];
        if (!account || account.active) return;

        const provider = await store.switchTo(account.name);
        ctx.ui.notify(
          `Switched Pi's ${providerLabel(provider)} account to "${account.name}". The next request will use it.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}
