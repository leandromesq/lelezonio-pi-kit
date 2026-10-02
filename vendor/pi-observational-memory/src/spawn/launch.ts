/**
 * Subprocess worker launch — the yt-edit `pi -e <ext> -p` pattern (L2).
 *
 * NOT the subagents extension: that uses `--no-session --mode json`, which would defeat
 * decision 11's requirement that every worker be an ordinary recorded GLOBAL session. We
 * spawn a plain headless `pi` with no `--session-dir`, so the run is recorded under the
 * project path in `~/.pi/agent/sessions` and is openable in the session browser.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ConfiguredModel } from "../config.js";
import { runBatchPath, runCostPath, runResultPath } from "./runs.js";

/** Repo root = two levels up from src/spawn/. The shared agent extension lives at agent/index.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_EXTENSION_PATH = join(REPO_ROOT, "agent", "index.ts");

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** After SIGTERM, how long to wait before SIGKILL. Exported so shutdown can bound its drain. */
export const KILL_ESCALATION_MS = 3_000;
/** Cap on captured worker stderr (a provider error stream can be unbounded). */
const STDERR_MAX_BYTES = 64 * 1024;

export function modelArg(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve the `pi` CLI to spawn, portably.
 *
 * Order:
 *  1. `PI_BIN` / `PI_EXECUTABLE` override.
 *  2. The installed package's own CLI JS, run with `process.execPath`. This is correct on
 *     Windows (no `.cmd` shim) and under an SDK or test host, where `process.argv[1]` is the
 *     host entry point rather than pi.
 *  3. `process.argv[1]` ONLY when it genuinely looks like pi's own CLI (never a test runner).
 *  4. `pi` on PATH.
 */
export function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const override = process.env.PI_BIN ?? process.env.PI_EXECUTABLE;
	if (override) return { command: override, baseArgs: [] };

	try {
		const entry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
		// main is ./dist/index.js, so the package root is two levels up.
		const root = dirname(dirname(entry));
		for (const candidate of [join(root, "dist", "bundle", "cli.js"), join(root, "dist", "cli.js")]) {
			if (existsSync(candidate)) return { command: process.execPath, baseArgs: [candidate] };
		}
	} catch {
		// fall through to argv / PATH
	}

	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			const looksLikePiCli =
				/pi-coding-agent[\\/].*cli\.(?:mjs|cjs|js)$/i.test(realEntry) ||
				/[\\/]bundle[\\/]cli\.(?:mjs|cjs|js)$/i.test(realEntry);
			if (looksLikePiCli) return { command: process.execPath, baseArgs: [realEntry] };
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [] };
}

export function buildWorkerArgv(opts: {
	model: ConfiguredModel;
	sessionName: string;
	agentExtensionPath?: string;
}): string[] {
	const pi = resolvePiBinary();
	const args = [
		...pi.baseArgs,
		// Isolation: no discovered/built-in extensions, no project resources. Only the explicit
		// worker extension below loads, so the user's global extensions never run in a worker.
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-builtin-tools",
		"--model",
		modelArg(opts.model),
	];
	if (opts.model.thinking) args.push("--thinking", opts.model.thinking);
	args.push("-e", opts.agentExtensionPath ?? AGENT_EXTENSION_PATH);
	args.push("-n", opts.sessionName);
	// Pi records piped stdin as the initial user message. Keep large transcripts out of argv.
	args.push("-p");
	return [pi.command, ...args];
}

export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

/**
 * Spawn a headless worker; resolve when it exits. Workers run in their master session's
 * `.memory/<sessionId>/` root (not the project cwd) so pi keys the run into a distinct global
 * session bucket and it never clutters the project's `/resume` picker. The root is ensured to
 * exist before spawn — `spawn()` would ENOENT otherwise (the memory root is created lazily on
 * first durable write when there is no parent to seed).
 *
 * Cancellation and the optional wall-clock timeout escalate SIGTERM → SIGKILL using the real
 * process state (`exitCode`/`signalCode`), not `proc.killed` (which is true immediately after
 * `kill()` is called and therefore cannot detect a still-running process).
 */
