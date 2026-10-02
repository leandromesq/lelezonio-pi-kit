import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { writeObserverResult, type RawObservation } from "../../src/spawn/runs.js";

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
			}),
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
		}),
		{ description: "Batch of new observations. Call multiple times until the chunk is fully covered." },
	),
});

export type RecordObservationsInput = Static<typeof RecordObservationsSchema>;

/**
 * Register the observer's tools. `record_observations` accumulates observations across calls and
 * rewrites the result file (atomic) on every call. The terminal `finish_observations` tool sets
 * the completion flag the orchestrator requires before it will advance coverage — a headless
 * `pi -p` can exit 0 via the turn cap or `ctx.shutdown` before the model finished, so exit 0
 * alone must never be trusted.
 */
export function registerObserverTool(pi: ExtensionAPI, resultPath: string): void {
	const accumulated: RawObservation[] = [];
	const seen = new Set<string>();
	let completed = false;

	function flush(): void {
		writeObserverResult(resultPath, { observations: accumulated, completed });
	}

	// Ensure a valid, explicitly INCOMPLETE result file exists even for zero-observation chunks.
	flush();

	pi.registerTool({
		name: "record_observations",
		label: "Record observations",
		description:
			"Record a batch of observations distilled from the conversation chunk. " +
			"Call multiple times as you work through the chunk; when coverage is complete, call " +
			"finish_observations to end the run.",
		parameters: RecordObservationsSchema,
		async execute(
			_id: string,
			params: RecordObservationsInput,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			let added = 0;
			let duplicates = 0;
			for (const obs of params.observations) {
				const content = obs.content.replace(/[\r\n]+/g, " ").trim();
				if (!content) continue;
				const key = `${obs.timestamp}␞${content}`;
				if (seen.has(key)) {
					duplicates++;
					continue;
				}
				seen.add(key);
				accumulated.push({ timestamp: obs.timestamp, content });
				added++;
			}
			flush();
			const dupPart = duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Recorded ${added} observation${added === 1 ? "" : "s"}${dupPart}. Total so far: ${accumulated.length}. Continue if the chunk has uncovered content; otherwise call finish_observations.`,
					},
				],
				details: { added, duplicates, total: accumulated.length },
			};
		},
	});

	pi.registerTool({
		name: "finish_observations",
		label: "Finish observations",
		description:
			"Finish this observation run and authorize committing the recorded observations. " +
			"Call exactly once, after the chunk is fully covered (an empty batch is valid).",
		parameters: Type.Object({}),
		async execute() {
			completed = true;
			flush();
			return {
				content: [{ type: "text" as const, text: `Observation run acknowledged (${accumulated.length} observation(s)).` }],
				details: { total: accumulated.length, completed: true },
				terminate: true,
			};
		},
	});
}
