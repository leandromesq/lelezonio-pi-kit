/** Types for the zero-dependency pane viewer implemented in takeover-viewer.mjs. */

export const TAKE_OVER_PROTOCOL: number;
export function stripAnsi(text: string): string;
export function parseIncomingLine(line: string): {
  frame?: any;
  error?: string;
};
export function shortElapsed(since?: number): string;
export function truncateToWidth(line: string, width: number): string;
export function createViewerState(): any;
export function applyKey(
  state: any,
  key: string,
): {
  state: any;
  events: Array<{ type: string; name?: string; text?: string }>;
};
export function buildLines(state: any, width: number, height: number): string[];
export function classifyKey(
  ch: string,
  esc: { part: string },
): string | undefined;
export function mainViewer(): void;
