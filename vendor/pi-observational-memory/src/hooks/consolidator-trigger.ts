/**
 * Phase B consolidator clock. When the active observation pool crosses
 * `consolidateAtPoolTokens`, promote the oldest observations (above `poolTargetTokens`) into
 * durable `.memory/` topic files via a subprocess consolidator, then tombstone exactly the
 * timestamps it acknowledges.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly
 * one at a time (design risk 4). Compaction does not wait for it (R5).
 *
 * Tombstone safety (design risk 4): a clean process exit is NOT sufficient authorization to
 * drop memory. The orchestrator writes the handed batch to a batch file; the consolidator's
 * terminal `finish_consolidation` tool writes a durable acknowledgement listing the timestamps
 * it handled (and refuses to ack when it made no durable write unless it explicitly discarded
 * the batch). The orchestrator tombstones only `ack ∩ handed ∩ still-active`, so a flaked-out
 * or non-acking run leaves the buffer intact and it is retried on the next clock tick.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
	observationToLine,
	poolTokens,
	selectPromotionOverflow,
	sortObservations,
	type Entry,
	type Observation,
} from "../ledger/index.js";
import { nowTimestamp } from "../ledger/serialize.js";
import { renderIndexFile } from "../memory/index-render.js";
import { atomicWrite, indexPath, listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import {
	readConsolidationAck,
	runBatchPath,
	runResultPath,
	writeConsolidationBatch,
	type ConsolidationAck,
} from "../spawn/runs.js";

/**
 * Whether an acknowledgement authorizes tombstoning. A run that made zero durable writes is
 * only valid if it explicitly discarded the whole batch; otherwise the buffer must stay intact.
 * One durable file may cover many observations, so there is no `toDrop <= durableWrites` rule.
 */
export function ackAuthorizesDrop(ack: ConsolidationAck): boolean {
	return ack.discardedAll === true || (Number.isInteger(ack.durableWrites) && ack.durableWrites >= 1);
}
import { recordWorkerCost } from "./observer-trigger.js";

type TriggerCtx = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[]; getEntries: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};

/** runId for a consolidator run. UUID: unique across restarts even on a reused pid. */
function nextRunId(): string {
	return `cons-${randomUUID()}`;
}

/**
 * Build the consolidator's `-p` prompt: current time + current index + current journey + the
 * overflow lines. The journey is included verbatim so the consolidator updates it in place
 * (append a segment for this batch; compress the old tail only if over `journeyTargetTokens`).
 */
function buildConsolidatorPrompt(memoryRoot: string, promote: Observation[], journeyTargetTokens: number): string {
	const indexText = renderIndexFile(listTopics(memoryRoot));
	const journeyText = readJourney(memoryRoot);
	const journeyWords = Math.round((journeyTargetTokens * 3) / 4);
	const obsLines = sortObservations(promote).map(observationToLine).join("\n");
	return (
		`Current local time: ${nowTimestamp()}\n\n` +
		"You are folding the observations below into the durable topic files under .memory/. " +
		"Use this exact time string in the `updated` front-matter of any file you write, and in any new JOURNEY.md entry.\n\n" +
		"===== CURRENT MEMORY INDEX (generated; do not edit INDEX.md) =====\n" +
		`${indexText}\n` +
		"===== END MEMORY INDEX =====\n\n" +
		"===== CURRENT JOURNEY (.memory/JOURNEY.md — the running descriptive project history) =====\n" +
		`${journeyText ?? "(empty — no journey yet; start one)"}\n` +
		"===== END JOURNEY =====\n\n" +
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"Fold every observation above into topic files (create/merge/rewrite as needed). Then update " +
		`.memory/JOURNEY.md per your instructions — keep it under ~${journeyTargetTokens} tokens (~${journeyWords} words), ` +
		"purely descriptive, no advice or next steps. Finish by calling finish_consolidation (pass " +
		"discardedAll: true only if you deliberately discarded the whole batch without writing anything)."
	);
}

