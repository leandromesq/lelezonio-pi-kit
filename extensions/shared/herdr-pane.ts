/**
 * Herdr pane helpers — split/run/close a visual "take over" or by-the-way
 * pane next to the current one, extracted from the subagents extension so all
 * extensions share one reviewed implementation of the Herdr CLI dance.
 *
 * The Herdr CLI discovery/envelopes and the runner live in the deep shared
 * module (extensions/shared/herdr-workspace.ts); this file keeps the pane
 * split/run/close behavior and re-exports the runner for API compatibility
 * (subagents' `/btw` and the takeover host import from here).
 *
 * Everything here is plain Node (no pi imports), so it runs in unit tests.
 * The pane API is the deep seam: tests inject a stub runner/current-pane
 * resolver instead of talking to a live Herdr server.
 */

import {
  herdrEnvironment,
  runHerdr,
  shellQuote,
  type HerdrCliEnvelope,
  type HerdrRunner,
} from "./herdr-workspace.ts";

// Re-exported for existing consumers (subagents /btw, takeover host, tests).
export {
  herdrEnvironment,
  runHerdr,
  shellQuote,
  type HerdrCliEnvelope,
  type HerdrRunner,
};

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

// --- Pane API --------------------------------------------------------------------

export function createHerdrPaneApi(deps?: HerdrPaneDeps): HerdrPaneApi {
  const runner = deps?.runner ?? runHerdr;
  const currentPaneId =
    deps?.currentPaneId ?? (() => process.env.HERDR_PANE_ID);
  const runRetryDeadlineMs = deps?.runRetryDeadlineMs ?? RUN_RETRY_DEADLINE_MS;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

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
