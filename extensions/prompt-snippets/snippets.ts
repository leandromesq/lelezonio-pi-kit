/**
 * Snippet model and loading for the prompt-snippets extension.
 *
 * Each snippet is a markdown file in the `snippets/` directory next to the
 * extension entry point. The frontmatter carries a display name, description,
 * placement (prepend or append), and sort order. The body after the
 * frontmatter is the prompt text merged into user messages.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Snippet {
  /** Filename, e.g. "concise.md". */
  id: string;
  name: string;
  description: string;
  placement: "prepend" | "append";
  order: number;
  body: string;
}

const DEFAULT_ORDER = 9999;

/** Parse a snippet file. Returns null for files without a usable frontmatter or body. */
export function parseSnippet(filename: string, raw: string): Snippet | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv)
      meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }

  const body = match[2].trim();
  if (!body) return null;

  const parsedOrder = Number.parseInt(meta.order ?? "", 10);
  return {
    id: filename,
    name: meta.name || filename.replace(/\.md$/i, ""),
    description: meta.description ?? "",
    placement: meta.placement === "prepend" ? "prepend" : "append",
    order: Number.isFinite(parsedOrder) ? parsedOrder : DEFAULT_ORDER,
    body,
  };
}

/** Load every snippet in `dir`, sorted: prepend group first, append group last, each by (order, name). */
export function loadSnippets(dir: string): Snippet[] {
  if (!existsSync(dir)) return [];
  const snippets: Snippet[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    try {
      const snippet = parseSnippet(file, readFileSync(join(dir, file), "utf8"));
      if (snippet) snippets.push(snippet);
    } catch {
      // Skip unreadable files
    }
  }
  const byOrder = (a: Snippet, b: Snippet) =>
    a.order - b.order || a.name.localeCompare(b.name);
  return [
    ...snippets.filter((s) => s.placement === "prepend").sort(byOrder),
    ...snippets.filter((s) => s.placement === "append").sort(byOrder),
  ];
}
