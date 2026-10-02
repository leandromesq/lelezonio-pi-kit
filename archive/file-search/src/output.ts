/**
 * Shared output shaping for the fd and rg tools: standard pi truncation
 * (2000 lines / 50KB) with the full output persisted to a temp file when
 * anything is cut off.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export interface FormattedOutput {
  readonly text: string;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface CapturedOutput {
  readonly preview: string;
  readonly lineCount: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

/**
 * Machine-readable result declared by the fd/rg `outputSchema`, so codemode
 * scripts receive the match list instead of the formatted text.
 */
export type SearchStructuredOutput = {
  files?: string[];
  matches?: string[];
  count: number;
  truncated: boolean;
  full_output_path?: string;
};

/**
 * Build the structured content from the bounded captured preview (the same
 * bound the model-facing text uses). `count` is the total before truncation.
 */
export function searchStructuredContent(
  kind: "fd" | "rg",
  captured: CapturedOutput,
): SearchStructuredOutput {
  const trimmed = captured.preview.replace(/\n+$/, "");
  const entries = trimmed === "" ? [] : trimmed.split("\n");
  return {
    ...(kind === "fd" ? { files: entries } : { matches: entries }),
    count: captured.lineCount,
    truncated: captured.truncated,
    ...(captured.truncated && captured.fullOutputPath
      ? { full_output_path: captured.fullOutputPath }
      : {}),
  };
}

export interface FormatOutputOptions {
  /** Temp-file prefix, e.g. "pi-fd-". */
  readonly tempPrefix: string;
  /** Injectable for tests. */
  readonly persistFullOutput?: (output: string) => Promise<string>;
}

async function persistToTempFile(prefix: string, output: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const path = join(directory, "output.txt");
  await writeFile(path, output, "utf8");
  return path;
}

function truncationNotice(options: {
  content: string;
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
  fullOutputPath: string;
}) {
  return (
    `${options.content}\n\n[Output truncated: ${options.outputLines} of ${options.totalLines} lines ` +
    `(${formatSize(options.outputBytes)} of ${formatSize(options.totalBytes)}). ` +
    `Full output saved to: ${options.fullOutputPath}]`
  );
}

/** Format output already captured by a bounded-memory streaming process. */
export function formatCapturedOutput(captured: CapturedOutput) {
  const trimmed = captured.preview.replace(/\n+$/, "");
  if (!captured.truncated || !captured.fullOutputPath) {
    return {
      text: trimmed,
      lineCount: captured.lineCount,
      truncated: false,
    } satisfies FormattedOutput;
  }

  const truncation = truncateHead(trimmed, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const content = truncation.content;
  const outputLines = content === "" ? 0 : content.split("\n").length;
  const outputBytes = Buffer.byteLength(content);
  return {
    text: truncationNotice({
      content,
      outputLines,
      totalLines: captured.lineCount,
      outputBytes,
      totalBytes: captured.totalBytes,
      fullOutputPath: captured.fullOutputPath,
    }),
    lineCount: captured.lineCount,
    truncated: true,
    fullOutputPath: captured.fullOutputPath,
  } satisfies FormattedOutput;
}

/** Truncate to pi's standard limits, persisting the full output when cut. */
export async function formatOutput(
  output: string,
  options: FormatOutputOptions,
): Promise<FormattedOutput> {
  const trimmed = output.replace(/\n+$/, "");
  const lineCount = trimmed === "" ? 0 : trimmed.split("\n").length;

  const truncation = truncateHead(trimmed, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: trimmed, lineCount, truncated: false };
  }

  const persist =
    options.persistFullOutput ??
    ((full: string) => persistToTempFile(options.tempPrefix, full));
  const fullOutputPath = await persist(trimmed);

  const text = truncationNotice({
    content: truncation.content,
    outputLines: truncation.outputLines,
    totalLines: truncation.totalLines,
    outputBytes: truncation.outputBytes,
    totalBytes: truncation.totalBytes,
    fullOutputPath,
  });

  return { text, lineCount, truncated: true, fullOutputPath };
}
