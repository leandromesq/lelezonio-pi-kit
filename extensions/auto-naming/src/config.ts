import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface NamingConfig {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_NAMING_CONFIG: NamingConfig = {
  enabled: true,
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  reasoning: "off",
};

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const PRIVATE_CONFIG_PATH = join(
  extensionDirectory,
  "config.private.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    typeof value === "string" &&
    REASONING_LEVELS.includes(value as ReasoningLevel)
  );
}

export function parseNamingConfig(value: unknown) {
  if (!isRecord(value)) return DEFAULT_NAMING_CONFIG;
  if (
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !isReasoningLevel(value.reasoning)
  ) {
    return DEFAULT_NAMING_CONFIG;
  }

  return {
    enabled: value.enabled ?? true,
    provider: value.provider.trim(),
    model: value.model.trim(),
    reasoning: value.reasoning,
  } satisfies NamingConfig;
}

export function loadNamingConfig() {
  try {
    return parseNamingConfig(
      JSON.parse(readFileSync(PRIVATE_CONFIG_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_NAMING_CONFIG;
  }
}

export async function saveNamingConfig(
  config: NamingConfig,
  signal?: AbortSignal,
) {
  const temporary = `${PRIVATE_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    await mkdir(dirname(PRIVATE_CONFIG_PATH), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      signal,
    });
    await rename(temporary, PRIVATE_CONFIG_PATH);
    committed = true;
  } finally {
    if (!committed) await unlink(temporary).catch(() => undefined);
  }
}
