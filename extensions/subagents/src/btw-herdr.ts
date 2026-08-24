import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * By-the-way in a Herdr pane.
 *
 * When this pi session was launched by Herdr (HERDR_ENV=1), `/btw` opens the
 * side agent as a visible pane next to the current one instead of an
 * in-process headless subagent: split the current pane and run a headless
 * `pi -p <prompt>` there, so its work streams into the pane. Any failure
 * reports unavailability and the caller keeps the in-process path.
 */

export interface BtwHerdrPane {
  readonly paneId: string;
}

interface HerdrCliEnvelope {
  readonly error?: unknown;
  readonly result?: HerdrCliEnvelope;
  readonly pane?: { readonly pane_id?: string };
}

const SPLIT_DIRECTION = "right";
const SPLIT_RATIO = "0.45";
const RUN_RETRY_DEADLINE_MS = 15_000;
const RUN_RETRY_DELAY_MS = 500;
const RUN_TIMEOUTS_MS = {
  split: 20_000,
  run: 20_000,
} as const;

/** This pi session was launched by Herdr into a pane with a live socket. */
export function herdrEnvironment(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_PANE_ID &&
    !!process.env.HERDR_SOCKET_PATH
  );
}

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

/** Run a herdr CLI subcommand and parse its JSON envelope. */
function runHerdr(args: string[], timeoutMs: number): Promise<HerdrCliEnvelope> {
  return new Promise((resolve, reject) => {
    const executable = herdrExecutable();
    if (!executable) {
      reject(new Error("herdr executable not found"));
      return;
    }
    const child = spawn(executable, args, { windowsHide: true });
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
            new Error(`herdr returned non-JSON output: ${output.slice(0, 300)}`),
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

/** Shell-quote for the pane shell, which is pwsh (herdr default_shell). */
function shellQuote(value: string): string {
  // Single quotes are literal in pwsh; embedded single quotes are doubled.
  return `'${value.replaceAll("'", "''")}'`;
}

/** Split the current pane and return the new pane id. */
async function splitBtwPane(cwd: string): Promise<string> {
  const current = process.env.HERDR_PANE_ID;
  if (!current) throw new Error("HERDR_PANE_ID is not set");
  const output = await runHerdr(
    [
      "pane",
      "split",
      current,
      "--direction",
      SPLIT_DIRECTION,
      "--ratio",
      SPLIT_RATIO,
      "--cwd",
      cwd,
    ],
    RUN_TIMEOUTS_MS.split,
  );
  const result = output.result ?? output;
  const paneId = result.pane?.pane_id;
  if (!paneId) {
    throw new Error(
      `herdr pane.split returned no pane: ${JSON.stringify(output).slice(0, 300)}`,
    );
  }
  return paneId;
}

/**
 * Run `pi -p '<prompt>'` in the pane, retrying while its shell is still
 * starting up.
 */
async function runBtwAgent(paneId: string, prompt: string): Promise<void> {
  const deadline = Date.now() + RUN_RETRY_DEADLINE_MS;
  for (;;) {
    try {
      await runHerdr(
        ["pane", "run", paneId, "pi", "-p", shellQuote(prompt)],
        RUN_TIMEOUTS_MS.run,
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("agent_pane_busy") || Date.now() >= deadline) {
        throw error;
      }
      await sleep(RUN_RETRY_DELAY_MS);
    }
  }
}

/**
 * Open the by-the-way agent as a Herdr pane next to the current one.
 * Returns undefined when Herdr is not available or the request fails, so
 * callers fall back to the in-process subagent.
 */
export async function tryOpenBtwHerdrPane(options: {
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
}): Promise<BtwHerdrPane | undefined> {
  if (!herdrEnvironment()) return undefined;
  let openedPaneId: string | undefined;
  try {
    openedPaneId = await splitBtwPane(options.cwd);
    await runBtwAgent(openedPaneId, options.prompt);
    return { paneId: openedPaneId };
  } catch (error) {
    // Unavailable or rejected: keep the in-process path. Close the pane we
    // may have opened so a half-started by-the-way does not linger.
    if (openedPaneId) {
      try {
        await runHerdr(["pane", "close", openedPaneId], RUN_TIMEOUTS_MS.split);
      } catch {
        // Best effort; the pane may already be gone.
      }
    }
    console.error(
      `by the way: herdr pane unavailable, falling back: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}