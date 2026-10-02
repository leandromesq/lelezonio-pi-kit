/**
 * The consolidator's tool belt. `--no-builtin-tools` is set on the worker, so this extension
 * registers its own read/write/edit/ls/grep — all path-scoped to `.memory/` (design risk 6).
 * There is no free-form result file: the file edits ARE the output. The model finishes by
 * calling `finish_consolidation`, which writes a durable acknowledgement naming the exact
 * observation timestamps it handled; the orchestrator tombstones only those (never a whole
 * batch merely because the process exited 0).
 *
 * Scoping: every path argument is resolved against OM_MEMORY_DIR, following symlinks, and
 * rejected if it escapes that directory, so a wayward model cannot read or clobber the user's
 * project (including via a symlink placed inside `.memory/`).
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { atomicWrite, resolveWithinMemory } from "../../src/memory/paths.js";
import { readConsolidationBatch, writeConsolidationAck } from "../../src/spawn/runs.js";

type ToolText = { content: { type: "text"; text: string }[]; details: unknown; terminate?: boolean };

function ok(text: string, details: unknown = {}): ToolText {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string): ToolText {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } };
}

const ReadSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/, e.g. 'auth.md' or '.memory/auth.md'." }),
});
const WriteSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/ to (over)write, e.g. 'auth.md'." }),
	content: Type.String({ description: "Full file content, including YAML front-matter." }),
});
const EditSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/ to edit." }),
	oldText: Type.String({ description: "Exact text to replace (must occur exactly once)." }),
	newText: Type.String({ description: "Replacement text." }),
});
const LsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Subdirectory inside .memory/. Defaults to .memory/ root." })),
});
const GrepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for." }),
	path: Type.Optional(Type.String({ description: "Restrict to this file/subdir inside .memory/." })),
});
const FinishSchema = Type.Object({
	discardedAll: Type.Optional(
		Type.Boolean({
			description:
				"Set true only if the entire handed batch was deliberately discarded without writing anything durable.",
		}),
	),
});

type ReadInput = Static<typeof ReadSchema>;
type WriteInput = Static<typeof WriteSchema>;
type EditInput = Static<typeof EditSchema>;
type LsInput = Static<typeof LsSchema>;
type GrepInput = Static<typeof GrepSchema>;
type FinishInput = Static<typeof FinishSchema>;

/** List files under a directory, skipping hidden entries and symlinks. */
function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue; // skip .runs and temp files
		const full = join(dir, name);
		let stat;
		try {
			stat = lstatSync(full);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue; // never traverse a symlink out of the sandbox
		if (stat.isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

export interface ConsolidatorToolsOptions {
	/** Batch file written by the orchestrator (the observations handed to this run). */
	batchPath?: string;
	/** Ack file the terminal tool writes; the orchestrator's tombstone authorization. */
	resultPath?: string;
}

/** Register the consolidator's scoped file tools (read/write/edit/ls/grep) plus the terminator. */
export function registerConsolidatorTools(
	pi: ExtensionAPI,
	memoryRoot: string,
	options: ConsolidatorToolsOptions = {},
): void {
	const root = memoryRoot;
	let durableWrites = 0;

	pi.registerTool({
		name: "read",
		label: "Read memory file",
		description: "Read a topic file under .memory/.",
		parameters: ReadSchema,
		async execute(_id: string, params: ReadInput): Promise<ToolText> {
			const abs = resolveWithinMemory(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
			return ok(readFileSync(abs, "utf-8"));
		},
	});

	pi.registerTool({
		name: "write",
		label: "Write memory file",
		description: "Create or overwrite a topic file under .memory/ (atomic). Do not write INDEX.md.",
		parameters: WriteSchema,
		async execute(_id: string, params: WriteInput): Promise<ToolText> {
			const abs = resolveWithinMemory(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (/(^|[\\/])INDEX\.md$/i.test(params.path)) return fail("INDEX.md is generated automatically; do not write it");
			atomicWrite(abs, params.content);
			durableWrites++;
			return ok(`Wrote ${params.path} (${params.content.length} bytes).`);
		},
	});

	pi.registerTool({
		name: "edit",
		label: "Edit memory file",
		description: "Replace an exact substring in a topic file under .memory/ (atomic).",
		parameters: EditSchema,
		async execute(_id: string, params: EditInput): Promise<ToolText> {
			const abs = resolveWithinMemory(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (/(^|[\\/])INDEX\.md$/i.test(params.path)) return fail("INDEX.md is generated automatically; do not edit it");
			if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
			const current = readFileSync(abs, "utf-8");
			const occurrences = current.split(params.oldText).length - 1;
			if (occurrences === 0) return fail("oldText not found");
			if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
			atomicWrite(abs, current.replace(params.oldText, params.newText));
			durableWrites++;
			return ok(`Edited ${params.path}.`);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "List memory files",
		description: "List files under .memory/.",
		parameters: LsSchema,
		async execute(_id: string, params: LsInput): Promise<ToolText> {
			const abs = resolveWithinMemory(root, params.path ?? ".");
			if (!abs) return fail("path escapes .memory/");
			if (!existsSync(abs)) return ok("(.memory/ is empty)");
			const entries = readdirSync(abs).filter((name) => !name.startsWith("."));
			return ok(entries.length > 0 ? entries.sort().join("\n") : "(empty)");
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Search memory files",
		description: "Search topic files under .memory/ with a regular expression.",
		parameters: GrepSchema,
		async execute(_id: string, params: GrepInput): Promise<ToolText> {
			let re: RegExp;
			try {
				re = new RegExp(params.pattern);
			} catch (error) {
				return fail(`invalid regex: ${(error as Error).message}`);
			}
			const base = resolveWithinMemory(root, params.path ?? ".");
			if (!base) return fail("path escapes .memory/");
			if (!existsSync(base)) return ok("(no matches)");
			const files = statSync(base).isDirectory() ? listFilesRecursive(base) : [base];
			const hits: string[] = [];
			for (const file of files) {
				const lines = readFileSync(file, "utf-8").split("\n");
				const relPath = relative(root, file);
				lines.forEach((line, i) => {
					if (re.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
				});
				if (hits.length >= 200) break;
			}
			return ok(hits.length > 0 ? hits.join("\n") : "(no matches)");
		},
	});

	pi.registerTool({
		name: "finish_consolidation",
		label: "Finish consolidation",
		description:
			"Finish this consolidation run. Writes a durable acknowledgement naming the observations handled; " +
			"the orchestrator only then tombstones them. Call this after your final .memory/ edit.",
		parameters: FinishSchema,
		async execute(_id: string, params: FinishInput): Promise<ToolText> {
			const discardedAll = params.discardedAll === true;
			if (durableWrites === 0 && !discardedAll) {
				return fail(
					"no durable write yet: write or edit at least one topic file, or pass discardedAll: true to discard the whole batch",
				);
			}
			if (!options.resultPath) return fail("OM_RESULT_PATH is not set; cannot acknowledge");
			let observationTimestamps: string[] = [];
			if (options.batchPath) {
				try {
					observationTimestamps = readConsolidationBatch(options.batchPath).observationTimestamps;
				} catch {
					return fail("could not read the handed batch; refusing to acknowledge");
				}
			}
			writeConsolidationAck(options.resultPath, {
				observationTimestamps,
				durableWrites,
				discardedAll,
				completedAt: new Date().toISOString(),
			});
			return {
				...ok(
					`Consolidation acknowledged: ${observationTimestamps.length} observation(s), ${durableWrites} durable write(s)` +
						`${discardedAll ? ", whole batch discarded" : ""}.`,
				),
				terminate: true,
			};
		},
	});
}
