/**
 * Buffer entry types for the browser extension's in-memory observation
 * buffers (console + network). Kept free of pi / playwright imports so they
 * can be imported from unit tests without loading any native code.
 */

/** One captured console.log / error / warning / pageerror event. */
export interface ConsoleEntry {
  ts: number;
  type: string;
  text: string;
  location?: string;
}

/** One captured network request, with its outcome and optional headers. */
export interface NetEntry {
  ts: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  failure?: string;
}

/** Data payload of the per-session "browser enabled" custom entry. */
export interface EnabledEntryData {
  on?: boolean;
}
