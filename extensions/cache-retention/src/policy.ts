/**
 * Pure request-policy layer for prompt-cache parameters.
 *
 * Why this exists: pi-ai decides which cache fields to send from the model's
 * `compat` flags (from the remote model catalogue) plus `PI_CACHE_RETENTION`.
 * Endpoints drift from that catalogue — `opencode-go` rejects
 * `prompt_cache_retention` for GLM ("not supported by this endpoint; use
 * prompt_cache_options") while accepting it for DeepSeek/Qwen/Kimi. A wrong
 * guess is a hard 400 on every turn, so the policy is applied locally, per
 * model, on the payload right before it leaves the process.
 *
 * Semantics (all matching rules are merged, order-independent):
 *   - any `stripRetention` or `replaceWithOptions` removes
 *     `prompt_cache_retention`;
 *   - `replaceWithOptions` sets `prompt_cache_options` unless some matching
 *     rule strips options — that way a rule learned from a real provider
 *     rejection always beats configured intent instead of looping on a 400;
 *   - `replaceWithOptions` objects merge key-wise in rule order.
 *
 * Kept free of I/O so every rule is unit-testable.
 */

/** Per-model (or per-endpoint) cache-parameter policy. */
export interface CacheRule {
  /** Provider id (`"opencode-go"`) or `"*"` for any provider. */
  readonly provider: string;
  /** Model id, or a glob where `*` matches any run of characters. */
  readonly model: string;
  /** Remove `prompt_cache_retention` from the payload. */
  readonly stripRetention?: boolean;
  /** Remove `prompt_cache_options` from the payload. */
  readonly stripOptions?: boolean;
  /** Remove `prompt_cache_key` from the payload. */
  readonly stripKey?: boolean;
  /** Replace the retention field with this `prompt_cache_options` object. */
  readonly replaceWithOptions?: Readonly<Record<string, string>>;
  /** Human-readable reason, shown by `/cache`. */
  readonly note?: string;
  /** Epoch milliseconds for rules learned from a provider error. */
  readonly learnedAt?: number;
}

/** Provider + model the payload is being built for. */
export interface CacheTarget {
  readonly provider: string;
  readonly model: string;
}

/**
 * Endpoints where pi-ai's default cache fields are rejected.
 *
 * Evidence (live requests against `https://opencode.ai/zen/go/v1`, 2026-09):
 * `glm-5.1`, `glm-5.3` and `glm-5.3-flash` answer
 * `"prompt_cache_retention" is not supported by this endpoint` (or
 * `Extra inputs are not permitted, field: 'prompt_cache_retention'`), while
 * DeepSeek/Qwen/Kimi models on the same gateway accept the field. GLM also
 * rejects `prompt_cache_options` on `glm-5.1`/`glm-5.3`, and the `ttl` it
 * accepts differs per routed backend, so nothing is sent in its place.
 */
export const BUILT_IN_RULES: readonly CacheRule[] = [
  {
    provider: "opencode-go",
    model: "glm-*",
    stripRetention: true,
    note: "Zen gateway: GLM rejects prompt_cache_retention",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Glob matcher where `*` means "any run of characters" (case-insensitive). */
export function matchesModelPattern(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) {
    return pattern.toLowerCase() === model.toLowerCase();
  }
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(model);
}

export function matchesCacheRule(
  rule: CacheRule,
  target: CacheTarget,
): boolean {
  if (rule.provider !== "*" && rule.provider !== target.provider) return false;
  return matchesModelPattern(rule.model, target.model);
}

/** Every rule that applies to this target, in declaration order. */
export function matchingCacheRules(
  rules: readonly CacheRule[],
  target: CacheTarget,
): CacheRule[] {
  return rules.filter((rule) => matchesCacheRule(rule, target));
}

export interface CachePolicyResult {
  /** True when the payload must be sent instead of the original. */
  readonly changed: boolean;
  readonly payload: unknown;
  /** Human-readable list of mutations, for diagnostics. */
  readonly applied: readonly string[];
}

function mergeOptions(
  matches: readonly CacheRule[],
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let present = false;
  for (const rule of matches) {
    if (!rule.replaceWithOptions) continue;
    Object.assign(merged, rule.replaceWithOptions);
    present = true;
  }
  return present ? merged : undefined;
}

/** Net effect of the policy for one target, independent of a real payload. */
export function describeCacheEffect(
  rules: readonly CacheRule[],
  target: CacheTarget,
): readonly string[] {
  return applyCachePolicy(
    {
      prompt_cache_key: "probe",
      prompt_cache_retention: "24h",
      prompt_cache_options: { mode: "explicit" },
    },
    rules,
    target,
  ).applied;
}

/** Apply the matching rules to an outgoing provider payload. */
export function applyCachePolicy(
  payload: unknown,
  rules: readonly CacheRule[],
  target: CacheTarget,
): CachePolicyResult {
  if (!isRecord(payload)) {
    return { changed: false, payload, applied: [] };
  }
  const matches = matchingCacheRules(rules, target);
  if (matches.length === 0) {
    return { changed: false, payload, applied: [] };
  }

  const next: Record<string, unknown> = { ...payload };
  const applied: string[] = [];
  const stripOptions = matches.some((rule) => rule.stripOptions);
  const options = stripOptions ? undefined : mergeOptions(matches);
  const stripRetention =
    matches.some((rule) => rule.stripRetention || rule.replaceWithOptions) ||
    options !== undefined;

  if (stripRetention && "prompt_cache_retention" in next) {
    delete next.prompt_cache_retention;
    applied.push("removed prompt_cache_retention");
  }
  if (options) {
    next.prompt_cache_options = options;
    applied.push(`prompt_cache_options ${JSON.stringify(options)}`);
  } else if (stripOptions && "prompt_cache_options" in next) {
    delete next.prompt_cache_options;
    applied.push("removed prompt_cache_options");
  }
  if (matches.some((rule) => rule.stripKey) && "prompt_cache_key" in next) {
    delete next.prompt_cache_key;
    applied.push("removed prompt_cache_key");
  }

  if (applied.length === 0) {
    return { changed: false, payload, applied };
  }
  return { changed: true, payload: next, applied };
}

/**
 * Best-effort target for a request. `payload.model` is authoritative for the
 * model id (in-process children build payloads for their own model), while the
 * provider only comes from the session context.
 */
export function cacheTargetFrom(
  payload: unknown,
  context: { provider?: string | undefined; model?: string | undefined },
): CacheTarget {
  const payloadModel = isRecord(payload) ? payload.model : undefined;
  return {
    provider: context.provider ?? "",
    model:
      typeof payloadModel === "string" && payloadModel.length > 0
        ? payloadModel
        : (context.model ?? ""),
  };
}
