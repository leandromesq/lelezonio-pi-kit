import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText } from "./terminal-text.ts";

test("OSC, CSI and charset escapes never reach the styled line", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u001b(0alt";
  assert.equal(sanitizeTerminalText(input), "beforeafterredalt");
});

test("transcript policy expands tabs and keeps newlines", () => {
  assert.equal(sanitizeTerminalText("a\tb\nc", { tabWidth: 2 }), "a  b\nc");
});

test("diff policy keeps tabs for the renderer's own alignment", () => {
  assert.equal(sanitizeTerminalText("a\tb", { tabWidth: 0 }), "a\tb");
});

test("single-line labels drop tabs, newlines and C0/C1 controls", () => {
  assert.equal(
    sanitizeTerminalText("a\tb\nc\u0001d", { singleLine: true }),
    "abcd",
  );
});
