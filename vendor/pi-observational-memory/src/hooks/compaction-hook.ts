import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMemoryMap } from "../memory/index-render.js";
import { listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	entryIndexById,
	entryIndexForId,
	isCoverageCommittedEntry,
	isObservationsRecordedEntry,
	isSourceEntry,
	isValidCutPoint,
	latestCommittedWatermarkId,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../ledger/index.js";

/** Distinct, branch-resolved coversUpToId indices of committed chunks (observations OR empty), ascending. */
function chunkBoundaryIndices(branch: Entry[]): number[] {
	const indexes = entryIndexById(branch);
	const set = new Set<number>();
	for (const entry of branch) {
		const coversUpToId = isObservationsRecordedEntry(entry)
			? entry.data.coversUpToId
			: isCoverageCommittedEntry(entry)
				? entry.data.coversUpToId
				: undefined;
		if (!coversUpToId) continue;
		const idx = indexes.get(coversUpToId);
		if (idx !== undefined) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to an observation chunk boundary so the verbatim tail
 * starts exactly where a chunk ends — no chunk straddles the cutoff, so nothing is both
 * rendered into the summary and kept verbatim (and nothing is lost). Among boundaries whose
 * next entry is a valid cut point, pick the one whose resulting tail is closest to
 * `tailTokens`.
 *
 * `frontierId` is the last contiguously committed coverage watermark. Only boundaries AT OR
 * BEFORE it are eligible: cutting past a gap left by a failed/unobserved chunk would silently
 * omit that region from the custom summary. Falls back to `{ proposed, tail: undefined }` when
 * no safe boundary qualifies; the caller then declines (native Pi summary).
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
	frontierId?: string,
): { firstKeptId: string; tail: number | undefined } {
	// undefined frontier = unbounded (only test callers); production callers always pass the
	// committed frontier and decline before calling when there is none.
	const frontierIndex = frontierId === undefined ? Number.POSITIVE_INFINITY : entryIndexForId(branch, frontierId);
	const boundaries = chunkBoundaryIndices(branch);
	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of boundaries) {
		if (boundaryIndex > frontierIndex) continue;
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
			bestTail = tail;
		}
	}

	return bestId ? { firstKeptId: bestId, tail: bestTail } : { firstKeptId: proposedFirstKeptId, tail: undefined };
}

export function snapFirstKeptEntryId(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
	frontierId?: string,
): string {
	return snapCutoff(branch, proposedFirstKeptId, tailTokens, frontierId).firstKeptId;
}

/**
 * Fast-path test: can compaction skip waiting for in-flight observers entirely?
 *
 * The wait exists so just-committed observations are folded before rendering. But an observer
 * only affects the rendered block if its chunk's `coversUpToId` lands at-or-before the cutoff
 * (the projection includes an `om2.observations.recorded` entry iff its coverage index is
 * `< index(firstKeptId)`). Observers working a chunk in the verbatim tail are excluded
 * regardless, so waiting for them is dead time.
 */
export function canSkipObserverWait(
	branch: Entry[],
	snappedFirstKeptId: string,
	snappedTail: number | undefined,
	tailTokens: number,
	observersInFlight: Iterable<{ coversUpToId: string }>,
): boolean {
	// Condition 2: snap is only stable under skipped observers when its tail is already <= target.
	if (snappedTail === undefined || snappedTail > tailTokens) return false;

	const indexes = entryIndexById(branch);
	const cutoffIndex = indexes.get(snappedFirstKeptId);
	if (cutoffIndex === undefined) return false; // can't reason about the boundary → wait

	// Condition 1: every in-flight observer must cover a chunk that ends at-or-after the cutoff.
	for (const { coversUpToId } of observersInFlight) {
		const idx = indexes.get(coversUpToId);
		if (idx === undefined || idx < cutoffIndex) return false;
	}
	return true;
}

/** A lagging frontier must not retain an oversized tail and leave pressure compaction ineffective. */
export function isUsableMemoryTail(tail: number | undefined, budget: number, chunkTokens: number): boolean {
	return tail !== undefined && tail <= budget + chunkTokens;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive || runtime.shuttingDown) return undefined;

		const hasUI = ctx.hasUI;
		if (runtime.compactHookInFlight) {
			// Decline the custom summary rather than cancelling compaction: Pi then generates its
			// native (model-based) summary and the context is still freed safely.
			if (hasUI) ctx.ui.notify("om: another compaction is already in progress; using the native summary", "warning");
			return undefined;
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const tailTokens = runtime.config.tailTokens;
			const { firstKeptEntryId, tokensBefore } = event.preparation;

			let branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
			// Refuse the custom summary when the committed coverage prefix does not extend to a
			// usable cut point: a gap (failed/unobserved chunk) must never be summarized away.
			let frontierId = latestCommittedWatermarkId(branch);
			if (!frontierId) return undefined;
			let snap = snapCutoff(branch, firstKeptEntryId, tailTokens, frontierId);

			const skip = canSkipObserverWait(
				branch,
				snap.firstKeptId,
				snap.tail,
				tailTokens,
				runtime.runningObserverControllers(),
			);
			runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
			if (!skip) {
				if (hasUI) ctx.ui.notify("om: waiting for in-flight observers before folding…", "info");
				await runtime.whenObserversIdle();
				branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
				frontierId = latestCommittedWatermarkId(branch);
				if (!frontierId) return undefined;
				snap = snapCutoff(branch, firstKeptEntryId, tailTokens, frontierId);
			}

			// No safe boundary, or observers too far behind to actually relieve context pressure:
			// decline and let Pi summarize the uncovered prefix instead of repeatedly retaining it.
			const tailBudget = Math.max(tailTokens, event.preparation.settings?.keepRecentTokens ?? tailTokens);
			if (!isUsableMemoryTail(snap.tail, tailBudget, runtime.config.chunkTokens)) return undefined;

			const snapped = snap.firstKeptId;
			const projection = buildCompactionProjection(branch, snapped);
			// Phase B: render the long-term tier live from disk, regenerated each compaction
			// (throwaway projections — cannot decay). The journey is the running descriptive history
			// the consolidator maintains; the map is the topic-file index.
			const journey = readJourney(runtime.memoryRoot);
			const map = renderMemoryMap(listTopics(runtime.memoryRoot));
			const summary = renderSummary(journey, map, projection.observations);

			return {
				compaction: {
					summary,
					firstKeptEntryId: snapped,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
