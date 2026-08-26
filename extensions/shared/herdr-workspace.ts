/**
 * Herdr worker workspace — the deep shared module behind running *observable
 * worker panes* (background-terminal tails today; subagents later) inside
 * Herdr.
 *
 * One ephemeral workspace per parent Pi session, created lazily:
 *
 *   label: "Pi Workers · <project> · <short-session>"
 *
 * The workspace's initial tab/root pane becomes the first requested category
 * ("Subagents" or "Terminals"); the second category gets a `tab create`. The
 * first worker of a category runs directly in that tab's root pane; later
 * workers are `pane split`s of the newest pane in the category — no
 * placeholder pane is required. Everything is created with `--no-focus` (a
 * background worker must never steal the user's focus), and closed tabs /
 * workspaces are recreated on the next allocation.
 *
 * All worker panes are plain shell commands run via `pane run` with an
 * explicit launch argv (never `agent start`, which fails for npm shims on
 * Windows), and reported to Herdr as agents via `pane report-agent` +
 * `agent rename` so they show lifecycle state and can be focused/keystroked
 * by pane id later.
 *
 * Observer lifecycle (background terminals): the pane runs a native watcher
 * of the terminal's spill files — PowerShell `Get-Content -LiteralPath
 * <stdout>,<stderr> -Wait` on Windows, `tail -F -- <stdout> <stderr>` on
 * POSIX. On terminal settle the coordinator stops only the watcher (sends
 * ctrl+c); if the user took the pane over it survives at its shell prompt,
 * otherwise it is closed. Target processes stay owned by the extension
 * managers — this module never touches them.
 *
 * Everything here is plain Node (no pi imports), so the controller is
 * unit-testable with an injected CLI runner (see herdr-workspace.test.ts).
 * The CLI runner/envelopes used by extensions/shared/herdr-pane.ts are
 * defined here and re-exported there to keep that module's API compatible
 * for /btw.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Herdr CLI discovery + envelopes (shared with herdr-pane.ts) ---------------

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
  readonly result?: HerdrCliEnvelope & {
    readonly workspace?: { readonly workspace_id?: string };
    readonly tab?: { readonly tab_id?: string };
    readonly root_pane?: { readonly pane_id?: string };
    readonly pane?: { readonly pane_id?: string };
    readonly agent?: {
      readonly state?: string;
      readonly agent_status?: string;
    };
    readonly process_info?: {
      readonly foreground_processes?: ReadonlyArray<{
        readonly name?: string;
      }>;
    };
  };
  readonly workspace?: { readonly workspace_id?: string };
  readonly tab?: { readonly tab_id?: string };
  readonly root_pane?: { readonly pane_id?: string };
  readonly pane?: { readonly pane_id?: string };
  readonly agent?: {
    readonly state?: string;
    readonly agent_status?: string;
  };
  readonly process_info?: {
    readonly foreground_processes?: ReadonlyArray<{
      readonly name?: string;
    }>;
  };
}

/** Run a herdr CLI subcommand and parse its JSON envelope. */
export type HerdrRunner = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<HerdrCliEnvelope>;

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
    const isWindowsShim =
      process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
    // Node cannot CreateProcess a .cmd directly (EINVAL). Route only that
    // fallback through PowerShell's call operator while keeping every CLI
    // argument as a separate process argv value; real herdr.exe stays direct.
    const child = isWindowsShim
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$cmd=$args[0]; $rest=@($args | Select-Object -Skip 1); & $cmd @rest",
            executable,
            ...args,
          ],
          { windowsHide: true },
        )
      : spawn(executable, [...args], { windowsHide: true });
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

/**
 * Shell-quote one token for the pane shell (pwsh on Windows, POSIX sh on
 * the observers). Single quotes are literal in both, but embedded single
 * quotes are ESCAPED differently: pwsh doubles them (`''`), POSIX sh
 * closes-escapes-reopens (`'\''`). The doubled form is NOT portable to
 * POSIX — it would silently drop embedded quotes — so the quote rule is
 * platform-aware and callers pass their platform explicitly (tests).
 */
