import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

export interface Config {
	/** Raw-history token size of one observation chunk (fixed boundary). */
	chunkTokens: number;
	/**
	 * Reserved overlap between adjacent chunks. Accepted for upstream config compatibility
	 * but unused by the chunk cutter (a no-op). Kept so the setting validates instead of
	 * being silently dropped; do not rely on it.
	 */
	chunkOverlapTokens: number;
	/** Target size of the active observation pool; the buffer drains back toward this after consolidation. */
	poolTargetTokens: number;
	/** Active-pool token count that triggers a consolidation (>= poolTargetTokens). */
	consolidateAtPoolTokens: number;
	/**
	 * Live context-window usage that triggers proactive compaction. `0` disables the proactive
	 * trigger entirely, leaving Pi's own pressure compaction (and the manual `/compact`) to
	 * drive compaction; OM still supplies the summary through `session_before_compact`.
	 */
	compactAtContextTokens: number;
	/** Verbatim raw tail kept after the cutoff; snaps to a chunk boundary. */
	tailTokens: number;
	/**
	 * Target size of `.memory/<sessionId>/JOURNEY.md`, the running descriptive project history
	 * the consolidator appends to and pushes into every compaction block. When the file grows
	 * past this, the consolidator compresses its oldest entries (recent history stays detailed).
	 */
	journeyTargetTokens: number;
	/** Max simultaneous in-flight observer subprocesses (bounded: 1..8). */
	observerConcurrency: number;
	/** Wall-clock bound for one worker subprocess in ms. `0` disables the bound. */
	timeoutMs: number;
	/** Turn cap enforced by the worker extension. `0` disables the cap. */
	maxTurns: number;
	models: {
		observer: ConfiguredModel;
		consolidator: ConfiguredModel;
	};
	/**
	 * Fallback for the per-session on/off gate, used only when the branch has no `om2.enabled`
	 * entry. The upstream default is OFF; a user who wants observational memory active in every
	 * session sets this to `true`. `/om off` still overrides it for the session.
	 */
	enabled: boolean;
	/** Power-user setting: disable all triggers (distinct from the on/off gate). */
	passive: boolean;
	/** Emit the NDJSON debug log. */
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	chunkTokens: 10_000,
	chunkOverlapTokens: 0,
	poolTargetTokens: 10_000,
	consolidateAtPoolTokens: 15_000,
	// Proactive compaction is opt-in; Pi's native pressure compaction is authoritative by default.
	compactAtContextTokens: 0,
	tailTokens: 20_000,
	journeyTargetTokens: 1_000,
	observerConcurrency: 4,
	timeoutMs: 600_000,
	maxTurns: 40,
	enabled: false,
	models: {
		observer: { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "low" },
		consolidator: { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "low" },
	},
	passive: false,
	debugLog: false,
};

/** Hard bounds so a typo cannot fan out subprocesses or run one forever. */
export const OBSERVER_CONCURRENCY_MAX = 8;
export const TIMEOUT_MS_MAX = 3_600_000;
export const MAX_TURNS_MAX = 200;

/** Pi 1 thinking levels, including `max`. */
const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OM_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

/** Accepts 0 (disabled) or a positive integer. */
function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown, fallback: ConfiguredModel): ConfiguredModel {
	if (!isRecord(value)) return fallback;
	const provider = nonEmptyString(value.provider) ?? fallback.provider;
	const id = nonEmptyString(value.id) ?? fallback.id;
	const model: ConfiguredModel = { provider, id };
	const thinking = isThinkingLevel(value.thinking) ? value.thinking : fallback.thinking;
	if (thinking) model.thinking = thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>, base: Config): Partial<Config> {
	const normalized: Partial<Config> = {};
	const positiveKeys = [
		"chunkTokens",
		"poolTargetTokens",
		"consolidateAtPoolTokens",
		"tailTokens",
		"journeyTargetTokens",
		"observerConcurrency",
	] as const;
	for (const key of positiveKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// These accept 0 as an explicit "disabled" value.
	for (const key of ["chunkOverlapTokens", "compactAtContextTokens", "timeoutMs", "maxTurns"] as const) {
		const normalizedValue = nonNegativeIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (typeof value.enabled === "boolean") normalized.enabled = value.enabled;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	if (isRecord(value.models)) {
		normalized.models = {
			observer: normalizeModel(value.models.observer, base.models.observer),
			consolidator: normalizeModel(value.models.consolidator, base.models.consolidator),
		};
	}
	return normalized;
}

/**
 * Enforce relational bounds after all sources are merged, so a valid-looking project value
 * cannot contradict a global one in a way that breaks the clocks.
 */
export function applyRelationalBounds(config: Config): Config {
	const chunkTokens = Math.max(1, config.chunkTokens);
	const chunkOverlapTokens = clamp(config.chunkOverlapTokens, 0, chunkTokens - 1);
	const poolTargetTokens = Math.max(1, config.poolTargetTokens);
	const consolidateAtPoolTokens = Math.max(poolTargetTokens, config.consolidateAtPoolTokens);
	return {
		...config,
		chunkTokens,
		chunkOverlapTokens,
		poolTargetTokens,
		consolidateAtPoolTokens,
		observerConcurrency: clamp(config.observerConcurrency, 1, OBSERVER_CONCURRENCY_MAX),
		timeoutMs: clamp(config.timeoutMs, 0, TIMEOUT_MS_MAX),
		maxTurns: clamp(config.maxTurns, 0, MAX_TURNS_MAX),
	};
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string, base: Config): Partial<Config> {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested, base) : {};
	} catch {
		return {};
	}
}

export interface LoadConfigOptions {
	/**
	 * Whether the project is trusted. Project settings (`<cwd>/.pi/settings.json`) are
	 * untrusted input, so they are read only when this is true. Global settings
	 * (`<agentDir>/settings.json`) are always read. Defaults to false (fail closed).
	 */
	projectTrusted?: boolean;
}

export function loadConfig(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	options: LoadConfigOptions = {},
): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath, DEFAULTS);
	const projectConfig = options.projectTrusted ? readNamespacedConfig(projectPath, DEFAULTS) : {};
	const envConfig = readEnvConfig(env);
	return applyRelationalBounds({
		...DEFAULTS,
		...globalConfig,
		...projectConfig,
		...envConfig,
		models: {
			...DEFAULTS.models,
			...globalConfig.models,
			...projectConfig.models,
		},
	});
}
