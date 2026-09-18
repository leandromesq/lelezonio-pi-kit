/**
 * Extended prompt-cache retention for every pi process (parent + children).
 *
 * Why: provider prompt caches expire after ~5 minutes by default. Subagent
 * paced sessions are full of idle gaps (waiting on children), so every turn
 * after a gap re-read the entire context — 100K+ tokens of prefill that makes
 * long sessions feel really slow. "long" extends retention where the provider
 * supports it (Anthropic: 1h, OpenAI/Codex: 24h).
 *
 * pi-ai resolves PI_CACHE_RETENTION per request from process.env, so setting
 * it once at extension load time (before the first request) is enough. Each
 * Herdr worker pane is its own pi process and loads this extension too, so
 * children get the same behavior. `??=` keeps an explicit shell-level setting
 * in control.
 *
 * Not every endpoint accepts the field pi-ai then sends. `opencode-go`
 * rejects `prompt_cache_retention` for GLM models (`"prompt_cache_retention"
 * is not supported by this endpoint; use "prompt_cache_options"`), which turns
 * every turn into a 400. So the request payload is also filtered per model:
 * see `src/policy.ts` for the built-in rules, `src/store.ts` for the optional
 * `config.private.json`, and the `/cache` command for the effective state.
 * Rules learned from a provider error are persisted and applied from the next
 * request on, so an unknown endpoint degrades once instead of failing forever.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  applyCachePolicy,
  cacheTargetFrom,
  describeCacheEffect,
  matchingCacheRules,
  type CacheRule,
} from "./src/policy.ts";
import { ruleStore } from "./src/store.ts";

if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = "long";

const LEARNED_FIELDS = [
  { field: "prompt_cache_retention", directive: "stripRetention" },
  { field: "prompt_cache_options", directive: "stripOptions" },
  { field: "prompt_cache_key", directive: "stripKey" },
] as const;

/** Short, single-line excerpt around the rejected field name. */
function errorNote(text: string, field: string): string {
  const json = text.match(/^\d{3}:\s*(\{[\s\S]*\})$/);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]!) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message) {
        text = parsed.message;
      }
    } catch {
      // Fall through to the raw excerpt.
    }
  }
  const index = text.toLowerCase().indexOf(field);
  const clause =
    index >= 0
      ? text.slice(Math.max(0, index - 40), index + 80)
      : text.slice(0, 120);
  return clause.replace(/\s+/g, " ").trim();
}

function describeRule(rule: CacheRule): string {
  const parts: string[] = [];
  if (rule.stripRetention) parts.push("remove prompt_cache_retention");
  if (rule.stripOptions) parts.push("remove prompt_cache_options");
  if (rule.stripKey) parts.push("remove prompt_cache_key");
  if (rule.replaceWithOptions) {
    parts.push(
      `prompt_cache_options ${JSON.stringify(rule.replaceWithOptions)}`,
    );
  }
  return parts.join(" · ") || "no-op";
}

export default function cacheRetention(pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    const target = cacheTargetFrom(event.payload, {
      provider: ctx.model?.provider,
      model: ctx.model?.id,
    });
    if (!target.model) return undefined;
    const rules = await ruleStore.effectiveRules();
    const result = applyCachePolicy(event.payload, rules, target);
    return result.changed ? result.payload : undefined;
  });

  /**
   * A rejected cache field is the one failure this extension can fix by
   * itself, so learn it and persist it for every other pi process.
   */
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const text = message.errorMessage;
    if (!text) return;
    const provider = message.provider ?? ctx.model?.provider;
    const model = message.model ?? ctx.model?.id;
    if (!provider || !model) return;

    for (const { field, directive } of LEARNED_FIELDS) {
      if (!text.toLowerCase().includes(field)) continue;
      if (
        directive === "stripRetention" &&
        !/not supported|not permitted/i.test(text)
      ) {
        continue;
      }
      await ruleStore.learn({
        provider,
        model,
        [directive]: true,
        note: errorNote(text, field),
      });
      return;
    }
  });

  pi.registerCommand("cache", {
    description: "Show prompt-cache policy, learned rules and config paths",
    handler: async (_args, ctx) => {
      const rows = await cacheReport(ctx);
      if (ctx.mode !== "tui") {
        ctx.ui.notify(rows.join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => ({
          render(width: number) {
            return [
              theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
              ...rows.map((line, index) =>
                truncateToWidth(
                  ` ${
                    index === 0
                      ? theme.fg("accent", theme.bold(line))
                      : theme.fg("text", line)
                  }`,
                  width,
                ),
              ),
              truncateToWidth(
                theme.fg(
                  "dim",
                  ` ${keybindings.getKeys("tui.select.cancel").join("/") || "Esc"} close`,
                ),
                width,
              ),
              theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
            ];
          },
          handleInput(data: string) {
            if (
              matchesKey(data, Key.escape) ||
              keybindings.matches(data, "tui.select.cancel")
            )
              done();
            // No re-render on other keys: the report is static until reopened.
          },
          invalidate() {},
        }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "80%",
            maxHeight: "80%",
            minWidth: 50,
          },
        },
      );
    },
  });
}

async function cacheReport(ctx: ExtensionContext): Promise<string[]> {
  await ruleStore.ensureLoaded();
  const snapshot = ruleStore.snapshot();
  const model = ctx.model;
  const target = model
    ? { provider: model.provider, model: model.id }
    : undefined;
  const matches = target ? matchingCacheRules(snapshot.rules, target) : [];
  const effect = target ? describeCacheEffect(snapshot.rules, target) : [];
  const source = (rule: CacheRule) =>
    snapshot.user.includes(rule)
      ? "config "
      : snapshot.learned.includes(rule)
        ? "learned"
        : "builtin";

  const rows = [
    "Prompt cache policy",
    "",
    `PI_CACHE_RETENTION: ${process.env.PI_CACHE_RETENTION ?? "(unset)"}`,
    "",
    model ? `Model: ${model.provider}/${model.id}` : "Model: none active",
    effect.length > 0
      ? `Net effect: ${effect.join(" · ")}`
      : "Net effect: payload unchanged",
    ...matches.map(
      (rule) =>
        `  ${source(rule)} ${rule.provider}/${rule.model} → ${describeRule(rule)}`,
    ),
    "",
    `Rules: ${snapshot.user.length} config · ${snapshot.learned.length} learned · ${
      snapshot.rules.length - snapshot.user.length - snapshot.learned.length
    } built-in`,
  ];

  for (const rule of snapshot.learned) {
    const when = rule.learnedAt
      ? new Date(rule.learnedAt).toISOString().slice(0, 16).replace("T", " ")
      : "unknown";
    rows.push(
      `  learned ${rule.provider}/${rule.model} → ${describeRule(rule)} (${when})`,
    );
  }
  for (const rule of snapshot.user) {
    rows.push(
      `  config  ${rule.provider}/${rule.model} → ${describeRule(rule)}`,
    );
  }
  for (const entry of snapshot.skipped) {
    rows.push(`  skipped ${entry}`);
  }

  rows.push(
    "",
    `Config:  ${snapshot.paths.configPath}`,
    `Learned: ${snapshot.paths.learnedPath}`,
    'Add a rule with { "rules": [ { "provider": "p", "model": "m*", "stripRetention": true } ] }.',
    "A learned strip always beats a configured prompt_cache_options for the same model.",
  );
  return rows;
}
