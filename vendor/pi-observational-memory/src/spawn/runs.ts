/**
 * File-based IPC between the in-process orchestrator and subprocess workers.
 *
 * A subprocess cannot append to the master's ledger, so it writes its output to a transient
 * result file under `<project>/.memory/.runs/<runId>.json`. The orchestrator reads + validates
 * it after the process exits, then commits to the right tier (observations → ledger).
 *
 * Worker recordings themselves live in pi's GLOBAL session store, not here (decision 11).
 * `.memory/.runs/` clutter is not GC'd in v1 (accepted).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the observer model emits, before the orchestrator re-derives precise timestamp-ids. */
export type RawObservation = {
	timestamp: string; // "YYYY-MM-DD HH:MM"
	content: string;
};

export type ObserverRunResult = {
	observations: RawObservation[];
	/**
	 * Set only by the observer's terminal `finish_observations` tool. A headless worker can exit
	 * 0 via the turn cap or `ctx.shutdown` before the model finishes, leaving an empty/partial
	 * result file; the orchestrator must not advance coverage without this acknowledgement.
	 */
	completed: boolean;
};

export function runsDir(root: string): string {
	return join(root, ".runs");
}

export function runResultPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.result.json`);
}

/**
 * Per-run cost handoff file. Written by the worker EXTENSION (never the model) from pi's
 * built-in `usage.cost.total`, read by the orchestrator after the process exits. Uniform
 * across roles — the consolidator has no observations result file but still reports cost here.
 */
export function runCostPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.cost.json`);
}

export type WorkerCostResult = {
	costUsd: number;
};

export function writeWorkerCost(path: string, cost: WorkerCostResult): void {
	atomicWrite(path, JSON.stringify(cost));
}

/** Best-effort read of a worker cost file; returns undefined on missing/malformed input. */
export function readWorkerCost(path: string): WorkerCostResult | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const cost = (raw as { costUsd?: unknown }).costUsd;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
		return { costUsd: cost };
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename) so a reader never sees a half-written file. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function isRawObservation(value: unknown): value is RawObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.timestamp === "string" && typeof v.content === "string" && v.content.trim().length > 0;
}

/** Parse + validate an observer result file. Throws on malformed input. */
export function readObserverResult(path: string): ObserverRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { observations?: unknown }).observations)) {
		throw new Error("observer result missing observations array");
	}
	const observations = (raw as { observations: unknown[] }).observations.filter(isRawObservation);
	return { observations, completed: (raw as { completed?: unknown }).completed === true };
}

export function writeObserverResult(path: string, result: ObserverRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}

// ── Consolidation hand-off ────────────────────────────────────────────────────
// The orchestrator writes the batch it handed the consolidator to a batch file, and the
// consolidator's `finish_consolidation` tool writes a durable acknowledgement listing exactly
// the timestamps it handled. The orchestrator tombstones only the intersection of the batch,
// the ack, and the still-active pool — never a whole batch merely because the process exited 0.

/** The observations the orchestrator handed to one consolidator run. */
export type ConsolidationBatch = {
	observationTimestamps: string[];
};

/** Written by the consolidator's terminal tool; the durable tombstone authorization. */
export type ConsolidationAck = {
	observationTimestamps: string[];
	durableWrites: number;
	discardedAll: boolean;
	completedAt: string;
};

export function runBatchPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.batch.json`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** Read + validate a consolidation batch file. Throws on malformed input. */
export function readConsolidationBatch(path: string): ConsolidationBatch {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !isStringArray((raw as { observationTimestamps?: unknown }).observationTimestamps)) {
		throw new Error("consolidation batch missing observationTimestamps");
	}
	return { observationTimestamps: (raw as ConsolidationBatch).observationTimestamps };
}

export function writeConsolidationBatch(path: string, batch: ConsolidationBatch): void {
	atomicWrite(path, JSON.stringify(batch));
}

/** Read + validate a consolidation ack. Returns undefined on missing/malformed input. */
export function readConsolidationAck(path: string): ConsolidationAck | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const ack = raw as Record<string, unknown>;
		if (!isStringArray(ack.observationTimestamps)) return undefined;
		if (typeof ack.durableWrites !== "number" || !Number.isInteger(ack.durableWrites) || ack.durableWrites < 0) return undefined;
		if (typeof ack.discardedAll !== "boolean") return undefined;
		if (typeof ack.completedAt !== "string") return undefined;
		return {
			observationTimestamps: ack.observationTimestamps,
			durableWrites: ack.durableWrites,
			discardedAll: ack.discardedAll,
			completedAt: ack.completedAt,
		};
	} catch {
		return undefined;
	}
}

export function writeConsolidationAck(path: string, ack: ConsolidationAck): void {
	atomicWrite(path, JSON.stringify(ack));
}