export function shellQuote(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// --- Worker workspace -----------------------------------------------------------

export type WorkerCategory = "subagents" | "terminals";

/** Lazy tab labels inside the worker workspace, per category. */
export const WORKER_TAB_LABELS: Record<WorkerCategory, string> = {
  subagents: "Subagents",
  terminals: "Terminals",
};

/** Split direction for extra panes, per category (tails read wide; agents tall). */
const SPLIT_DIRECTION: Record<WorkerCategory, "right" | "down"> = {
  subagents: "right",
  terminals: "down",
};

const SPLIT_RATIO = "0.45";
const CLI_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 10_000;
const RUN_RETRY_DEADLINE_MS = 15_000;
const RUN_RETRY_DELAY_MS = 500;
/** Source id used when reporting panes as agents / metadata. */
const AGENT_SOURCE = "pi-workers";

/** "Pi Workers · <project> · <short-session>" — the per-session workspace label. */
export function workspaceLabel(project: string, sessionId: string): string {
  const projectPart = project.replace(/[\r\n]+/g, " ").trim() || "workspace";
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `Pi Workers · ${projectPart} · ${short || "session"}`;
}

export interface WorkerWorkspaceOptions {
  /** Basename used in the workspace label (usually basename of the session cwd). */
  readonly project: string;
  /** Parent pi session id: label component + `--agent-session-id`. */
  readonly sessionId: string;
  /** cwd used to create the workspace and second-category tabs. */
  readonly projectRoot: string;
  /** Injectable CLI runner (tests). Defaults to the real `herdr` binary. */
  readonly runner?: HerdrRunner;
  /** Injectable environment gate (tests). Defaults to herdrEnvironment(). */
  readonly environment?: () => boolean;
  /** Platform override (tests). Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  /** How long `run` retries `agent_pane_busy` (tests pass a small value). */
  readonly runRetryDeadlineMs?: number;
  readonly runRetryDelayMs?: number;
  readonly cliTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export interface WorkerLaunchOptions {
  readonly category: WorkerCategory;
  /** Pane + agent label, e.g. the terminal title. */
  readonly title: string;
  /** cwd the worker pane should start in. */
  readonly cwd: string;
  /** Explicit launch argv, sent via `pane run` (shell-escaped tokens). */
  readonly launch: ReadonlyArray<string>;
  /** Report the pane as a Herdr agent (lifecycle + session identity). */
  readonly agent?: {
    readonly label: string;
    readonly state: "idle" | "working" | "blocked" | "unknown";
    readonly sessionId?: string;
    /**
     * Explicit technical agent name for `agent rename` (already unique,
     * e.g. a parent-session prefix plus the logical subagent id). When
     * omitted the label is slugged with a uniqueness counter.
     */
    readonly name?: string;
  };
}

/** A live worker pane in the shared workspace. */
export interface WorkerPaneHandle {
  readonly paneId: string;
  readonly category: WorkerCategory;
  readonly tabId: string;
  readonly workspaceId: string;
  /** `pane run` — run another command in this pane (retries agent_pane_busy). */
  run(args: ReadonlyArray<string>): Promise<void>;
  /** `pane send-keys` — e.g. ctrl+c to stop an observer watcher. */
  sendKeys(...keys: string[]): Promise<void>;
  /** `pane rename` — relabel the pane. */
  rename(label: string): Promise<void>;
  /**
   * Submit text plus Enter to the pane's agent via the LOW-LEVEL transport:
   * `pane send-text <pane> <text>` then `pane send-keys <pane> enter`.
   * `agent prompt` is deliberately NOT used — live spikes proved it fails
   * for manually reported explicit-node Pi agents
   * (`agent_not_ready: no longer pane foreground process`), while
   * send-text + enter is reliable. Retries are bounded and confined to
   * transient pane-busy errors (shell/TUI still booting); real failures
   * surface immediately. Submits without waiting for a settled state
   * (completion is driven by the caller's own watchers).
   */
  submitText(text: string): Promise<void>;
  /**
   * `pane report-agent` — update the reported lifecycle state of this
   * agent pane (working/idle) so Herdr's sidebar and waits stay truthful.
   */
  reportState(
    state: "idle" | "working" | "blocked" | "unknown",
    message?: string,
  ): Promise<void>;
  /**
   * `agent get` — the live lifecycle state Herdr attributes to this pane
   * (idle/done/working/blocked/unknown). Undefined when the agent is gone
   * (the pane no longer hosts our agent or the CLI lookup failed) — used
   * by liveness watchdogs for worker TUIs.
   */
  getAgentState(): Promise<string | undefined>;
  /** Whether a non-shell foreground process still owns the worker pane.
   * Undefined means the liveness probe itself failed and must not settle. */
  isWorkerRunning?(): Promise<boolean | undefined>;
  /** `pane report-metadata` — display-only metadata for this pane. */
  reportMetadata(options: {
    readonly title?: string;
    readonly displayAgent?: string;
    readonly summary?: string;
  }): Promise<void>;
  /** Focus the workspace, then the tab, then this pane (take-over entry). */
  focus(): Promise<void>;
  /** Close the pane, best effort and bounded. */
  close(): Promise<void>;
}

/**
 * Observer lifecycle for one watched terminal. The pane runs a tail of the
 * terminal's spill files; settling the terminal stops only the watcher and
 * closes the pane unless the user took it over (then the pane survives at
 * its shell prompt with the output visible).
 */
export interface TerminalObserverHandle {
  readonly terminalId: string;
  readonly pane: WorkerPaneHandle;
  /** True once the user took the pane over (it must survive settle). */
  readonly takenOver: boolean;
  /** Stop the watcher (ctrl+c); close the pane unless taken over. */
  settle(): Promise<void>;
  /** Mark taken over and focus the pane. False when the pane is already gone. */
  takeOver(): Promise<boolean>;
}

export interface WorkerWorkspaceController {
  /** True when this process runs inside Herdr with a live CLI available. */
  available(): boolean;
  /**
   * Lazily create the shared workspace for this session (idempotent; a
   * closed workspace is recreated). Resolves the workspace id, undefined
   * when Herdr is unavailable.
   */
  ensureWorkspace(): Promise<string | undefined>;
  /**
   * Allocate a worker pane (tab + split as needed), run its launch command,
   * report it as an agent, and roll the pane back on failure. Returns
   * undefined when Herdr is unavailable or creation fails so callers keep
   * their in-session fallback.
   */
  openWorker(
    options: WorkerLaunchOptions,
  ): Promise<WorkerPaneHandle | undefined>;
  /** Open an observer pane for a watched terminal (tail of its spill files). */
  openObserver(options: {
    readonly terminalId: string;
    readonly title: string;
    readonly cwd: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
  }): Promise<TerminalObserverHandle | undefined>;
  /** Focus the whole workspace (take-over entry). */
  focusWorkspace(): Promise<void>;
  /** Close the workspace, best effort and bounded. Idempotent. */
  dispose(): Promise<void>;
  readonly workspaceId: string | undefined;
}

interface ControllerState {
  workspaceId?: string;
  initialTabId?: string;
  initialRootPane?: string;
  initialTabClaimed: boolean;
  tabIdByCategory: Map<WorkerCategory, string>;
  rootPaneByCategory: Map<WorkerCategory, string>;
  lastPaneByCategory: Map<WorkerCategory, string>;
  panesByCategory: Map<WorkerCategory, string[]>;
  usedAgentNames: Set<string>;
  disposed: boolean;
} /** Native watcher argv for the given spill files (Windows/POSIX). */
export function observerCommand(
  stdoutPath: string,
  stderrPath: string,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  if (platform === "win32") {
    const paths = [stdoutPath, stderrPath]
      .map((p) => shellQuote(p, platform))
      .join(",");
    const script = `$paths=@(${paths}); $jobs=@($paths | ForEach-Object { Start-Job -ScriptBlock { param($p) Get-Content -LiteralPath $p -Wait } -ArgumentList $_ }); Receive-Job -Job $jobs -Wait -AutoRemoveJob`;
    return [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      shellQuote(script, platform),
    ];
  }
  return [
    "tail",
    "-F",
    "--",
    shellQuote(stdoutPath, platform),
    shellQuote(stderrPath, platform),
  ];
}

export function createWorkerWorkspaceController(
  options: WorkerWorkspaceOptions,
): WorkerWorkspaceController {
  const runner = options.runner ?? runHerdr;
  const environment = options.environment ?? herdrEnvironment;
  const platform = options.platform ?? process.platform;
  const runRetryDeadlineMs =
    options.runRetryDeadlineMs ?? RUN_RETRY_DEADLINE_MS;
  const runRetryDelayMs = options.runRetryDelayMs ?? RUN_RETRY_DELAY_MS;
  const cliTimeoutMs = options.cliTimeoutMs ?? CLI_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  const sessionId = options.sessionId;
  const label = workspaceLabel(options.project, options.sessionId);
  const state: ControllerState = {
    initialTabClaimed: false,
    tabIdByCategory: new Map(),
    rootPaneByCategory: new Map(),
    lastPaneByCategory: new Map(),
    panesByCategory: new Map(),
    usedAgentNames: new Set(),
    disposed: false,
  };

  const call = (args: ReadonlyArray<string>, timeoutMs: number) =>
    runner(args, timeoutMs);

  /** Hermes server errors mention the dead resource; treat as rebuildable. */
  const isMissingResource = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const resource = "(?:pane|tab|workspace|agent)";
    const missing = "(?:not found|does not exist|no such|closed|gone)";
    const wasMissing = `(?:was|is)\\s+(?:already\\s+)?(?:${missing})\\b`;
    return new RegExp(
      `(?:\\b${resource}\\s+(?:already\\s+)?${missing}\\b|\\b${missing}\\s+${resource}\\b|\\b${resource}\\s+${wasMissing})`,
      "i",
    ).test(message);
  };

  const resultOf = (output: HerdrCliEnvelope) => output.result ?? output;

  const readWorkspaceId = (output: HerdrCliEnvelope) =>
    resultOf(output).workspace?.workspace_id;
  const readTabId = (output: HerdrCliEnvelope) => resultOf(output).tab?.tab_id;
  const readRootPaneId = (output: HerdrCliEnvelope) =>
    resultOf(output).root_pane?.pane_id;
  const readPaneId = (output: HerdrCliEnvelope) =>
    resultOf(output).pane?.pane_id;

  /** In-flight workspace creation so concurrent allocators share one. */
  let workspacePromise: Promise<string | undefined> | undefined;
  /** Per-category allocation chains so parallel openers never share a pane. */
  const allocationChains = new Map<
    WorkerCategory,
    Promise<string | undefined>
  >();

  // --- workspace / tab lifecycle ---------------------------------------------

  const doEnsureWorkspace = async (): Promise<string | undefined> => {
    if (state.disposed) return undefined;
    if (state.workspaceId) return state.workspaceId;
    if (!environment()) return undefined;
    const output = await call(
      [
        "workspace",
        "create",
        "--cwd",
        options.projectRoot,
        "--label",
        label,
        "--no-focus",
      ],
      cliTimeoutMs,
    );
    const workspaceId = readWorkspaceId(output);
    const tabId = readTabId(output);
    const rootPane = readRootPaneId(output);
    if (!workspaceId || !tabId || !rootPane) {
      throw new Error(
        `herdr workspace.create returned no ids: ${JSON.stringify(output).slice(0, 300)}`,
      );
    }
    state.workspaceId = workspaceId;
    state.initialTabId = tabId;
    state.initialRootPane = rootPane;
    // A dispose raced this create (session shutdown): never leave the
    // workspace behind — close it and report unavailable.
    if (state.disposed) {
      state.workspaceId = undefined;
      state.initialTabId = undefined;
      state.initialRootPane = undefined;
      await closeBounded(["workspace", "close", workspaceId]);
      return undefined;
    }
    return workspaceId;
  };

  /** Lazily create the workspace; concurrent callers share one attempt. */
  const ensureWorkspace = (): Promise<string | undefined> => {
    if (state.workspaceId) return Promise.resolve(state.workspaceId);
    workspacePromise ??= doEnsureWorkspace().finally(() => {
      workspacePromise = undefined;
    });
    return workspacePromise;
  };

  /** Resolve (or lazily create) the category tab; uses the workspace's
   * initial tab for the first category, `tab create` for the second. */
  const ensureTab = async (
    category: WorkerCategory,
  ): Promise<string | undefined> => {
    const cached = state.tabIdByCategory.get(category);
    if (cached) return cached;
    const workspaceId = await ensureWorkspace();
    if (!workspaceId) return undefined;
    if (
      !state.initialTabClaimed &&
      state.initialTabId &&
      state.initialRootPane
    ) {
      // First category claims the workspace's initial tab + root pane.
      state.initialTabClaimed = true;
      const tabId = state.initialTabId;
      const rootPane = state.initialRootPane;
      state.tabIdByCategory.set(category, tabId);
      state.rootPaneByCategory.set(category, rootPane);
      // Renaming is cosmetic; a failure must not block the worker.
      await call(
        ["tab", "rename", tabId, WORKER_TAB_LABELS[category]],
        cliTimeoutMs,
      ).catch(() => {});
      return tabId;
    }
    const output = await call(
      [
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--cwd",
        options.projectRoot,
        "--label",
        WORKER_TAB_LABELS[category],
        "--no-focus",
      ],
      cliTimeoutMs,
    );
    const tabId = readTabId(output);
    const rootPane = readRootPaneId(output);
    if (!tabId || !rootPane) {
      throw new Error(
        `herdr tab.create returned no ids: ${JSON.stringify(output).slice(0, 300)}`,
      );
    }
    state.tabIdByCategory.set(category, tabId);
    state.rootPaneByCategory.set(category, rootPane);
    return tabId;
  };

  /** Allocate the next pane in a category: the tab's root pane hosts the
   * first worker; later workers split the newest pane. Serializable so
   * parallel openers never run two workers into the same pane. */
  const allocatePaneOnce = async (
    category: WorkerCategory,
    cwd: string,
  ): Promise<string | undefined> => {
    const tabId = await ensureTab(category);
    if (!tabId) return undefined;
    const root = state.rootPaneByCategory.get(category);
    const last = state.lastPaneByCategory.get(category);
    if (!last) {
      if (!root) return undefined;
      state.lastPaneByCategory.set(category, root);
      state.panesByCategory.set(category, [root]);
      return root;
    }
    const output = await call(
      [
        "pane",
        "split",
        last,
        "--direction",
        SPLIT_DIRECTION[category],
        "--ratio",
        SPLIT_RATIO,
        "--cwd",
        cwd,
        "--no-focus",
      ],
      cliTimeoutMs,
    );
    const paneId = readPaneId(output);
    if (!paneId) {
      throw new Error(
        `herdr pane.split returned no pane: ${JSON.stringify(output).slice(0, 300)}`,
      );
    }
    state.lastPaneByCategory.set(category, paneId);
    const panes = state.panesByCategory.get(category) ?? [];
    panes.push(paneId);
    state.panesByCategory.set(category, panes);
    return paneId;
  };

  const allocatePane = (category: WorkerCategory, cwd: string) => {
    const previous =
      allocationChains.get(category) ?? Promise.resolve(undefined);
    const next = previous
      .catch(() => undefined)
      .then(() => allocatePaneOnce(category, cwd));
    allocationChains.set(
      category,
      next.catch(() => undefined),
    );
    return next;
  };

  // --- low-level pane commands --------------------------------------------------

  const runWithRetry = async (args: ReadonlyArray<string>): Promise<void> => {
    const deadline = Date.now() + runRetryDeadlineMs;
    for (;;) {
      try {
        await call(args, cliTimeoutMs);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("agent_pane_busy") || Date.now() >= deadline) {
          throw error;
        }
        await sleep(runRetryDelayMs);
      }
    }
  };

  /** Send text into a pane, retrying only while the pane shell is still
   * booting (`agent_pane_busy`). Other failures (e.g. `agent_not_ready`)
   * are permanent — retrying them would type into the wrong place. */
  const sendTextWithRetry = async (
    paneId: string,
    text: string,
  ): Promise<void> => {
    const deadline = Date.now() + runRetryDeadlineMs;
    for (;;) {
      try {
        await call(["pane", "send-text", paneId, text], cliTimeoutMs);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("agent_pane_busy") || Date.now() >= deadline) {
          throw error;
        }
        await sleep(runRetryDelayMs);
      }
    }
  };

  const closeBounded = async (args: ReadonlyArray<string>): Promise<void> => {
    await Promise.race([
      call(args, closeTimeoutMs),
      sleep(closeTimeoutMs).then(() => {
        throw new Error("herdr close timed out");
      }),
    ]).catch(() => {});
  };

  const closePane = (paneId: string) => closeBounded(["pane", "close", paneId]);

  const slugAgentName = (label: string) => {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "worker";
    let name = base;
    let counter = 1;
    while (state.usedAgentNames.has(name)) {
      const suffix = String(counter++);
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    state.usedAgentNames.add(name);
    return name;
  };

  const reportAgent = async (
    paneId: string,
    agent: NonNullable<WorkerLaunchOptions["agent"]>,
  ) => {
    const args = [
      "pane",
      "report-agent",
      paneId,
      "--source",
      AGENT_SOURCE,
      "--agent",
      agent.label,
      "--state",
      agent.state,
    ];
    if (agent.sessionId) args.push("--agent-session-id", agent.sessionId);
    await call(args, cliTimeoutMs);
    // A stable unique name lets later `agent focus/prompt/send-keys` target
    // this worker by name without pane-id lock-in. Cosmetic: a rename
    // failure keeps the pane. The explicit name already encodes the parent
    // session prefix, so the uniqueness counter only ever kicks in as a
    // last-resort collision guard.
    const name = agent.name ?? slugAgentName(agent.label);
    await call(["agent", "rename", paneId, name], cliTimeoutMs).catch(() => {});
  };

  const openWorkerOnce = async (
    options: WorkerLaunchOptions,
  ): Promise<WorkerPaneHandle | undefined> => {
    if (state.disposed || !environment()) return undefined;
    const tabId = await ensureTab(options.category);
    if (!tabId) return undefined;
    let paneId: string | undefined;
    try {
      paneId = (await allocatePane(options.category, options.cwd)) ?? undefined;
      if (!paneId) return undefined;
      const allocatedPaneId = paneId;
      const agentLabel = options.agent?.label ?? options.title;
      await call(
        ["pane", "rename", allocatedPaneId, options.title],
        cliTimeoutMs,
      );
      // Report/rename the pane before dispatching the worker command. Once
      // pane.run succeeds real work may already have started, so no fallible
      // setup step may remain that could trigger an in-process fallback and
      // duplicate the task.
      if (options.agent) await reportAgent(allocatedPaneId, options.agent);
      await runWithRetry(["pane", "run", allocatedPaneId, ...options.launch]);
      return {
        paneId: allocatedPaneId,
        category: options.category,
        tabId,
        workspaceId: state.workspaceId ?? "",
        run: (args) => runWithRetry(["pane", "run", allocatedPaneId, ...args]),
        sendKeys: async (...keys) => {
          await call(
            ["pane", "send-keys", allocatedPaneId, ...keys],
            cliTimeoutMs,
          );
        },
        rename: async (next) => {
          await call(["pane", "rename", allocatedPaneId, next], cliTimeoutMs);
        },
        submitText: async (text) => {
          // Low-level transport (live-proven): type the text, then Enter.
          // Once send-text delivered, the text sits in the input box —
          // retrying the PAIR would double-type it. Only the Enter key is
          // retried, boundedly and only on transient pane-busy errors.
          await sendTextWithRetry(allocatedPaneId, text);
          const enterDeadline = Date.now() + runRetryDeadlineMs;
          for (;;) {
            try {
              await call(
                ["pane", "send-keys", allocatedPaneId, "enter"],
                cliTimeoutMs,
              );
              return;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              if (
                !message.includes("agent_pane_busy") ||
                Date.now() >= enterDeadline
              ) {
                throw error;
              }
              await sleep(runRetryDelayMs);
            }
          }
        },
        reportState: async (state, message) => {
          const args = [
            "pane",
            "report-agent",
            allocatedPaneId,
            "--source",
            AGENT_SOURCE,
            "--agent",
            agentLabel,
            "--state",
            state,
          ];
          if (message !== undefined) args.push("--message", message);
          await call(args, cliTimeoutMs);
        },
        getAgentState: async () => {
          const output = await call(
            ["agent", "get", allocatedPaneId],
            cliTimeoutMs,
          ).catch(() => undefined);
          const agent = output ? resultOf(output).agent : undefined;
          const lifecycle = agent?.agent_status ?? agent?.state;
          return typeof lifecycle === "string" ? lifecycle : undefined;
        },
        isWorkerRunning: async () => {
          let output: HerdrCliEnvelope;
          try {
            output = await call(
              ["pane", "process-info", "--pane", allocatedPaneId],
              cliTimeoutMs,
            );
          } catch (error) {
            // A confirmed missing/closed pane is a terminal liveness result;
            // transport and timeout failures remain unknown and must not
            // falsely settle a healthy worker.
            return isMissingResource(error) ? false : undefined;
          }
          const processes = resultOf(output).process_info?.foreground_processes;
          if (!processes) return undefined;
          return processes.some((process) => {
            const name = process.name ?? "";
            return !/^(?:pwsh|powershell|cmd|sh|bash|zsh|fish|dash|ksh)(?:\.exe)?$/i.test(
              name,
            );
          });
        },
        reportMetadata: async ({ title, displayAgent, summary }) => {
          const args = ["pane", "report-metadata", allocatedPaneId];
          if (title !== undefined) args.push("--title", title);
          if (displayAgent !== undefined)
            args.push("--display-agent", displayAgent);
          if (summary !== undefined) args.push("--token", `summary=${summary}`);
          args.push("--source", AGENT_SOURCE);
          await call(args, cliTimeoutMs);
        },
        focus: async () => {
          if (!state.workspaceId) return;
          await call(
            ["workspace", "focus", state.workspaceId],
            cliTimeoutMs,
          ).catch(() => {});
          await call(["tab", "focus", tabId], cliTimeoutMs).catch(() => {});
          // agent focus accepts pane ids; best effort, never steals into a
          // closed pane.
          await call(["agent", "focus", allocatedPaneId], cliTimeoutMs);
        },
        close: async () => {
          await closePane(allocatedPaneId);
          const panes = state.panesByCategory.get(options.category) ?? [];
          const remaining = panes.filter((id) => id !== allocatedPaneId);
          if (remaining.length === 0) {
            dropCategory(options.category);
          } else {
            state.panesByCategory.set(options.category, remaining);
            if (
              state.lastPaneByCategory.get(options.category) === allocatedPaneId
            ) {
              state.lastPaneByCategory.set(options.category, remaining.at(-1)!);
            }
            if (
              state.rootPaneByCategory.get(options.category) === allocatedPaneId
            ) {
              state.rootPaneByCategory.set(options.category, remaining[0]!);
            }
          }
        },
      };
    } catch (error) {
      // Roll back the half-opened pane; the tab/workspace stay for reuse.
      // Active-pane tracking must not leave the closed pane as the next
      // split target or the category's root. Closing a split only drops it
      // as the newest pane (the previous newest becomes the split target);
      // closing the root pane kills its tab, so the whole category must be
      // re-created (and the initial-tab claim released) on the next open.
      if (paneId) {
        await closePane(paneId);
        const panes = state.panesByCategory.get(options.category) ?? [];
        const remaining = panes.filter((id) => id !== paneId);
        state.panesByCategory.set(options.category, remaining);
        if (state.lastPaneByCategory.get(options.category) === paneId) {
          const previous = remaining.at(-1);
          if (previous)
            state.lastPaneByCategory.set(options.category, previous);
          else state.lastPaneByCategory.delete(options.category);
        }
        if (state.rootPaneByCategory.get(options.category) === paneId) {
          dropCategory(options.category);
        }
      }
      throw error;
    }
  };

  /** Drop one category's cached tab/root/newest-pane ids and release the
   * initial-tab claim when the destroyed tab WAS the initial one. Other
   * categories (and any taken-over panes in them) are untouched. */
  const dropCategory = (category: WorkerCategory) => {
    const tabId = state.tabIdByCategory.get(category);
    state.tabIdByCategory.delete(category);
    state.rootPaneByCategory.delete(category);
    state.lastPaneByCategory.delete(category);
    state.panesByCategory.delete(category);
    if (tabId !== undefined && state.initialTabId === tabId) {
      state.initialTabId = undefined;
      state.initialRootPane = undefined;
      state.initialTabClaimed = false;
    }
  };

  /** The whole workspace is gone: close it (bounded; a no-op when the user
   * already closed it) so a fresh workspace can never leak alongside it,
   * and forget every cached id. */
  const dropWorkspace = async (workspaceId: string | undefined) => {
    state.workspaceId = undefined;
    state.initialTabId = undefined;
    state.initialRootPane = undefined;
    state.initialTabClaimed = false;
    state.tabIdByCategory.clear();
    state.rootPaneByCategory.clear();
    state.lastPaneByCategory.clear();
    if (workspaceId) await closeBounded(["workspace", "close", workspaceId]);
  };

  const openWorker = async (
    options: WorkerLaunchOptions,
  ): Promise<WorkerPaneHandle | undefined> => {
    if (state.disposed || !environment()) return undefined;
    try {
      return await openWorkerOnce(options);
    } catch (error) {
      if (isMissingResource(error)) {
        // A user-closed tab/pane reports "not found". Rebuild ONLY the
        // affected category in the CURRENT workspace and retry once — the
        // other categories (and any taken-over panes) keep living.
        dropCategory(options.category);
        try {
          return await openWorkerOnce(options);
        } catch (secondError) {
          if (isMissingResource(secondError)) {
            // The workspace itself is gone (the category could not be
            // recreated): close the abandoned workspace so no duplicate
            // "Pi Workers" workspace leaks behind, then rebuild fresh.
            await dropWorkspace(state.workspaceId);
            try {
              return await openWorkerOnce(options);
            } catch {
              return undefined;
            }
          }
          return undefined;
        }
      }
      return undefined;
    }
  };

  const openObserver = async (options: {
    readonly terminalId: string;
    readonly title: string;
    readonly cwd: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
  }): Promise<TerminalObserverHandle | undefined> => {
    const pane = await openWorker({
      category: "terminals",
      title: options.title,
      cwd: options.cwd,
      launch: [
        ...observerCommand(options.stdoutPath, options.stderrPath, platform),
      ],
      agent: {
        label: options.title,
        state: "idle",
        sessionId: sessionId || undefined,
      },
    });
    if (!pane) return undefined;
    let settled = false;
    let takenOver = false;
    let takeoverInFlight: Promise<boolean> | undefined;
    return {
      terminalId: options.terminalId,
      pane,
      get takenOver() {
        return takenOver;
      },
      async settle() {
        if (settled) return;
        settled = true;
        // Stop only the watcher (tail/Get-Content -Wait), never the target.
        await pane.sendKeys("ctrl+c").catch(() => {});
        await takeoverInFlight;
        if (!takenOver) await pane.close().catch(() => {});
      },
      takeOver() {
        if (takeoverInFlight) return takeoverInFlight;
        if (takenOver) return Promise.resolve(true);
        if (settled) return Promise.resolve(false); // pane is already gone
        takeoverInFlight = (async () => {
          takenOver = true;
          try {
            await pane.focus();
            return true;
          } catch {
            takenOver = false;
            return false;
          }
        })().finally(() => {
          takeoverInFlight = undefined;
        });
        return takeoverInFlight;
      },
    };
  };

  const controller: WorkerWorkspaceController = {
    available: () => environment(),
    ensureWorkspace: () => ensureWorkspace(),
    openWorker,
    openObserver,
    async focusWorkspace() {
      const workspaceId = state.workspaceId;
      if (workspaceId)
        await call(["workspace", "focus", workspaceId], cliTimeoutMs).catch(
          () => {},
        );
    },
    async dispose() {
      if (state.disposed) return;
      state.disposed = true;
      const workspaceId = state.workspaceId;
      state.workspaceId = undefined;
      state.initialTabId = undefined;
      state.initialRootPane = undefined;
      state.tabIdByCategory.clear();
      state.rootPaneByCategory.clear();
      state.lastPaneByCategory.clear();
      state.panesByCategory.clear();
      state.usedAgentNames.clear();
      if (workspaceId) {
        await closeBounded(["workspace", "close", workspaceId]);
      }
    },
    get workspaceId() {
      return state.workspaceId;
    },
  };
  return controller;
}

