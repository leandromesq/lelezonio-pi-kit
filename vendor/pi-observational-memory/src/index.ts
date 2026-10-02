/**
 * Observational memory — ORCHESTRATOR (master-side, in-process).
 *
 * The conductor: owns the clocks/triggers, spawns subprocess workers, commits their output to
 * the ledger (observations) or files (long-term, Phase B), renders compaction, and drives the
 * TUI. Event-driven only — no daemon.
 *
 * Gating:
 * - Child processes (`PI_SUBAGENT=1`) and passive Herdr workers
 *   (`PI_OBSERVATIONAL_MEMORY_PASSIVE=1`) register nothing at all — the whole factory returns
 *   before touching `pi`. This is the in-process half of child isolation; the shared resource
 *   loader also excludes this package by path.
 * - Otherwise the per-session on/off gate is resolved from the branch (`om2.enabled`), falling
 *   back to `settings.enabled` when the branch has no gate entry. `/om off` writes a branch
 *   entry and overrides the fallback for the rest of the session.
 * - `PI_OM_PASSIVE=1` (or `passive: true`) keeps commands registered but disables all triggers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, latestCommittedWatermarkId, type Entry } from "./ledger/index.js";
import { ensureSessionMemory } from "./memory/session.js";
import { Runtime, SHUTDOWN_DRAIN_MS } from "./runtime.js";

/** Branch gate value, or undefined when the branch has no `om2.enabled` entry. */
function readGateFromLedger(branch: Entry[]): boolean | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === OM_ENABLED) {
			return (entry.data as { enabled?: boolean } | undefined)?.enabled ?? false;
		}
	}
	return undefined;
}

export default function observationalMemory(pi: ExtensionAPI): void {
	// Child isolation: a spawned worker (or passive user process) must be completely inert.
	if (process.env.PI_SUBAGENT === "1" || process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE === "1") return;

	const runtime = new Runtime();

	function attachIfEnabled(ctx: any): void {
		if (runtime.enabled && ctx.mode === "tui" && ctx.hasUI && ctx.ui) {
			runtime.status.attach(ctx.ui);
		} else {
			runtime.status.detach();
		}
	}

	/** Resolve the gate from the current branch, falling back to settings.enabled. */
	function resolveGate(ctx: any): boolean {
		const branch = ctx.sessionManager.getBranch() as Entry[];
		return readGateFromLedger(branch) ?? runtime.config.enabled;
	}

	function activate(ctx: any): void {
		if (runtime.enabled) runtime.memoryRoot = ensureSessionMemory(ctx);
		attachIfEnabled(ctx);
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		runtime.ensureConfig(ctx.cwd, ctx.isProjectTrusted?.() === true);
		runtime.generation += 1;
		runtime.shuttingDown = false;
		runtime.pendingObservers.clear();
		runtime.nextObserverSequence = 0;
		runtime.recordedCostRunIds.clear();
		runtime.enabled = resolveGate(ctx);
		activate(ctx);
		// Reconstruct durable coverage so dispatch and compaction resume from the last
		// contiguously committed chunk (a zero-observation chunk leaves a coverage marker too).
		runtime.committedFrontierId = latestCommittedWatermarkId(ctx.sessionManager.getBranch() as Entry[]);
		runtime.dispatchedCoversUpToId = runtime.committedFrontierId;
	});

	// /tree navigation changes the active branch: invalidate (abort + bump the generation) any
	// worker dispatched against the old branch so it cannot append coverage to the new one, then
	// re-resolve the gate and the durable frontier for the new branch. Memory files are
	// session-scoped and intentionally not rolled back.
	pi.on("session_tree", (_event: unknown, ctx: any) => {
		if (!runtime.configLoaded) runtime.ensureConfig(ctx.cwd, ctx.isProjectTrusted?.() === true);
		runtime.generation += 1;
		runtime.abortAllWorkers();
		runtime.enabled = resolveGate(ctx);
		runtime.committedFrontierId = latestCommittedWatermarkId(ctx.sessionManager.getBranch() as Entry[]);
		runtime.dispatchedCoversUpToId = runtime.committedFrontierId;
		if (runtime.enabled) {
			activate(ctx);
		} else {
			runtime.status.detach();
		}
	});

	pi.on("session_shutdown", async () => {
		// Mark shutdown first so late async workers cannot append to or notify a dead context.
		runtime.shuttingDown = true;
		runtime.status.detach();
		runtime.abortAllWorkers();
		// Await the aborted worker processes so the SIGTERM→SIGKILL escalation actually fires
		// before Pi exits; a fire-and-forget abort would leave orphaned subprocesses behind.
		await runtime.whenWorkersIdle(SHUTDOWN_DRAIN_MS);
	});

	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om on, /om off)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify(`om already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			// Invalidate in-flight workers on every gate change so a worker from the previous
			// state cannot commit after the toggle.
			runtime.generation += 1;
			pi.appendEntry(OM_ENABLED, { enabled: next });
			if (next) {
				runtime.memoryRoot = ensureSessionMemory(ctx);
				attachIfEnabled(ctx);
			} else {
				runtime.abortAllWorkers();
				runtime.status.detach();
			}
			if (ctx.hasUI) ctx.ui.notify(`om ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerCompactCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
}
