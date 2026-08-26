import * as fs from "node:fs";
import * as path from "node:path";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  type BackendName,
  type ReasoningEffort,
} from "./domain.ts";

export interface HarnessConfig {
  readonly model?: string;
  readonly thinking?: ReasoningEffort;
}

export type ContextMode = "standalone" | "summary";

export interface SubagentProfileConfig extends HarnessConfig {
  readonly harness: BackendName;
  /** System prompt injected into the child, above the task prompt. */
  readonly systemPrompt?: string;
  /** Path to a system-prompt markdown file (relative to the agent dir, or absolute). */
  readonly promptFile?: string;
  /** Explicit pi tool allowlist for the child (builtin tool names). */
  readonly tools?: readonly string[];
  /** Read-only child: write/edit/bash removed; codex sandbox forced read-only. */
  readonly readOnly?: boolean;
  /** Profile names this agent may spawn (constrained nesting). */
  readonly allowChildren?: readonly string[];
  /** Max nesting depth (top-level = 0). Default 1 when allowChildren is set. */
  readonly maxDepth?: number;
  /** Context handoff mode: "standalone" (default) or "summary". */
  readonly contextMode?: ContextMode;
  /** Default working directory for this profile (spawned relative to the
   * caller's cwd). The model's explicit working_dir overrides it. */
  readonly cwd?: string;
}

export interface SubagentsConfig {
  readonly defaultHarness: BackendName;
  readonly maxConcurrent: number;
  readonly harnesses: Partial<Record<BackendName, HarnessConfig>>;
  readonly profiles: Readonly<Record<string, SubagentProfileConfig>>;
}

