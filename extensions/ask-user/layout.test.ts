import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  pageQuestionScroll,
  renderAskUserLayout,
  type AskUserLayoutOption,
  type AskUserLayoutTheme,
} from "./src/layout.ts";

const options: AskUserLayoutOption[] = [
  { label: "Alpha", description: "The first choice." },
  { label: "Beta", description: "The second choice." },
  { label: "Gamma", description: "The third choice." },
  { label: "Delta", description: "The fourth choice." },
  { label: "Epsilon", description: "The fifth choice." },
  { label: "Write my own answer…", isOther: true },
];

const plainTheme: AskUserLayoutTheme = {
  accent: (text) => text,
  bold: (text) => text,
  border: (text) => text,
  dim: (text) => text,
  muted: (text) => text,
  text: (text) => text,
};

const ansiTheme: AskUserLayoutTheme = {
  accent: (text) => `\u001b[35m${text}\u001b[39m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  border: (text) => `\u001b[36m${text}\u001b[39m`,
  dim: (text) => `\u001b[2m${text}\u001b[22m`,
  muted: (text) => `\u001b[90m${text}\u001b[39m`,
  text: (text) => `\u001b[37m${text}\u001b[39m`,
};

function render(
  overrides: Partial<Parameters<typeof renderAskUserLayout>[0]> = {},
) {
  return renderAskUserLayout(
    {
      width: 32,
      terminalRows: 24,
      question: "Which deployment strategy should we use for this release?",
      options,
      optionIndex: 0,
      questionScroll: 0,
      detailsExpanded: false,
      editMode: false,
      ...overrides,
    },
    plainTheme,
  );
}

test("short terminals keep the question, every option, and controls visible", () => {
  const result = render({
    width: 24,
    terminalRows: 12,
    question: "A ".repeat(100),
  });

  assert.ok(result.lines[0]?.includes("↓"));
  for (const option of options) {
    assert.ok(
      result.lines.some((line) => line.includes(option.label.slice(0, 5))),
      `missing option ${option.label}`,
    );
  }
  assert.ok(result.lines.some((line) => line.includes("Enter Esc")));
  assert.ok(result.lines.length <= 10);
});

test("narrow terminals truncate compact option rows without losing their rows", () => {
  const result = render({
    width: 12,
    terminalRows: 11,
    options: options.map((option) => ({
      ...option,
      label: `${option.label} with a very long label`,
    })),
  });

  assert.equal(
    result.lines.filter((line) => /[1-5]\./.test(line)).length >= 5,
    true,
  );
  for (const line of result.lines) {
    assert.ok(visibleWidth(line) <= 12, `line is too wide: ${line}`);
  }
});

test("multiline selected descriptions wrap in a bounded area", () => {
  const description =
    "First line is intentionally long enough to wrap.\nSecond line remains a separate paragraph.\nThird line proves expansion.";
  const collapsed = render({
    width: 32,
    terminalRows: 24,
    options: [{ ...options[0], description }, ...options.slice(1)],
  });
  const expanded = render({
    width: 32,
    terminalRows: 24,
    detailsExpanded: true,
    options: [{ ...options[0], description }, ...options.slice(1)],
  });

  assert.ok(collapsed.lines.some((line) => line.includes("First line")));
  assert.ok(collapsed.lines.some((line) => line.includes("more")));
  assert.ok(expanded.lines.some((line) => line.includes("Second line")));
  assert.ok(expanded.lines.some((line) => line.includes("Third line")));
  assert.ok(!expanded.lines.some((line) => line.includes("The second choice")));
  assert.ok(expanded.lines.length <= 21);
});

test("question page navigation advances by a viewport page and clamps", () => {
  assert.equal(pageQuestionScroll(0, 1, 20, 5), 4);
  assert.equal(pageQuestionScroll(4, 1, 20, 5), 8);
  assert.equal(pageQuestionScroll(8, -1, 20, 5), 4);
  assert.equal(pageQuestionScroll(8, 1, 6, 5), 1);
  assert.equal(pageQuestionScroll(0, -1, 20, 5), 0);
});

test("the compact custom-answer editor keeps its input row and submit controls", () => {
  const result = render({
    width: 24,
    terminalRows: 12,
    editMode: true,
    editorLines: ["typed custom answer"],
  });

  assert.ok(result.lines.some((line) => line.includes("typed custom answer")));
  assert.ok(result.lines.some((line) => line.includes("Enter submit")));
  assert.ok(result.lines.some((line) => line.includes("Esc")));
  for (const line of result.lines) {
    assert.ok(visibleWidth(line) <= 24, `line is too wide: ${line}`);
  }
});

test("ANSI-styled questions and descriptions stay within the requested width", () => {
  const result = renderAskUserLayout(
    {
      width: 19,
      terminalRows: 18,
      question: `\u001b[31m${"very-long-question-word ".repeat(10)}\u001b[0m`,
      options: options.map((option) => ({
        ...option,
        description: `\u001b[32m${option.description ?? ""} wrapped text\u001b[0m`,
      })),
      optionIndex: 0,
      questionScroll: 0,
      detailsExpanded: true,
      editMode: false,
    },
    ansiTheme,
  );

  for (const line of result.lines) {
    assert.ok(
      visibleWidth(line) <= 19,
      `line is too wide: ${visibleWidth(line)}`,
    );
  }
});
