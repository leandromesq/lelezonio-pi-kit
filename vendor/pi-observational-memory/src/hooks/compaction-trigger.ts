/**
 * Proactive compaction clock.
 *
 * Pi 1 exposes the supported mid-run compaction path through the `turn_end` boundary: a handler
 * may append a `compaction` entry draft and return `continue: true` to request one next model
 * request. That replaces the old manual `ctx.compact()` + hidden "resume" custom message, which
 * aborted the loop and re-injected a synthetic user turn.
 *
 * Proactive compaction is OPT-IN (`compactAtContextTokens > 0`). The default is `0` (disabled),
 * so Pi's own window-pressure compaction is authoritative; OM still supplies the summary through
 * `session_before_compact`. When enabled, this only fires on a mid-run `turn_end` (a turn that
 * will continue); a terminal turn is left to Pi's normal pre-prompt compaction.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildCompactionProjection,
	latestCommittedWatermarkId,
	rawTokensSinceLastCompaction,
	renderSummary,
	type Entry,
} from "../ledger/index.js";
import { renderMemoryMap } from "../memory/index-render.js";
import { listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { isUsableMemoryTail, snapCutoff } from "./compaction-hook.js";

/** Pi's retryable-error detection: don't compact between an auto-retried turn's attempts. */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function contextPressureTokens(
	ctx: { getContextUsage?: () => { tokens: number | null } | undefined; sessionManager: { getBranch: () => Entry[] } },
	threshold: number,
): { tokens: number; due: boolean } {
	const live = ctx.getContextUsage?.()?.tokens;
	if (live != null) return { tokens: live, due: live >= threshold };
	const raw = rawTokensSinceLastCompaction(ctx.sessionManager.getBranch());
	return { tokens: raw, due: raw >= threshold };
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;
		// 0 disables proactive compaction; Pi's native pressure compaction stays authoritative.
		if (runtime.config.compactAtContextTokens <= 0) return undefined;
		if (runtime.compactInFlight) return undefined;

		// Don't compact if pi will auto-retry this turn (transient provider/network error).
		const message = event?.message;
		if (
			message?.role === "assistant" &&
			message.stopReason === "error" &&
			message.errorMessage &&
			RETRYABLE_ERROR_RE.test(message.errorMessage)
		) {
			return undefined;
		}

		if (!contextPressureTokens(ctx, runtime.config.compactAtContextTokens).due) return undefined;
		// Only compact a turn the loop will continue; a terminal turn is handled by Pi's
		// pre-prompt compaction via `session_before_compact`.
		if (event?.context?.canContinue !== true) return undefined;

		runtime.compactInFlight = true;
		try {
			// Wait for in-flight observers so just-committed observations are folded (R5).
			await runtime.whenObserversIdle();
			const branch = ctx.sessionManager.getBranch() as Entry[];
			// Never cut past the last contiguously committed coverage: a gap left by a failed chunk
			// must fall through to Pi's native compaction rather than be summarized away.
			const frontierId = latestCommittedWatermarkId(branch);
			if (!frontierId) return undefined;
			const snap = snapCutoff(branch, event.messageEntryId as string, runtime.config.tailTokens, frontierId);
			if (!isUsableMemoryTail(snap.tail, runtime.config.tailTokens, runtime.config.chunkTokens)) return undefined;
			const projection = buildCompactionProjection(branch, snap.firstKeptId);
			const journey = readJourney(runtime.memoryRoot);
			const map = renderMemoryMap(listTopics(runtime.memoryRoot));
			const summary = renderSummary(journey, map, projection.observations);
			return {
				entries: [
					...(event.entries ?? []),
					{
						type: "compaction" as const,
						summary,
						firstKeptEntryId: snap.firstKeptId,
						details: projection.details,
					},
				],
				continue: true,
			};
		} finally {
			runtime.compactInFlight = false;
		}
	});
}
