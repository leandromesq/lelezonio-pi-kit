/**
 * Terminal observer coordinator — the thin adapter between the background
 * terminal manager and the shared Herdr worker workspace.
 *
 * For every running terminal with on-disk spill files, it opens an observer
 * pane in the "Pi Workers" workspace's Terminals tab running a native watcher
 * of the spill files (PowerShell Get-Content -Wait / POSIX tail -F). The
 * pane is display-only: the manager stays the sole owner of the process.
 *
 *  - bg_start → attach(): open the observer; Herdr unavailable (or setup
 *    failure) is a silent no-op so the in-session overlay keeps working.
 *  - /ps selecting a terminal → takeOver(): mark the observer taken over and
 *    focus the workspace/pane (the pane survives the terminal's settle).
 *  - terminal settle → settle(): stop only the watcher (ctrl+c); close the
 *    pane unless it was taken over.
 *  - session_shutdown → dispose(): drop the observer bookkeeping; the
 *    workspace itself is closed via the shared controller
 *    (disposeWorkerWorkspace) after the manager disposal.
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
  /** Open the observer pane for a just-started terminal (silent no-op when
   * Herdr is unavailable or the spill files are missing). */
  attach(snap: TerminalSnapshot): Promise<void>;
  /** /ps selection: mark the observer taken over + focus. False when this
   * terminal has no live observer (callers keep the in-session overlay). */
  takeOver(id: string): Promise<boolean>;
  /** The terminal settled: stop only the watcher, close the pane unless
   * taken over. Idempotent. */
  settle(snap: TerminalSnapshot): Promise<void>;
  /** Drop all observer bookkeeping (the shared workspace is closed
   * separately via the singleton). */
  dispose(): Promise<void>;
}

export interface TerminalObserverCoordinatorOptions {
  /** Resolves the shared worker workspace controller for this session. */
  readonly workspace: () => WorkerWorkspaceController | undefined;
  /** Platform override (tests). Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
}

export function createTerminalObserverCoordinator(
  options: TerminalObserverCoordinatorOptions,
): TerminalObserverCoordinator {
  const observers = new Map<string, TerminalObserverHandle>();
  const attaching = new Map<string, Promise<void>>();
  const settledIds = new Set<string>();
  let disposed = false;

  const attach = async (snap: TerminalSnapshot): Promise<void> => {
    // Only running terminals get an observer, and only when the full output
    // is spilled to disk (the watcher tails those files).
    if (disposed || snap.status !== "running" || settledIds.has(snap.id))
      return;
    const stdoutPath = snap.stdout.spillPath;
    const stderrPath = snap.stderr.spillPath;
    if (!stdoutPath || !stderrPath) return;
    const controller = options.workspace();
    if (!controller?.available()) return;
    if (observers.has(snap.id)) return;
    const pending = attaching.get(snap.id);
    if (pending) return pending;
    const opening = (async () => {
      try {
        const observer = await controller.openObserver({
          terminalId: snap.id,
          title: `[${snap.id}] ${snap.title}`,
          cwd: snap.cwd,
          stdoutPath,
          stderrPath,
        });
        if (!observer) return;
        // Settlement can happen while Herdr allocates the pane. Never publish
        // a stale observer after settle() already ran; stop it immediately.
        if (disposed || settledIds.has(snap.id)) await observer.settle();
        else observers.set(snap.id, observer);
      } catch {
        // Observer setup must never fail bg_start; the overlay is the fallback.
      }
    })().finally(() => attaching.delete(snap.id));
    attaching.set(snap.id, opening);
    return opening;
  };

  const takeOver = async (id: string): Promise<boolean> => {
    const observer = observers.get(id);
    if (!observer) return false;
    try {
      return await observer.takeOver();
    } catch {
      return false;
    }
  };

  const settle = async (snap: TerminalSnapshot): Promise<void> => {
    settledIds.add(snap.id);
    await attaching.get(snap.id);
    const observer = observers.get(snap.id);
    if (!observer) return;
    try {
      await observer.settle();
    } catch {
      // Observer teardown is best effort; the terminal has already settled.
    } finally {
      observers.delete(snap.id);
    }
  };

  return {
    attach,
    takeOver,
    settle,
    async dispose() {
      disposed = true;
      await Promise.allSettled(attaching.values());
      await Promise.allSettled(
        [...observers.values()].map((observer) => observer.settle()),
      );
      attaching.clear();
      observers.clear();
      settledIds.clear();
    },
  };
}
