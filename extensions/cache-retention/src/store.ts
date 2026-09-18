/**
 * Rule storage for the cache-retention policy.
 *
 * Three sources, applied in order:
 *   1. `config.private.json` — hand-written rules (most specific, first).
 *   2. `learned.private.json` — rules learned from provider errors. Writing the
 *      file is best-effort; the in-memory rule is always applied immediately so
 *      the next request is already fixed.
 *   3. `BUILT_IN_RULES` — evidence-backed defaults.
 *
 * Reads are lazy (first provider request) and cached per process: this
 * extension loads in every pi process, including every Herdr worker, so
 * module load must stay free of I/O.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_RULES, type CacheRule } from "./policy.ts";

export const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = join(EXTENSION_DIR, "config.private.json");
export const LEARNED_PATH = join(EXTENSION_DIR, "learned.private.json");
export const LEARNED_VERSION = 1;

export interface ParsedRules {
  readonly rules: readonly CacheRule[];
  /** Entries that were ignored, with a short reason, for diagnostics. */
  readonly skipped: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionsField(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return Object.fromEntries(
    entries.map(([key, item]) => [key, item as string]),
  );
}

function parseRuleEntry(index: number, value: unknown): CacheRule | string {
  if (!isRecord(value)) return `rule #${index}: not an object`;
  const provider =
    typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!provider) return `rule #${index}: missing provider`;
  if (!model) return `rule #${index}: missing model`;

  const stripRetention = value.stripRetention === true;
  const stripOptions = value.stripOptions === true;
  const stripKey = value.stripKey === true;
  const replaceWithOptions = parseOptionsField(value.replaceWithOptions);
  if (!stripRetention && !stripOptions && !stripKey && !replaceWithOptions) {
    return `rule #${index}: no directive (stripRetention/stripOptions/stripKey/replaceWithOptions)`;
  }

  const note = typeof value.note === "string" ? value.note.trim() : "";
  const learnedAt =
    typeof value.learnedAt === "number" && Number.isFinite(value.learnedAt)
      ? value.learnedAt
      : undefined;

  return {
    provider,
    model,
    ...(stripRetention ? { stripRetention } : {}),
    ...(stripOptions ? { stripOptions } : {}),
    ...(stripKey ? { stripKey } : {}),
    ...(replaceWithOptions ? { replaceWithOptions } : {}),
    ...(note ? { note } : {}),
    ...(learnedAt !== undefined ? { learnedAt } : {}),
  };
}

/** Parse `{ "rules": [...] }`, skipping entries that cannot be honored. */
export function parseRulesConfig(value: unknown): ParsedRules {
  if (!isRecord(value)) return { rules: [], skipped: [] };
  const raw = value.rules;
  if (!Array.isArray(raw)) return { rules: [], skipped: [] };
  const rules: CacheRule[] = [];
  const skipped: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseRuleEntry(index, entry);
    if (typeof parsed === "string") skipped.push(parsed);
    else rules.push(parsed);
  });
  return { rules, skipped };
}

/** Learned rules are ordinary rules; the wrapper only carries a version. */
export function parseLearnedState(value: unknown): ParsedRules {
  return parseRulesConfig(value);
}

function ruleKey(rule: CacheRule): string {
  return `${rule.provider.toLowerCase()}\u0000${rule.model.toLowerCase()}`;
}

export interface LearnedCacheRule extends CacheRule {
  readonly stripRetention?: boolean;
  readonly learnedAt: number;
}

export interface RuleStorePaths {
  readonly configPath: string;
  readonly learnedPath: string;
}

export interface RuleStoreSnapshot {
  readonly rules: readonly CacheRule[];
  readonly user: readonly CacheRule[];
  readonly learned: readonly CacheRule[];
  readonly skipped: readonly string[];
  readonly paths: RuleStorePaths;
}