// --- Process-wide singleton (one workspace per parent pi session) ---------------

/** Pi loads extensions independently, so the same shared source can exist as
 * more than one ESM module instance. Module-local state therefore creates one
 * workspace per extension. Symbol.for anchors the registry on the process
 * global object, making every copy converge on the same controller. */
const WORKSPACE_REGISTRY = Symbol.for("lelezonio.pi.worker-workspace");
interface WorkspaceRegistry {
  controller?: WorkerWorkspaceController;
  sessionKey?: string;
  disposed: WeakSet<WorkerWorkspaceController>;
}
const processGlobal = globalThis as typeof globalThis & {
  [WORKSPACE_REGISTRY]?: WorkspaceRegistry;
};
const registry = (processGlobal[WORKSPACE_REGISTRY] ??= {
  disposed: new WeakSet<WorkerWorkspaceController>(),
});

/**
 * The shared worker workspace for the current pi session (created lazily on
 * first use). Both the subagents and background-terminals extensions call
 * this during session_start and allocate into the same workspace so a
 * session never ends up with more than one "Pi Workers" workspace. After
 * disposal (session shutdown) the next call creates a fresh controller.
 */
export function workerWorkspaceForSession(
  project: string,
  sessionId: string,
  projectRoot: string,
): WorkerWorkspaceController {
  const sessionKey = `${sessionId}\0${path.resolve(projectRoot)}`;
  const existing = registry.controller;
  if (
    existing &&
    registry.sessionKey === sessionKey &&
    !registry.disposed.has(existing)
  ) {
    return existing;
  }
  if (existing && !registry.disposed.has(existing)) {
    registry.disposed.add(existing);
    void existing.dispose();
  }
  const created = createWorkerWorkspaceController({
    project,
    sessionId,
    projectRoot,
  });
  registry.controller = created;
  registry.sessionKey = sessionKey;
  return created;
}

/**
 * Parent shutdown cleanup: close the workspace (bounded). Idempotent and
 * order-independent — whichever of the subagents/background-terminals
 * session_shutdown handlers runs first closes the shared workspace; the
 * second handler's call is a no-op. Targets keep running until the
 * workspace actually closes (taken-over panes survive until then).
 */
export function disposeWorkerWorkspace(): Promise<void> {
  const workspace = registry.controller;
  registry.controller = undefined;
  registry.sessionKey = undefined;
  if (!workspace) return Promise.resolve();
  registry.disposed.add(workspace);
  return workspace.dispose();
}

/** Test seam: replace the singleton so UI entry points are testable. */
export function setWorkerWorkspaceForTests(
  controller: WorkerWorkspaceController | undefined,
): void {
  registry.controller = controller;
  registry.sessionKey = controller ? "test" : undefined;
}