export function evaluateConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime, ctx: TriggerCtx): void {
	if (!runtime.enabled || runtime.config.passive) return;
	if (runtime.consolidatorInFlight) return;

	const branch = ctx.sessionManager.getBranch();
	const active = foldLedger(branch).activeObservations;
	if (poolTokens(active) < runtime.config.consolidateAtPoolTokens) return;

	const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
	if (promote.length === 0) return;

	runtime.consolidatorInFlight = true;
	if (ctx.hasUI) {
		ctx.ui?.notify(
			`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`,
			"info",
		);
	}
	// Deliberately NOT tracked in observerTasks: compaction waits only for in-flight observers,
	// never the consolidator (design R5). It IS tracked for the shutdown drain so an aborted
	// consolidator process is awaited (SIGTERM→SIGKILL) instead of orphaned. The
	// consolidatorInFlight flag enforces one-at-a-time.
	runtime.trackConsolidatorTask(dispatchConsolidator(pi, runtime, ctx, promote));
}

async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
): Promise<void> {
	const runId = nextRunId();
	const controller = new AbortController();
	// Capture the dispatch epoch so a `/tree` or `/om` toggle during the run prevents the
	// tombstone from being appended to the new branch (the durable topic writes remain valid).
	const generation = runtime.generation;
	// Capture the memory root: a session switch can reassign the live value while this worker
	// is still running, and every per-run path must stay pinned to the dispatch-time root.
	const memoryRoot = runtime.memoryRoot;
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);

	try {
		// Durable hand-off: the worker's terminal tool acks exactly these timestamps.
		writeConsolidationBatch(runBatchPath(memoryRoot, runId), {
			observationTimestamps: promote.map((observation) => observation.timestamp),
		});
		const prompt = buildConsolidatorPrompt(memoryRoot, promote, runtime.config.journeyTargetTokens);
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-consolidator-${runId}`,
		});
		const env = buildWorkerEnv("consolidator", {
			memoryRoot,
			runId,
			maxTurns: runtime.config.maxTurns,
			timeoutMs: runtime.config.timeoutMs,
		});
		const exit = await spawnWorker({
			argv,
			prompt,
			cwd: memoryRoot,
			env,
			signal: controller.signal,
			timeoutMs: runtime.config.timeoutMs,
		});
		// Capture cost before the exit-code check so a partial run's spend is still recorded.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId, memoryRoot);

		// Invalidated while the process ran (`/tree`, gate toggle, or abort): stop here. The
		// durable topic writes it already made remain valid for the unchanged session memory, but
		// the buffer must not be drained against the new branch and no "promoted"/INDEX update
		// should be announced. The process is already settling, so the slot is released in
		// `finally`; exclusivity holds until then.
		if (controller.signal.aborted || runtime.generation !== generation || !runtime.enabled) return;

		if (exit.code !== 0) {
			throw new Error(
				`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`,
			);
		}

		// Require a durable acknowledgement before tombstoning anything. A clean exit alone is
		// not authorization: a model that wrote nothing must not drain the buffer.
		const ack = readConsolidationAck(runResultPath(memoryRoot, runId));
		if (!ack) {
			throw new Error("consolidator exited without a durable acknowledgement; buffer not drained");
		}
		// An ack with zero durable writes is only valid as an explicit whole-batch discard.
		if (!ackAuthorizesDrop(ack)) {
			throw new Error("consolidator ack reports no durable writes and no explicit discard; buffer not drained");
		}

		// Tombstone only the intersection of what we handed over, what the worker acked, and
		// what is still active — never an observation an observer committed during this run.
		const branch = ctx.sessionManager.getBranch();
		const stillActive = new Set(foldLedger(branch).activeObservations.map((observation) => observation.timestamp));
		const handed = new Set(promote.map((observation) => observation.timestamp));
		const toDrop = ack.observationTimestamps.filter((timestamp) => handed.has(timestamp) && stillActive.has(timestamp));

		if (toDrop.length > 0) {
			const coversUpToId = lastSourceEntryId(branch);
			if (coversUpToId) {
				pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
			}
		}

		// Re-render INDEX.md so live ls/grep truth leads the pushed map (design risk 3).
		atomicWrite(indexPath(memoryRoot), renderIndexFile(listTopics(memoryRoot)));

		runtime.status.workerDone(runId, toDrop.length);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(`om: consolidator promoted ${toDrop.length} obs`, "info", ctx.ui.notify.bind(ctx.ui));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		// No UI error from a run that was invalidated or from a dead context.
		if (ctx.hasUI && !runtime.shuttingDown && !controller.signal.aborted && runtime.enabled) {
			ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
		}
	} finally {
		// Identity-guarded: a late `finally` from a superseded run must not clear a newer run's
		// slot. `abortAllWorkers` never clears it, so exclusivity holds until this point.
		runtime.releaseConsolidator(controller);
	}
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => evaluateConsolidatorTrigger(pi, runtime, ctx);
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
