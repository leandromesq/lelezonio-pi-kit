import { type Config, DEFAULTS, loadConfig } from "./config.js";
import type { RawObservation } from "./spawn/runs.js";
import { KILL_ESCALATION_MS } from "./spawn/launch.js";
import { StatusController } from "./ui/status-controller.js";

/**
 * Max time `session_shutdown` waits for tracked worker processes to settle. Must exceed the
 * SIGTERM→SIGKILL escalation so the kill timer actually fires before Pi leaves the hook; with a
 * shorter bound Pi would exit and orphan the still-running worker subprocesses.
 */
export const SHUTDOWN_DRAIN_MS = KILL_ESCALATION_MS + 2_000;

/**
 * One entry in the ordered observer pipeline. A chunk is `running` until its worker settles;
 * then it carries `result` until it is committed. Commits advance the coverage frontier only
 * contiguously, so a later successful chunk never jumps an earlier failed/unobserved one.
 */
export interface PendingObserver {
	runId: string;
	controller: AbortController;
	/** Coverage id immediately before this chunk (undefined for the first chunk after start). */
	afterEntryId: string | undefined;
	/** This chunk's end (its eventual coverage watermark). */
	coversUpToId: string;
	/** Last source-entry timestamp, used as the observation id fallback anchor. */
	lastEntryTimestamp: string | undefined;
	/** Chunk token size, for the finish toast. */
	sliceTokens: number;
	/** Set once the worker completed with a durable acknowledgement (observations may be empty). */
	result?: { observations: RawObservation[] };
}

/**
 * In-process orchestrator state. Event-driven only — no daemon/timer beyond the status
 * spinner. Ephemeral: rebuilt on session_start, cleared on session_shutdown.
 */