export interface RuleStore {
  /** Load `config.private.json` + `learned.private.json` once per process. */
  ensureLoaded(): Promise<void>;
  /** User rules, then learned rules, then built-ins. */
  effectiveRules(): Promise<readonly CacheRule[]>;
  /** Record a rule learned from a provider error; persists best-effort. */
  learn(
    entry: Omit<LearnedCacheRule, "learnedAt"> & { learnedAt?: number },
  ): Promise<boolean>;
  snapshot(): RuleStoreSnapshot;
}

export interface RuleStoreOptions {
  readonly configPath?: string;
  readonly learnedPath?: string;
  /** Injectable for tests. Rejects when the file is missing. */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Injectable for tests. Defaults to an atomic temp-file + rename write. */
  readonly writeJsonFile?: (path: string, value: unknown) => Promise<void>;
}

async function readTextFileDefault(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function writeJsonFileDefault(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    committed = true;
  } finally {
    if (!committed) await unlink(temporary).catch(() => undefined);
  }
}

export function createRuleStore(options: RuleStoreOptions = {}): RuleStore {
  const paths: RuleStorePaths = {
    configPath: options.configPath ?? CONFIG_PATH,
    learnedPath: options.learnedPath ?? LEARNED_PATH,
  };
  const readTextFile = options.readTextFile ?? readTextFileDefault;
  const writeJsonFile = options.writeJsonFile ?? writeJsonFileDefault;

  const userRules: CacheRule[] = [];
  const learnedRules: LearnedCacheRule[] = [];
  const learnedByKey = new Map<string, LearnedCacheRule>();
  let skipped: string[] = [];
  let loading: Promise<void> | undefined;
  let persisting: Promise<void> = Promise.resolve();

  async function readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readTextFile(path));
    } catch {
      return undefined;
    }
  }

  async function load(): Promise<void> {
    const [config, learned] = await Promise.all([
      readJson(paths.configPath),
      readJson(paths.learnedPath),
    ]);
    const parsedConfig = parseRulesConfig(config);
    const parsedLearned = parseLearnedState(learned);
    userRules.push(...parsedConfig.rules);
    for (const rule of parsedLearned.rules) {
      const entry: LearnedCacheRule = {
        ...rule,
        learnedAt: rule.learnedAt ?? 0,
      };
      const key = ruleKey(entry);
      if (learnedByKey.has(key)) continue;
      learnedByKey.set(key, entry);
      learnedRules.push(entry);
    }
    skipped = [...parsedConfig.skipped, ...parsedLearned.skipped];
  }

  async function ensureLoaded(): Promise<void> {
    loading ??= load();
    await loading;
  }

  async function persist(): Promise<void> {
    const rules = [...learnedByKey.values()];
    persisting = persisting
      .then(async () => {
        // Re-read before writing so a rule learned by another pi process
        // (parent/child) survives.
        const onDisk = parseLearnedState(await readJson(paths.learnedPath));
        const merged = new Map<string, CacheRule>();
        for (const rule of [...onDisk.rules, ...rules]) {
          merged.set(ruleKey(rule), rule);
        }
        await writeJsonFile(paths.learnedPath, {
          version: LEARNED_VERSION,
          rules: [...merged.values()],
        });
      })
      .catch(() => undefined);
    await persisting;
  }

  return {
    async ensureLoaded() {
      await ensureLoaded();
    },
    async effectiveRules() {
      await ensureLoaded();
      return [...userRules, ...learnedRules, ...BUILT_IN_RULES];
    },
    async learn(entry) {
      await ensureLoaded();
      const rule: LearnedCacheRule = {
        ...entry,
        stripRetention: entry.stripRetention ?? true,
        learnedAt: entry.learnedAt ?? Date.now(),
      };
      const key = ruleKey(rule);
      if (learnedByKey.has(key)) return false;
      learnedByKey.set(key, rule);
      learnedRules.push(rule);
      await persist();
      return true;
    },
    snapshot() {
      return {
        rules: [...userRules, ...learnedRules, ...BUILT_IN_RULES],
        user: userRules,
        learned: learnedRules,
        skipped,
        paths,
      };
    },
  };
}

/** Shared store used by the extension entry point. */
export const ruleStore = createRuleStore();