export interface SpawnOverrides {
  readonly profile?: string;
  readonly harness?: BackendName;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface ResolvedSpawnOptions {
  readonly profile?: string;
  readonly harness: BackendName;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/** Normalized profile behavior with defaults applied. */
export interface ProfileBehavior {
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly readOnly: boolean;
  readonly allowChildren: readonly string[];
  readonly maxDepth: number;
  readonly contextMode: ContextMode;
  readonly cwd?: string;
}

const DEFAULT_CONFIG: SubagentsConfig = {
  defaultHarness: "pi",
  maxConcurrent: 4,
  harnesses: {},
  profiles: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function backend(value: unknown, field: string): BackendName {
  if (
    typeof value === "string" &&
    BACKEND_NAMES.includes(value as BackendName)
  ) {
    return value as BackendName;
  }
  throw new Error(`${field} must be one of: ${BACKEND_NAMES.join(", ")}`);
}

function thinking(value: unknown, field: string) {
  if (
    typeof value === "string" &&
    REASONING_EFFORTS.includes(value as ReasoningEffort)
  ) {
    return value as ReasoningEffort;
  }
  throw new Error(`${field} must be one of: ${REASONING_EFFORTS.join(", ")}`);
}

function optionalModel(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  const items = value.map((v: string) => v.trim()).filter(Boolean);
  if (new Set(items).size !== items.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return items;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalInt(
  value: unknown,
  field: string,
  min: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer >= ${min}`);
  }
  return value;
}

function contextMode(value: unknown, field: string): ContextMode | undefined {
  if (value === undefined) return undefined;
  if (value === "standalone" || value === "summary") return value;
  throw new Error(`${field} must be one of: standalone, summary`);
}

function parseHarnessConfig(value: unknown, field: string): HarnessConfig {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return {
    model: optionalModel(value.model, `${field}.model`),
    thinking:
      value.thinking === undefined
        ? undefined
        : thinking(value.thinking, `${field}.thinking`),
  };
}

export function parseSubagentsConfig(value: unknown): SubagentsConfig {
  if (!isRecord(value))
    throw new Error("subagents.json must contain an object");

  const defaultHarness =
    value.defaultHarness === undefined
      ? DEFAULT_CONFIG.defaultHarness
      : backend(value.defaultHarness, "defaultHarness");
  const maxConcurrent = value.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent;
  if (
    typeof maxConcurrent !== "number" ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 4
  ) {
    throw new Error("maxConcurrent must be an integer from 1 to 4");
  }

  const harnesses: Partial<Record<BackendName, HarnessConfig>> = {};
  if (value.harnesses !== undefined) {
    if (!isRecord(value.harnesses)) {
      throw new Error("harnesses must be an object");
    }
    for (const [name, config] of Object.entries(value.harnesses)) {
      const harness = backend(name, `harnesses.${name}`);
      harnesses[harness] = parseHarnessConfig(config, `harnesses.${name}`);
    }
  }

  const profiles: Record<string, SubagentProfileConfig> = {};
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles))
      throw new Error("profiles must be an object");
    for (const [name, config] of Object.entries(value.profiles)) {
      if (!name.trim()) throw new Error("profile names must not be empty");
      const record = config as Record<string, unknown>;
      const parsed = parseHarnessConfig(config, `profiles.${name}`);
      const systemPrompt = optionalString(
        record.systemPrompt,
        `profiles.${name}.systemPrompt`,
      );
      const promptFile = optionalString(
        record.promptFile,
        `profiles.${name}.promptFile`,
      );
      if (systemPrompt && promptFile) {
        throw new Error(
          `profiles.${name} must not set both systemPrompt and promptFile`,
        );
      }
      const tools = optionalStringArray(record.tools, `profiles.${name}.tools`);
      const readOnly = optionalBoolean(
        record.readOnly,
        `profiles.${name}.readOnly`,
      );
      const allowChildren = optionalStringArray(
        record.allowChildren,
        `profiles.${name}.allowChildren`,
      );
      const maxDepth = optionalInt(
        record.maxDepth,
        `profiles.${name}.maxDepth`,
        0,
      );
      const contextModeValue = contextMode(
        record.contextMode,
        `profiles.${name}.contextMode`,
      );
      const profileCwd = optionalString(record.cwd, `profiles.${name}.cwd`);
      if (maxDepth === 0 && (allowChildren?.length ?? 0) > 0) {
        throw new Error(
          `profiles.${name}: maxDepth must be >= 1 when allowChildren is set`,
        );
      }
      profiles[name] = {
        harness: backend(record.harness, `profiles.${name}.harness`),
        ...parsed,
        systemPrompt,
        promptFile,
        tools,
        readOnly,
        allowChildren,
        maxDepth,
        contextMode: contextModeValue,
        cwd: profileCwd,
      };
    }
  }

  // allowChildren must reference known profiles.
  for (const [name, profile] of Object.entries(profiles)) {
    for (const child of profile.allowChildren ?? []) {
      if (!profiles[child]) {
        throw new Error(
          `profiles.${name}.allowChildren references unknown profile "${child}"`,
        );
      }
    }
  }

  return { defaultHarness, maxConcurrent, harnesses, profiles };
}

export function loadSubagentsConfig(filePath: string): SubagentsConfig {
  if (!fs.existsSync(filePath)) return DEFAULT_CONFIG;
  try {
    return parseSubagentsConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path.basename(filePath)}: ${message}`);
  }
}

const mergedCache = new Map<string, SubagentsConfig>();

/** Load the global config merged with a project-local `.pi/subagents.json`
 * overlay. Project profiles override global ones by name (same schema, one
 * parser); project harnesses/models, maxConcurrent and defaultHarness also
 * win. Resolution is anchored at `base` (the caller's cwd). */
export function loadConfigMerged(
  globalConfig: SubagentsConfig,
  base: string,
): SubagentsConfig {
  const cached = mergedCache.get(base);
  if (cached) return cached;
  const projectPath = path.join(base, ".pi", "subagents.json");
  let merged = globalConfig;
  if (fs.existsSync(projectPath)) {
    const project = parseSubagentsConfig(
      JSON.parse(fs.readFileSync(projectPath, "utf8")),
    );
    merged = {
      defaultHarness: project.defaultHarness,
      maxConcurrent: project.maxConcurrent,
      harnesses: { ...globalConfig.harnesses, ...project.harnesses },
      profiles: { ...globalConfig.profiles, ...project.profiles },
    };
  }
  mergedCache.set(base, merged);
  return merged;
}

export function clearMergedCache() {
  mergedCache.clear();
}

export function resolveSpawnOptions(
  config: SubagentsConfig,
  overrides: SpawnOverrides,
): ResolvedSpawnOptions {
  const profile = overrides.profile
    ? config.profiles[overrides.profile]
    : undefined;
  if (overrides.profile && !profile) {
    throw new Error(
      `Unknown subagent profile "${overrides.profile}". Available profiles: ${
        Object.keys(config.profiles).join(", ") || "none"
      }.`,
    );
  }

  const harness =
    overrides.harness ?? profile?.harness ?? config.defaultHarness;
  const harnessDefaults = config.harnesses[harness];
  return {
    profile: overrides.profile,
    harness,
    model: overrides.model ?? profile?.model ?? harnessDefaults?.model,
    reasoningEffort:
      overrides.reasoningEffort ??
      profile?.thinking ??
      harnessDefaults?.thinking,
  };
}

/** Defaults applied to a profile's behavioral fields. */
export function resolveProfileBehavior(
  profile?: SubagentProfileConfig,
): ProfileBehavior {
  if (!profile) {
    return {
      readOnly: false,
      allowChildren: [],
      maxDepth: 0,
      contextMode: "standalone",
      cwd: undefined,
    };
  }
  const allowChildren = profile.allowChildren ?? [];
  return {
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    readOnly: profile.readOnly ?? false,
    allowChildren,
    maxDepth: profile.maxDepth ?? (allowChildren.length > 0 ? 1 : 0),
    contextMode: profile.contextMode ?? "standalone",
    cwd: profile.cwd,
  };
}