export function spawnWorker(opts: {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Initial user message, sent through stdin to avoid Windows' command-line length limit. */
	prompt?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<WorkerExit> {
	// Already cancelled: return an interrupted result without creating the memory dir or
	// spawning a transient worker (no side effects for a request that was abandoned upstream).
	if (opts.signal?.aborted) {
		return Promise.resolve({ code: null, signal: "SIGTERM", stderr: "worker aborted before spawn" });
	}
	const [command, ...rest] = opts.argv;
	mkdirSync(opts.cwd, { recursive: true });
	return new Promise<WorkerExit>((resolvePromise) => {
		const proc = spawn(command, rest, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		let settled = false;
		let killStarted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (exit: WorkerExit) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise(exit);
		};
		const hasExited = () => proc.exitCode !== null || proc.signalCode !== null;
		// Idempotent: a timeout and an abort can both request a kill; the first wins so the
		// 3s SIGKILL timer is never reassigned (and the previous one never leaks).
		const escalateKill = () => {
			if (killStarted || hasExited()) return;
			killStarted = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!hasExited()) proc.kill("SIGKILL");
			}, KILL_ESCALATION_MS);
			killTimer.unref?.();
		};
		const onAbort = () => escalateKill();

		proc.stderr?.on("data", (d: Buffer) => {
			// Keep only the last STDERR_MAX_BYTES so a runaway provider error stream cannot grow
			// memory without bound.
			stderr += d.toString();
			if (stderr.length > STDERR_MAX_BYTES) stderr = stderr.slice(-STDERR_MAX_BYTES);
		});
		proc.on("error", (error: Error) =>
			finish({ code: 1, signal: null, stderr: stderr || `spawn error: ${error.message}` }),
		);
		proc.on("close", (code, signal) => finish({ code, signal, stderr }));
		// Handle EPIPE if the worker exits before consuming input; never leak an unhandled
		// stream error. end() handles backpressure and closes stdin so Pi can finish reading.
		proc.stdin?.on("error", (error: Error) => {
			stderr = `${stderr}\n[worker stdin: ${error.message}]`.slice(-STDERR_MAX_BYTES);
			escalateKill();
		});
		proc.stdin?.end(opts.prompt ?? "", "utf8");

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				stderr += `\n[worker timed out after ${opts.timeoutMs} ms]`;
				escalateKill();
			}, opts.timeoutMs);
			timeoutTimer.unref?.();
		}

		if (opts.signal) {
			if (opts.signal.aborted) escalateKill();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

export type WorkerLaunchEnv = {
	/** Absolute `.memory/<sessionId>/` root — IPC files and the consolidator sandbox live here. */
	memoryRoot: string;
	runId: string;
	/** Worker turn cap; omitted/0 leaves it uncapped. */
	maxTurns?: number;
	/** Worker wall-clock bound in ms; omitted/0 leaves it unbounded. */
	timeoutMs?: number;
};

/**
 * Build the env a worker subprocess needs to write its result file. The chunk itself is NOT
 * passed via env/file/argv — it is piped to `pi -p` stdin (recorded user message) so the run stays
 * faithfully inspectable on resume.
 */
export function buildWorkerEnv(role: "observer" | "consolidator", opts: WorkerLaunchEnv): NodeJS.ProcessEnv {
	return {
		...process.env,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		OM_RESULT_PATH: runResultPath(opts.memoryRoot, opts.runId),
		// Per-run cost handoff: the worker extension writes pi's built-in usage.cost.total here.
		OM_COST_PATH: runCostPath(opts.memoryRoot, opts.runId),
		// Sandbox root for the consolidator's scoped file tools (design risk 6).
		OM_MEMORY_DIR: opts.memoryRoot,
		// Consolidator only: the batch it was handed, so its terminal tool can ack exactly those.
		...(role === "consolidator" ? { OM_BATCH_PATH: runBatchPath(opts.memoryRoot, opts.runId) } : {}),
		...(opts.maxTurns && opts.maxTurns > 0 ? { OM_MAX_TURNS: String(opts.maxTurns) } : {}),
		...(opts.timeoutMs && opts.timeoutMs > 0 ? { OM_TIMEOUT_MS: String(opts.timeoutMs) } : {}),
	};
}
