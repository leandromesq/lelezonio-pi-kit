import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Height available to a body after fixed chrome, clamped for tiny terminals. */
export function viewportRows(
  terminalRows: number,
  chromeRows: number,
  minimum = 1,
): number {
  const rows =
    Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 30;
  return Math.max(minimum, Math.floor(rows) - Math.max(0, chromeRows));
}

/** Clamp a top-based scroll offset and return a stable viewport plus overflow counts. */
export function sliceViewport<T>(
  items: readonly T[],
  offset: number,
  capacity: number,
) {
  const size = Math.max(1, Math.floor(capacity));
  const maxOffset = Math.max(0, items.length - size);
  const start = Math.min(maxOffset, Math.max(0, Math.floor(offset)));
  return {
    items: items.slice(start, start + size),
    offset: start,
    above: start,
    below: Math.max(0, items.length - start - size),
    maxOffset,
  };
}

/** ANSI-aware paragraph wrapping whose returned lines always fit the width. */
export function wrapViewportText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const paragraphs = text.split("\n");
  return paragraphs.flatMap((paragraph) =>
    paragraph.length === 0
      ? [""]
      : wrapTextWithAnsi(paragraph, safeWidth).map((line) =>
          truncateToWidth(line, safeWidth),
        ),
  );
}
