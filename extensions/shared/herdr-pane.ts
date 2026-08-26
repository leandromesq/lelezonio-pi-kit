/**
 * Herdr pane helpers — split/run/close a visual "take over" or by-the-way
 * pane next to the current one, extracted from the subagents extension so all
 * extensions share one reviewed implementation of the Herdr CLI dance.
 *
 * Everything here is plain Node (no pi imports), so it runs in unit tests.
 * The pane API is the deep seam: tests inject a stub runner/current-pane
 * resolver instead of talking to a live Herdr server.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** This pi session was launched by Herdr into a pane with a live socket. */
export function herdrEnvironment(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_PANE_ID &&
    !!process.env.HERDR_SOCKET_PATH
  );
}

/** Stable JSON envelope herdr subcommands print (last trimmed line). */
export interface HerdrCliEnvelope {
  readonly error?: unknown;
  readonly result?: HerdrCliEnvelope;
  readonly pane?: { readonly pane_id?: string };
}

const SPLIT_DIRECTION = "right";
const SPLIT_RATIO = "0.45";
const RUN_RETRY_DEADLINE_MS = 15_000;
const RUN_RETRY_DELAY_MS = 500;
const SPLIT_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 10_000;

export interface SplitHerdrPaneOptions {
  /** Working directory the new pane should start in. */
  readonly cwd: string;
  /**
   * Environment variables for the pane process. The takeover viewer receives
   * its bridge endpoint this way; values must be single-token safe
   * (no `=`, spaces, or newlines).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Split without stealing focus from the caller (default: keep focus). */
  readonly noFocus?: boolean;
}

/** Run a herdr CLI subcommand and parse its JSON envelope. */
export type HerdrRunner = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<HerdrCliEnvelope>;

export interface HerdrPaneApi {
  /** True when this process runs inside a Herdr pane with a live socket. */
  environment(): boolean;
  /** Split the current pane; resolves the new pane id. */
  split(options: SplitHerdrPaneOptions): Promise<string>;
  /** Run a command in the pane, retrying while the pane shell is starting. */
  run(paneId: string, args: ReadonlyArray<string>): Promise<void>;
  /** Best-effort close of a pane we opened (rollback / cleanup). */
  close(paneId: string): Promise<void>;
}

export interface HerdrPaneDeps {
  /** Injectable CLI runner (tests). Defaults to the real `herdr` binary. */
  readonly runner?: HerdrRunner;
  /** Resolves the pane id to split from. Defaults to HERDR_PANE_ID. */
  readonly currentPaneId?: () => string | undefined;
  /** How long `run` retries `agent_pane_busy` (tests pass a small value). */
  readonly runRetryDeadlineMs?: number;
}

// --- CLI runner (default) -------------------------------------------------------

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function latestStandaloneReleases(): string[] {
  const root = path.join(
    os.homedir(),
    ".herdr",
    "packages",
    "standalone",
    "releases",
  );
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, 8)
    .map((name) => path.join(root, name));
}

function herdrExecutable(): string | undefined {
  // HERDR_EXE and HERDR_BIN_PATH are injected by Herdr itself.
  const explicit = [process.env.HERDR_EXE, process.env.HERDR_BIN_PATH]
    .map((value) => value?.trim())
    .find((value) => value && isFile(value));
  if (explicit) return explicit;
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of ["herdr.exe", "herdr.cmd", "herdr"]) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  for (const release of latestStandaloneReleases()) {
    const candidate = path.join(release, "herdr.exe");
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function parseCliJson(output: string): HerdrCliEnvelope | undefined {
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) return {};
  try {
    return JSON.parse(lastLine) as HerdrCliEnvelope;
  } catch {
    return undefined;
  }
}

