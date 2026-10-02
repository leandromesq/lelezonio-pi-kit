/**
 * Shared worker agent extension (L4), loaded into a subprocess `pi` via `-e`. Branches on
 * the OM_WORKER env var.
 *
 * The worker is headless (`pi -p`): builtin tools are disabled (`--no-builtin-tools`), the
 * system prompt is fully replaced with the role prompt, and the role registers only the tools
 * it needs. Output is handed back to the orchestrator via the result file (see src/spawn/runs.ts).
 *
 * Chunk delivery: the orchestrator passes the conversation chunk as the `pi -p` prompt, so it
 * is recorded as a real user message. We deliberately do NOT inject it via the `context` hook
 * — that is non-destructive and never persists to the session, which would leave the chunk
 * invisible when inspecting/resuming the observer run and defeat the observability goal
 * (decision 11). The system prompt carries role + rules only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackWorkerCost } from "./cost.js";
import { CONSOLIDATOR_SYSTEM } from "./consolidator/prompt.js";
import { registerConsolidatorTools } from "./consolidator/tools.js";
import { OBSERVER_SYSTEM } from "./observer/prompt.js";
import { registerObserverTool } from "./observer/tool.js";

/** Parse the orchestrator's turn cap; 0/absent means uncapped. */
function parseTurnCap(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default function omWorker(pi: ExtensionAPI): void {
	const role = process.env.OM_WORKER;
	const resultPath = process.env.OM_RESULT_PATH;
	const turnCap = parseTurnCap(process.env.OM_MAX_TURNS);

	// Shared across roles: pull pi's built-in cost and hand it back via the cost file.
	// Registered first so it writes the cost file before each role's agent_settled shutdown.
	trackWorkerCost(pi);

	// Hard turn cap. Headless `pi -p` exits when the model stops; this cuts off a runaway model.
	// `agent_settled` (not `agent_end`) is the final point after retries/queued continuations.
	if (turnCap > 0) {
		pi.on("turn_end", (event, ctx) => {
			const turnIndex = (event as { turnIndex?: number }).turnIndex;
			if (typeof turnIndex === "number" && turnIndex + 1 >= turnCap) ctx.shutdown();
		});
	}

	if (role === "observer") {
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for observer worker");
		registerObserverTool(pi, resultPath);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: OBSERVER_SYSTEM };
		});

		// Final settlement, not `agent_end`: retries/queued continuations can still follow
		// `agent_end`, and shutting down there would drop their cost/observations.
		pi.on("agent_settled", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}

	if (role === "consolidator") {
		const memoryRoot = process.env.OM_MEMORY_DIR;
		if (!memoryRoot) throw new Error("OM_MEMORY_DIR not set for consolidator worker");
		// The output is the `.memory/` edits; the terminal `finish_consolidation` tool writes the
		// durable acknowledgement the orchestrator requires before tombstoning.
		registerConsolidatorTools(pi, memoryRoot, {
			batchPath: process.env.OM_BATCH_PATH,
			resultPath,
		});

		pi.on("before_agent_start", async () => {
			return { systemPrompt: CONSOLIDATOR_SYSTEM };
		});

		pi.on("agent_settled", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}
}
