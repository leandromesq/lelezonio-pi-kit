/**
 * Terminal observer coordinator — the thin adapter between the background
 * terminal manager and the shared Herdr worker workspace.
 *
 * For every running terminal with on-disk spill files, it opens an observer
 * pane in the "Pi Workers" workspace's Terminals tab running a native watcher
 * of the spill files (PowerShell Get-Content -Wait / POSIX tail -F). The
 * pane is display-only: the manager stays the sole owner of the process.
 *
 *  - bg_start → attach(): schedule the observer open and return IMMEDIATELY.
 *    Visualization is optional; it must never sit on the launch critical
 *    path. The open stays tracked (settle/take-over join it, dispose awaits
 *    it under a bound) and is abandoned after a total deadline, with a late
 *    pane stopped instead of leaked.
 *  - /ps selecting a terminal → takeOver(): join an in-flight attachment,
 *    then mark the observer taken over and focus the workspace/pane (the
 *    pane survives the terminal's settle).
 *  - terminal settle → settle(): stop only the watcher (ctrl+c); close the
 *    pane unless it was taken over.
 *  - session_shutdown → dispose(): stop tracking, settle every observer and
 *    any late pane, bounded; the workspace itself is closed via the shared
 *    controller (disposeWorkerWorkspace) after the manager disposal.
 *
 * Plain Node, no pi imports — fully unit-testable with an injected
 * controller.
 */

import type {
  TerminalObserverHandle,
  WorkerWorkspaceController,
} from "../../shared/herdr-workspace.ts";
import type { TerminalSnapshot } from "./domain.ts";

export interface TerminalObserverCoordinator {
  /**
   * Schedule the observer pane for a just-started terminal. Returns
   * immediately: the open is tracked in the background (join it via
   * takeOver/settle/dispose). Silent no-op when Herdr is unavailable, the
   * spill files are missing, or the terminal is already settled.
   */
  attach(snap: TerminalSnapshot): void;
  /** /ps selection: join a pending attach, then mark the observer taken over
   * + focus. False when this terminal has no live observer (callers keep the
   * in-session overlay). */
  takeOver(id: string): Promise<boolean>;
  /** The terminal settled: stop only the watcher, close the pane unless
   * taken over. Idempotent. */
  settle(snap: TerminalSnapshot): Promise<void>;
  /** Drop all observer bookkeeping (the shared workspace is closed
   * separately via the singleton). Bounded. */
  dispose(): Promise<void>;
}

export interface TerminalObserverCoordinatorOptions {
  /** Resolves the shared worker workspace controller for this session. */
  readonly workspace: () => WorkerWorkspaceController | undefined;
  /** Platform override (tests). Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  /**
   * Total deadline for one observer attachment (open + publish). After it
   * the attachment stops blocking callers; a pane that arrives later is
   * settled instead of published. Tests pass a small value.
   */
  readonly attachTimeoutMs?: number;
  /** Bound for dispose() while it joins in-flight attachments. */
  readonly disposeTimeoutMs?: number;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 20_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

/** Resolve when every promise settles OR the deadline passes, never reject. */
async function settleWithin(
  promises: ReadonlyArray<Promise<unknown>>,
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createTerminalObserverCoordinator(
  options: TerminalObserverCoordinatorOptions,
): TerminalObserverCoordinator {
  const attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const disposeTimeoutMs =
    options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
  const observers = new Map<string, TerminalObserverHandle>();
  /** In-flight opens, keyed by terminal id (joinable, bounded). */
  const attaching = new Map<string, Promise<void>>();
  /**
   * Ids whose attachment stopped being awaited (deadline or dispose) while
   * its Herdr open is still running. A late pane for one of these is settled
   * on arrival; re-attaching is refused until the open itself finishes.
   */
  const abandoned = new Set<string>();
  const settledIds = new Set<string>();
  let disposed = false;

  const beginAttach = (
    snap: TerminalSnapshot,
    controller: WorkerWorkspaceController,
  ): Promise<void> => {
    const id = snap.id;
    let expired = false;
    const opening = (async () => {
      try {
        return await controller.openObserver({
          terminalId: id,
          title: `[${id}] ${snap.title}`,
          cwd: snap.cwd,
          stdoutPath: snap.stdout.spillPath!,
          stderrPath: snap.stderr.spillPath!,
        });
      } catch {
        // Observer setup must never affect the terminal; the overlay is the
        // fallback. Errors are silently dropped (the open is optional).
        return undefined;
      }
    })().finally(() => {
      abandoned.delete(id);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        abandoned.add(id);
        resolve();
      }, attachTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    // Never rejects: publish() swallows the open/settle failures itself.
    const publish = opening.then(async (observer) => {
      if (!observer) return;
      // Settlement, shutdown, or the attach deadline can all land while
      // Herdr is still allocating. Never publish a stale observer — stop it.
      if (expired || disposed || settledIds.has(id)) {
        await observer.settle().catch(() => {});
        return;
      }
      observers.set(id, observer);
    });
    let tracked: Promise<void>;
    tracked = Promise.race([publish, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      if (attaching.get(id) === tracked) attaching.delete(id);
    });
    return tracked;
  };

  return {
    attach(snap: TerminalSnapshot): void {
      // Only running terminals get an observer, and only when the full output
      // is spilled to disk (the watcher tails those files).
      if (disposed || snap.status !== "running" || settledIds.has(snap.id))
        return;
      const stdoutPath = snap.stdout.spillPath;
      const stderrPath = snap.stderr.spillPath;
      if (!stdoutPath || !stderrPath) return;
      const controller = options.workspace();
      if (!controller?.available()) return;
      if (
        observers.has(snap.id) ||
        attaching.has(snap.id) ||
        abandoned.has(snap.id)
      )
        return;
      // Start now, return now: the caller (bg_start) must not wait for a
      // display pane that may take seconds to open.
      attaching.set(snap.id, beginAttach(snap, controller));
    },

    async takeOver(id: string): Promise<boolean> {
      // A /ps selection may arrive while the pane is still opening: join the
      // in-flight attachment instead of reporting "no observer" and falling
      // back to the overlay.
      const pending = attaching.get(id);
      if (pending) await pending;
      const observer = observers.get(id);
      if (!observer) return false;
      try {
        return await observer.takeOver();
      } catch {
        return false;
      }
    },

    async settle(snap: TerminalSnapshot): Promise<void> {
      settledIds.add(snap.id);
      const pending = attaching.get(snap.id);
      if (pending) await pending;
      const observer = observers.get(snap.id);
      if (!observer) return;
      try {
        await observer.settle();
      } catch {
        // Observer teardown is best effort; the terminal has already settled.
      } finally {
        observers.delete(snap.id);
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      await settleWithin([...attaching.values()], disposeTimeoutMs);
      await settleWithin(
        [...observers.values()].map((observer) => observer.settle()),
        disposeTimeoutMs,
      );
      attaching.clear();
      observers.clear();
      settledIds.clear();
      // `abandoned` ids keep their late-open cleanup; the set clears itself
      // when each open settles.
    },
  };
}