export function runHerdr(
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<HerdrCliEnvelope> {
  return new Promise((resolve, reject) => {
    const executable = herdrExecutable();
    if (!executable) {
      reject(new Error("herdr executable not found"));
      return;
    }
    const child = spawn(executable, [...args], { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish(() =>
        reject(
          new Error(`herdr ${args[0] ?? ""} timed out after ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        const output = Buffer.concat(stdout).toString("utf8").trim();
        const errorText = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(errorText || output || `herdr exited ${code}`));
          return;
        }
        // Login banners or shell startup noise may precede the JSON envelope.
        const parsed = parseCliJson(output);
        if (!parsed) {
          reject(
            new Error(
              `herdr returned non-JSON output: ${output.slice(0, 300)}`,
            ),
          );
          return;
        }
        if (parsed.error !== undefined) {
          reject(
            new Error(
              typeof parsed.error === "object"
                ? JSON.stringify(parsed.error)
                : String(parsed.error),
            ),
          );
          return;
        }
        resolve(parsed);
      });
    });
  });
}

/** Shell-quote for the pane shell, which is pwsh (herdr default_shell). */
export function shellQuote(value: string): string {
  // Single quotes are literal in pwsh; embedded single quotes are doubled.
  return `'${value.replaceAll("'", "''")}'`;
}

// --- Pane API --------------------------------------------------------------------

export function createHerdrPaneApi(deps?: HerdrPaneDeps): HerdrPaneApi {
  const runner = deps?.runner ?? runHerdr;
  const currentPaneId =
    deps?.currentPaneId ?? (() => process.env.HERDR_PANE_ID);
  const runRetryDeadlineMs = deps?.runRetryDeadlineMs ?? RUN_RETRY_DEADLINE_MS;

  return {
    environment: () => herdrEnvironment(),

    async split(options: SplitHerdrPaneOptions): Promise<string> {
      const current = currentPaneId();
      if (!current) throw new Error("HERDR_PANE_ID is not set");
      const args: string[] = [
        "pane",
        "split",
        current,
        "--direction",
        SPLIT_DIRECTION,
        "--ratio",
        SPLIT_RATIO,
        "--cwd",
        options.cwd,
      ];
      for (const [key, value] of Object.entries(options.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      if (options.noFocus) args.push("--no-focus");
      const output = await runner(args, SPLIT_TIMEOUT_MS);
      const result = output.result ?? output;
      const paneId = result.pane?.pane_id;
      if (!paneId) {
        throw new Error(
          `herdr pane.split returned no pane: ${JSON.stringify(output).slice(0, 300)}`,
        );
      }
      return paneId;
    },

    async run(paneId: string, args: ReadonlyArray<string>): Promise<void> {
      const deadline = Date.now() + runRetryDeadlineMs;
      for (;;) {
        try {
          await runner(["pane", "run", paneId, ...args], RUN_TIMEOUT_MS);
          return;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!message.includes("agent_pane_busy") || Date.now() >= deadline) {
            throw error;
          }
          await sleep(RUN_RETRY_DELAY_MS);
        }
      }
    },

    async close(paneId: string): Promise<void> {
      await runner(["pane", "close", paneId], CLOSE_TIMEOUT_MS);
    },
  };
}

/**
 * Split a pane, run a command in it, and roll back (close the pane) if the
 * run fails. Throws on failure so callers can decide fallback behavior;
 * the pane is always cleaned up here first.
 */
export async function tryOpenHerdrPane(
  api: HerdrPaneApi,
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly noFocus?: boolean;
    /** Command to run in the new pane, e.g. ["node", viewerPath]. */
    readonly command: ReadonlyArray<string>;
  },
): Promise<string> {
  let openedPaneId: string | undefined;
  try {
    openedPaneId = await api.split({
      cwd: options.cwd,
      env: options.env,
      noFocus: options.noFocus,
    });
    await api.run(openedPaneId, options.command);
    return openedPaneId;
  } catch (error) {
    // A half-started pane must not linger after the command failed to start.
    if (openedPaneId) {
      try {
        await api.close(openedPaneId);
      } catch {
        // Best effort; the pane may already be gone.
      }
    }
    throw error;
  }
}
