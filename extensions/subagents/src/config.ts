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

export interface SubagentProfileConfig extends HarnessConfig {
  readonly harness: BackendName;
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
      const parsed = parseHarnessConfig(config, `profiles.${name}`);
      const record = config as Record<string, unknown>;
      profiles[name] = {
        harness: backend(record.harness, `profiles.${name}.harness`),
        ...parsed,
      };
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