export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;

	/** The per-session on/off gate (default OFF). Outermost guard in every handler. */
	enabled = false;

	/**
	 * Monotonic epoch for the active branch/gate. Bumped on session_start, session_tree, gate
	 * changes, and an observer-pipeline reset; async workers capture it at dispatch and refuse to
	 * append ledger entries when it moved.
	 */
	generation = 0;

	/**
	 * Absolute `.memory/<sessionId>/` root for this session's durable + transient memory. Set
	 * whenever the gate is enabled (session_start / `/om on`) via `ensureSessionMemory`; empty
	 * while disabled. All path helpers (listTopics/indexPath/readJourney/run*Path) take this root.
	 */
	memoryRoot = "";

	/**
	 * Ordered observer pipeline keyed by dispatch sequence. Entries stay until committed, so a
	 * completed out-of-order chunk is retained but cannot advance coverage past an earlier gap.
	 * Bounded by `observerConcurrency` (slots are only granted while the window has room).
	 */
	readonly pendingObservers = new Map<number, PendingObserver>();
	nextObserverSequence = 0;

	/** In-flight observer async tasks, so compaction can wait for settled memory state (design R5). */
	readonly observerTasks = new Set<Promise<void>>();

	/**
	 * Every in-flight worker process task (observers + consolidator), independent of the ordered
	 * pipeline map. `abortAllWorkers` clears `pendingObservers`, so shutdown must drain from this
	 * set to await the aborted processes (SIGTERM→SIGKILL escalation) instead of letting Pi exit
	 * and orphan them.
	 */
	private readonly workerTasks = new Set<Promise<void>>();

	/** The single in-flight consolidator task, tracked for the shutdown drain (compaction ignores it). */
	consolidatorTask: Promise<void> | undefined;

	/**
	 * Strictly one consolidator at a time (design risk 4). The flag is held from dispatch through
	 * tombstone-commit so the pool clock cannot fire a second overlapping run. Runs in the
	 * background — compaction does NOT wait for it (R5).
	 */
	consolidatorInFlight = false;
	consolidatorController: AbortController | undefined;

	/**
	 * Last contiguously committed coverage watermark (durable). Reconstructed from the branch at
	 * session_start; advanced only by the ordered commit loop. Compaction must never cut past it.
	 */
	committedFrontierId: string | undefined;

	/**
	 * coversUpToId of the most-recent chunk DISPATCHED (committed or still in flight). Used to
	 * slice the next chunk contiguously. Reset to `committedFrontierId` on a pipeline failure so
	 * retries resume from the last durably covered point (duplicate observations are acceptable).
	 */
	dispatchedCoversUpToId: string | undefined;

	/** Guards so compaction trigger + hook never re-enter. */
	compactInFlight = false;
	compactHookInFlight = false;

	/** Last worker error message, surfaced by /om:status. */
	lastWorkerError: string | undefined;

	/** Set on session_shutdown so late async work cannot append to or notify a dead context. */
	shuttingDown = false;

	/** runIds whose cost was already recorded, so a retried settle never double-counts spend. */
	readonly recordedCostRunIds = new Set<string>();

	/**
	 * Whether the last compaction waited for in-flight observers or skipped the wait (fast path:
	 * no in-flight observer could affect the rendered block). Surfaced by /om:status.
	 */
	lastCompactionObserverWait: "skipped" | "waited" | undefined;

	readonly status = new StatusController();

	// ── Toast coalescer ──────────────────────────────────────────────────────────
	// Parallel observers fire finish toasts from independent async tasks. If two
	// land in the same event-loop tick, pi's showStatus() would replace the first
	// with the second. queueToast() accumulates info lines and flushes them as a
	// single multi-line notify on the next tick so both lines remain visible.

	private pendingInfoToastLines: string[] = [];
	private infoToastFlushTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Queue an info-level toast line for batched delivery on the next event-loop tick.
	 * Non-info levels (warning/error) bypass the queue and fire immediately so they
	 * always use their own styling and are never merged with info lines.
	 */
	queueToast(
		line: string,
		level: "info" | "warning" | "error",
		notify: (message: string, level: "info" | "warning" | "error") => void,
	): void {
		if (this.shuttingDown) return;
		if (level !== "info") {
			notify(line, level);
			return;
		}
		this.pendingInfoToastLines.push(line);
		if (this.infoToastFlushTimer !== undefined) return;
		this.infoToastFlushTimer = setTimeout(() => {
			this.infoToastFlushTimer = undefined;
			const lines = this.pendingInfoToastLines.splice(0);
			if (lines.length > 0 && !this.shuttingDown) notify(lines.join("\n"), "info");
		}, 0);
		this.infoToastFlushTimer.unref?.();
	}

	/** Discard any pending toast lines (called on session shutdown). */
	cancelPendingToasts(): void {
		if (this.infoToastFlushTimer !== undefined) {
			clearTimeout(this.infoToastFlushTimer);
			this.infoToastFlushTimer = undefined;
		}
		this.pendingInfoToastLines = [];
	}

	/** Load the merged config once (global + trusted project + env). */
	ensureConfig(cwd: string, projectTrusted = false): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd, process.env, { projectTrusted });
		this.configLoaded = true;
	}

	/**
	 * Abort in-flight workers and drop the ordered observer pipeline (session shutdown / disable /
	 * branch change / pipeline failure). The dispatch watermark is reset to the durable frontier so
	 * the next trigger retries from the last committed point. The consolidator slot is deliberately
	 * NOT cleared here — see `releaseConsolidator`.
	 */
	abortAllWorkers(): void {
		this.cancelPendingToasts();
		for (const pending of this.pendingObservers.values()) pending.controller.abort();
		this.pendingObservers.clear();
		this.dispatchedCoversUpToId = this.committedFrontierId;
		this.consolidatorController?.abort();
	}

	/**
	 * Release the consolidator slot only if `controller` is still the active run's controller.
	 * A late `finally` from a superseded run must not clear a newer run's slot.
	 */
	releaseConsolidator(controller: AbortController): void {
		if (this.consolidatorController !== controller) return;
		this.consolidatorController = undefined;
		this.consolidatorInFlight = false;
	}

	/** Track an observer task for the lifetime of its async run (compaction + shutdown). */
	trackObserverTask(task: Promise<void>): void {
		this.observerTasks.add(task);
		const settle = () => this.observerTasks.delete(task);
		// Swallow both outcomes: a settled handler must never become an unhandled rejection.
		void task.then(settle, settle);
		this.trackWorkerTask(task);
	}

	/** Track the consolidator task so shutdown can await it (compaction deliberately does not). */
	trackConsolidatorTask(task: Promise<void>): void {
		this.consolidatorTask = task;
		const clear = () => {
			if (this.consolidatorTask === task) this.consolidatorTask = undefined;
		};
		void task.then(clear, clear);
		this.trackWorkerTask(task);
	}

	/** Track any worker process task for the bounded shutdown drain. */
	trackWorkerTask(task: Promise<void>): void {
		this.workerTasks.add(task);
		const settle = () => this.workerTasks.delete(task);
		void task.then(settle, settle);
	}

	/** Resolve once no observer tasks are in flight (compaction blocks on this). */
	async whenObserversIdle(): Promise<void> {
		while (this.observerTasks.size > 0) {
			await Promise.allSettled([...this.observerTasks]);
		}
	}

	/**
	 * Bounded drain of every tracked worker process (observers + consolidator). Returns `true`
	 * when all settled before `timeoutMs`; `false` when the bound elapsed with tasks still running
	 * (the caller then proceeds so Pi can exit). `0` waits unbounded.
	 */
	async whenWorkersIdle(timeoutMs = 0): Promise<boolean> {
		if (this.workerTasks.size === 0) return true;
		if (timeoutMs <= 0) {
			while (this.workerTasks.size > 0) await Promise.allSettled([...this.workerTasks]);
			return true;
		}
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (idle: boolean) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(idle);
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			void (async () => {
				while (this.workerTasks.size > 0) await Promise.allSettled([...this.workerTasks]);
				finish(true);
			})();
		});
	}

	/** Controllers of observers whose worker process has not necessarily settled yet. */
	runningObserverControllers(): Array<{ coversUpToId: string }> {
		return [...this.pendingObservers.values()].map((pending) => ({ coversUpToId: pending.coversUpToId }));
	}

	get observerSlotsAvailable(): number {
		return Math.max(0, this.config.observerConcurrency - this.pendingObservers.size);
	}
}
