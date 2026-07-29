import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function buildTranscriptLines(text: string, width: number) {
  const lines: string[] = [];
  for (const raw of sanitizeText(text).split("\n")) {
    const segment = raw.split("\r").at(-1) ?? "";
    if (!segment) lines.push("");
    else lines.push(...wrapTextWithAnsi(segment, Math.max(10, width)));
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
