import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  appendStatusLines,
  buildFooterContent,
  buildGitLine,
  computeContextUsage,
  contextBar,
  contextColor,
  CONTEXT_BAR_CELLS,
  CONTEXT_MINI_BAR_CELLS,
  decorateThinkingBorder,
  footerLayout,
  isDetachedGit,
  MEDIUM_MIN_WIDTH,
  thinkingBadgeLabel,
  truncateLeftToWidth,
  type FooterContent,
  type FooterTheme,
  WIDE_MIN_WIDTH,
} from "./index.ts";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  type GitInfoState,
  type ModelInfoState,
} from "../shared/dashboard-state.ts";

const plainTheme: FooterTheme = { fg: (_color, text) => text };

function content(overrides: Partial<FooterContent> = {}): FooterContent {
  return {
    directory: "~/work/app",
    git: "feature/x · +3 · PR #12",
    model: "openai/gpt-4o",
    usage: "▓▓▓▓░░░░░░ 42% · 84k/200k · $0.12",
    context: "▓▓▓▓░░░░░░ 42% · 84k/200k",
    contextPercent: "42% ▓▓▓░░░",
    ...overrides,
  };
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("footer responsive layout", () => {
  it("keeps every data point at wide widths", () => {
    assert.ok(WIDE_MIN_WIDTH >= MEDIUM_MIN_WIDTH);
    const lines = footerLayout(content(), 120);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /work\/app/);
    assert.match(lines[0]!, /openai\/gpt-4o/);
    assert.match(lines[1]!, /feature\/x · \+3 · PR #12/);
    assert.match(lines[1]!, /▓▓▓▓░░░░░░ 42% · 84k\/200k · \$0\.12/);
  });

  it("shows directory and model with the full context indicator at medium widths", () => {
    const lines = footerLayout(content(), 90);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /work\/app/);
    assert.match(lines[0]!, /openai\/gpt-4o/);
    assert.match(lines[1]!, /▓▓▓▓░░░░░░ 42% · 84k\/200k/);
    // Git and cost are wide-band data points only.
    const joined = lines.join("\n");
    assert.doesNotMatch(joined, /feature\/x/);
    assert.doesNotMatch(joined, /\$0\.12/);
  });

  it("shows the directory with the compact context indicator at narrow widths", () => {
    const lines = footerLayout(content(), 60);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /work\/app/);
    assert.match(lines[0]!, /42%/);
    const joined = lines.join("\n");
    assert.doesNotMatch(joined, /feature\/x/);
    assert.doesNotMatch(joined, /gpt-4o/);
    assert.doesNotMatch(joined, /200k/);
    assert.doesNotMatch(joined, /\$0\.12/);
  });

  it("keeps the indicator flush right when everything fits", () => {
    const line = footerLayout(content(), 50)[0]!;
    assert.match(line, /work\/app/);
    assert.match(line, /42%/);
    assert.equal(visibleWidth(line), 50);
  });

  it("falls back to '?' when context data is missing", () => {
    const lines = footerLayout(content({ contextPercent: "?% ░░░░░░" }), 40);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\?%/);
    assert.match(lines[0]!, /work\/app/);
  });

  it("keeps '42%' and the directory tail visible at every narrow width", () => {
    // Below ~20 columns the footer is degenerate; from width 20 up the
    // compact line always keeps 'NN%' — the mini-bar (not the percentage)
    // is what gets sacrificed — and the directory either fits whole or is
    // an ANSI-safe tail truncation that never loses its end.
    for (const width of [20, 21, 22, 25, 26, 30, 40, 50, 60, 79]) {
      for (const directory of [
        "~/work/app",
        "C:\\very\\long\\directory\\that\\keeps\\going\\on\\and\\on",
      ]) {
        const lines = footerLayout(content({ directory }), width);
        assert.equal(lines.length, 1);
        assert.ok(
          visibleWidth(lines[0]!) <= width,
          `line exceeds width ${width}`,
        );
        assert.match(
          lines[0]!,
          /42%/,
          `compact band must keep '42%' at width ${width} (dir: ${directory})`,
        );
        assert.match(
          lines[0]!,
          /app|and\\on/,
          `directory must stay visible at width ${width} (dir: ${directory})`,
        );
      }
    }
  });

  it("uses the documented breakpoints", () => {
    assert.equal(MEDIUM_MIN_WIDTH, 80);
    assert.equal(WIDE_MIN_WIDTH, 100);
    // narrow -> medium: the compact line gains the model and the full
    // context line underneath
    assert.equal(footerLayout(content(), MEDIUM_MIN_WIDTH - 1).length, 1);
    assert.equal(footerLayout(content(), MEDIUM_MIN_WIDTH).length, 2);
    assert.match(
      footerLayout(content(), MEDIUM_MIN_WIDTH).join("\n"),
      /work\/app/,
    );
    // medium -> wide: git and cost only return at the wide band
    assert.doesNotMatch(
      footerLayout(content(), WIDE_MIN_WIDTH - 1).join("\n"),
      /\$0\.12/,
    );
    assert.doesNotMatch(
      footerLayout(content(), WIDE_MIN_WIDTH - 1).join("\n"),
      /feature\/x/,
    );
    assert.match(footerLayout(content(), WIDE_MIN_WIDTH).join("\n"), /\$0\.12/);
    assert.match(
      footerLayout(content(), WIDE_MIN_WIDTH).join("\n"),
      /feature\/x/,
    );
  });

  it("never exceeds the available width at any band", () => {
    const longContent = content({
      directory: "C:\\very\\long\\directory\\that\\keeps\\going\\on\\and\\on",
    });
    for (const width of [30, 40, 55, 60, 70, 79, 80, 90, 99, 100, 120, 200]) {
      for (const lines of [
        footerLayout(content(), width),
        footerLayout(longContent, width),
        footerLayout(content({ git: "", model: "" }), width),
      ]) {
        for (const line of lines) {
          assert.ok(
            visibleWidth(line) <= width,
            `line ${JSON.stringify(line)} exceeds width ${width}`,
          );
        }
      }
    }
  });

  it("keeps ANSI-colored lines within the width", () => {
    const coloredTheme: FooterTheme = {
      fg: (_color, text) => `\u001b[31m${text}\u001b[0m`,
    };
    const base = content();
    const colored: FooterContent = {
      directory: coloredTheme.fg("text", base.directory),
      git: coloredTheme.fg("muted", base.git),
      model: coloredTheme.fg("muted", base.model),
      usage: coloredTheme.fg("muted", base.usage),
      context: coloredTheme.fg("muted", base.context),
      contextPercent: coloredTheme.fg("muted", base.contextPercent),
    };
    for (const width of [30, 45, 60, 80, 90, 120]) {
      for (const line of footerLayout(colored, width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `ANSI line exceeds width ${width}`,
        );
        assert.ok(visibleWidth(stripAnsi(line)) <= width);
        assert.ok(
          !/^[\u001b[\]0-9;m]*$/.test(line),
          "content was truncated away",
        );
      }
    }
  });
});

describe("truncateLeftToWidth", () => {
  const ansi = (text: string) => `\u001b[31m${text}\u001b[39m`;

  it("returns the text unchanged when it fits", () => {
    assert.equal(truncateLeftToWidth("~/work/app", 30), "~/work/app");
  });

  it("keeps the tail with a leading ellipsis", () => {
    const result = truncateLeftToWidth("C:\\very\\long\\path\\demo", 15);
    assert.ok(result.startsWith("…"));
    assert.ok(result.endsWith("demo"));
    assert.ok(visibleWidth(result) <= 15);
  });

  it("is ANSI-safe: re-opens the color and restores the reset", () => {
    const result = truncateLeftToWidth(ansi("C:\\very\\long\\path\\demo"), 15);
    assert.ok(result.startsWith("…\u001b[31m"));
    assert.ok(result.endsWith("\u001b[39m"));
    assert.match(result, /demo\u001b\[39m$/);
    assert.ok(visibleWidth(result) <= 15);
    assert.ok(visibleWidth(stripAnsi(result)) <= 15);
  });

  it("returns only the ellipsis when nothing else fits", () => {
    assert.equal(truncateLeftToWidth("C:\\very\\long\\path", 1), "…");
  });

  it("handles zero width defensively", () => {
    assert.equal(truncateLeftToWidth("anything", 0), "");
  });
});

describe("buildFooterContent", () => {
  it("composes git, model, and usage pieces from state", () => {
    const gitInfo: GitInfoState = {
      ...emptyGitInfoState(),
      isRepository: true,
      branch: "main",
      changedFiles: 2,
      pullRequest: {
        number: 42,
        url: "https://example.com/pr/42",
        isDraft: false,
      },
    };
    const modelInfo: ModelInfoState = {
      ...emptyModelInfoState(),
      provider: "openai",
      modelId: "gpt-4o",
      thinking: "high",
      contextTokens: 84_000,
      contextWindow: 200_000,
      contextPercent: 42,
      cost: 0.12,
    };
    const result = buildFooterContent(
      "C:\\src\\demo",
      gitInfo,
      modelInfo,
      plainTheme,
      false,
    );
    assert.match(result.directory, /demo/);
    assert.equal(result.git, "main · +2 · PR #42");
    assert.equal(result.model, "openai/gpt-4o");
    assert.equal(result.usage, "▓▓▓▓░░░░░░ 42% · 84k/200k · $0.12");
    assert.equal(result.context, "▓▓▓▓░░░░░░ 42% · 84k/200k");
    assert.equal(result.contextPercent, "42% ▓▓▓░░░");
  });

  it("never leaks thinking levels into the footer (border badge only)", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const thinking of levels) {
      const modelInfo: ModelInfoState = {
        ...emptyModelInfoState(),
        provider: "openai",
        modelId: "gpt-4o",
        thinking,
      };
      const result = buildFooterContent(
        "C:\\src\\demo",
        emptyGitInfoState(),
        modelInfo,
        plainTheme,
        false,
      );
      const combined = [
        result.directory,
        result.git,
        result.model,
        result.usage,
        result.context,
        result.contextPercent,
      ].join("\n");
      assert.equal(
        result.model,
        "openai/gpt-4o",
        `model must be provider/modelId only for thinking=${thinking}`,
      );
      assert.doesNotMatch(
        combined,
        /\b(off|minimal|low|medium|high|xhigh|max)\b/i,
        `footer must not contain thinking level ${thinking}`,
      );
    }
  });

  it("omits git and PR parts when there is no branch", () => {
    const result = buildFooterContent(
      "C:\\src\\demo",
      emptyGitInfoState(),
      emptyModelInfoState(),
      plainTheme,
      false,
    );
    assert.equal(result.git, "");
  });

  it("colors model identity through the theme but keeps the thinking level out of the footer", () => {
    const taggedTheme: FooterTheme = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
    };
    const modelInfo: ModelInfoState = {
      ...emptyModelInfoState(),
      provider: "openai",
      modelId: "gpt-4o",
      thinking: "medium",
    };
    const result = buildFooterContent(
      "C:\\src\\demo",
      emptyGitInfoState(),
      modelInfo,
      taggedTheme,
      false,
    );
    assert.equal(result.model, "<muted>openai/gpt-4o</muted>");
    assert.doesNotMatch(result.model, /medium|thinkingMedium/i);
  });

  it("sanitizes control sequences from the directory label", () => {
    const result = buildFooterContent(
      "C:\\src\\bad\u001b[31mred\u001b[0m",
      emptyGitInfoState(),
      emptyModelInfoState(),
      plainTheme,
      false,
    );
    assert.equal(result.directory, "C:\\src\\badred");
  });

  it("uses '?' placeholders when context data is missing", () => {
    const result = buildFooterContent(
      "C:\\src\\demo",
      emptyGitInfoState(),
      emptyModelInfoState(),
      plainTheme,
      false,
    );
    assert.equal(result.usage, "░░░░░░░░░░ ?% · ?/? · $0.00");
    assert.equal(result.context, "░░░░░░░░░░ ?% · ?/?");
    assert.equal(result.contextPercent, "?% ░░░░░░");
  });
});

describe("buildGitLine", () => {
  const taggedTheme: FooterTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };
  const at = (overrides: Partial<GitInfoState> = {}) =>
    buildGitLine({ ...emptyGitInfoState(), ...overrides }, taggedTheme, false);

  it("stays empty without a branch (non-repositories included)", () => {
    assert.equal(at(), "");
    assert.equal(at({ isRepository: true }), "");
  });

  it("shows a clean tree as 'clean' in success", () => {
    assert.equal(
      at({ branch: "main", changedFiles: 0 }),
      "<muted>main</muted> · <success>clean</success>",
    );
  });

  it("shows changes compactly as +N in warning", () => {
    assert.equal(
      at({ branch: "feature/x", changedFiles: 3 }),
      "<muted>feature/x</muted> · <warning>+3</warning>",
    );
  });

  it("flags a detached HEAD branch in warning", () => {
    assert.equal(
      at({ branch: "detached@abc1234", changedFiles: 1 }),
      "<warning>detached@abc1234</warning> · <warning>+1</warning>",
    );
    assert.equal(
      at({ branch: "detached" }),
      "<warning>detached</warning> · <success>clean</success>",
    );
  });

  it("colors a normal PR in accent", () => {
    assert.equal(
      at({
        branch: "feature/x",
        changedFiles: 2,
        pullRequest: {
          number: 12,
          url: "https://example.com/pr/12",
          isDraft: false,
        },
      }),
      "<muted>feature/x</muted> · <warning>+2</warning> · <accent>PR #12</accent>",
    );
  });

  it("colors a draft PR in dim", () => {
    assert.equal(
      at({
        branch: "feature/x",
        changedFiles: 0,
        pullRequest: {
          number: 12,
          url: "https://example.com/pr/12",
          isDraft: true,
        },
      }),
      "<muted>feature/x</muted> · <success>clean</success> · <dim>PR #12</dim>",
    );
  });

  it("keeps the PR hyperlink when enabled, without adding width", () => {
    const state: GitInfoState = {
      ...emptyGitInfoState(),
      branch: "feature/x",
      changedFiles: 2,
      pullRequest: {
        number: 12,
        url: "https://example.com/pr/12",
        isDraft: false,
      },
    };
    const linked = buildGitLine(state, taggedTheme, true);
    assert.ok(
      linked.includes(
        "\u001b]8;;https://example.com/pr/12\u001b\\PR #12\u001b]8;;\u001b\\",
      ),
    );
    assert.equal(
      visibleWidth(linked),
      visibleWidth(buildGitLine(state, taggedTheme, false)),
    );
  });

  it("detects detached branches by the git-info convention", () => {
    assert.equal(isDetachedGit("detached@abc1234"), true);
    assert.equal(isDetachedGit("detached"), true);
    assert.equal(isDetachedGit("main"), false);
    assert.equal(isDetachedGit("feature/detached@1"), false);
  });

  it("keeps colors and hyperlinks within the width at wide widths", () => {
    const ansiTheme: FooterTheme = {
      fg: (_color, text) => `\u001b[31m${text}\u001b[39m`,
    };
    const gitInfo: GitInfoState = {
      ...emptyGitInfoState(),
      isRepository: true,
      branch: "detached@abcdef",
      changedFiles: 4,
      pullRequest: {
        number: 12,
        url: "https://example.com/pr/12",
        isDraft: false,
      },
    };
    const contentPiece = buildFooterContent(
      "C:\\src\\demo",
      gitInfo,
      emptyModelInfoState(),
      ansiTheme,
      true,
    );
    for (const line of footerLayout(contentPiece, 120)) {
      assert.ok(visibleWidth(line) <= 120);
      assert.ok(visibleWidth(stripAnsi(line)) <= 120);
      assert.ok(
        !/^[\u001b[\]0-9;m]*$/.test(line),
        "content was truncated away",
      );
    }
  });
});

describe("computeContextUsage", () => {
  const base = { ...emptyModelInfoState(), contextWindow: 200_000 };

  it("uses contextTokens when available", () => {
    assert.deepEqual(
      computeContextUsage({
        ...base,
        contextTokens: 100_000,
        contextPercent: 50,
      }),
      { percent: 50, usedTokens: 100_000, windowTokens: 200_000 },
    );
  });

  it("derives used tokens from percent × window when tokens are absent", () => {
    assert.deepEqual(
      computeContextUsage({ ...base, contextTokens: null, contextPercent: 63 }),
      { percent: 63, usedTokens: 126_000, windowTokens: 200_000 },
    );
  });

  it("derives percent from used tokens when percent is absent", () => {
    assert.deepEqual(
      computeContextUsage({
        ...base,
        contextTokens: 126_000,
        contextPercent: null,
      }),
      { percent: 63, usedTokens: 126_000, windowTokens: 200_000 },
    );
  });

  it("keeps nulls when nothing is available", () => {
    assert.deepEqual(computeContextUsage(emptyModelInfoState()), {
      percent: null,
      usedTokens: null,
      windowTokens: null,
    });
  });

  it("treats non-finite values as missing", () => {
    assert.deepEqual(
      computeContextUsage({
        ...base,
        contextTokens: Number.NaN,
        contextPercent: Number.POSITIVE_INFINITY,
      }),
      { percent: null, usedTokens: null, windowTokens: 200_000 },
    );
  });

  it("clamps out-of-range percents to 0–100", () => {
    assert.equal(
      computeContextUsage({ ...base, contextTokens: null, contextPercent: 150 })
        .percent,
      100,
    );
    assert.equal(
      computeContextUsage({ ...base, contextTokens: null, contextPercent: -5 })
        .percent,
      0,
    );
  });

  it("derives used tokens from the clamped percent", () => {
    assert.equal(
      computeContextUsage({ ...base, contextTokens: null, contextPercent: 150 })
        .usedTokens,
      200_000,
    );
  });
});

describe("contextColor thresholds", () => {
  it("uses muted below 60% and for unknown values", () => {
    assert.equal(contextColor(null), "muted");
    assert.equal(contextColor(0), "muted");
    assert.equal(contextColor(59.9), "muted");
  });

  it("uses warning from 60% to 80% inclusive", () => {
    assert.equal(contextColor(60), "warning");
    assert.equal(contextColor(63), "warning");
    assert.equal(contextColor(80), "warning");
  });

  it("uses error above 80%", () => {
    assert.equal(contextColor(80.1), "error");
    assert.equal(contextColor(100), "error");
  });
});

describe("contextBar", () => {
  it("fills cells proportional to the percent", () => {
    assert.equal(contextBar(63, CONTEXT_BAR_CELLS), "▓▓▓▓▓▓░░░░");
    assert.equal(contextBar(42, CONTEXT_BAR_CELLS), "▓▓▓▓░░░░░░");
    assert.equal(contextBar(50, CONTEXT_MINI_BAR_CELLS), "▓▓▓░░░");
  });

  it("renders empty for 0% or unknown, full for 100%", () => {
    assert.equal(contextBar(0, 10), "░".repeat(10));
    assert.equal(contextBar(null, 10), "░".repeat(10));
    assert.equal(contextBar(100, 10), "▓".repeat(10));
  });

  it("clamps out-of-range percents defensively", () => {
    assert.equal(contextBar(150, 10), "▓".repeat(10));
    assert.equal(contextBar(-10, 10), "░".repeat(10));
  });
});

describe("context indicator threshold colors", () => {
  const taggedTheme: FooterTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };
  const base = { ...emptyModelInfoState(), contextWindow: 200_000 };
  const at = (contextPercent: number | null, contextTokens: number | null) =>
    buildFooterContent(
      "C:\\src\\demo",
      emptyGitInfoState(),
      { ...base, contextPercent, contextTokens },
      taggedTheme,
      false,
    );

  it("colors the full indicator by threshold", () => {
    assert.equal(
      at(50, 100_000).context,
      "<muted>▓▓▓▓▓░░░░░ 50% · 100k/200k</muted>",
    );
    assert.equal(
      at(63, 126_000).context,
      "<warning>▓▓▓▓▓▓░░░░ 63% · 126k/200k</warning>",
    );
    assert.equal(
      at(80, 160_000).context,
      "<warning>▓▓▓▓▓▓▓▓░░ 80% · 160k/200k</warning>",
    );
    assert.equal(
      at(80.1, 161_000).context,
      "<error>▓▓▓▓▓▓▓▓░░ 80% · 161k/200k</error>",
    );
    assert.equal(
      at(null, null).context,
      "<muted>░░░░░░░░░░ ?% · ?/200k</muted>",
    );
  });

  it("colors the compact indicator by the same thresholds", () => {
    assert.equal(at(50, 100_000).contextPercent, "<muted>50% ▓▓▓░░░</muted>");
    assert.equal(
      at(63, 126_000).contextPercent,
      "<warning>63% ▓▓▓▓░░</warning>",
    );
  });
});

describe("appendStatusLines", () => {
  it("appends status lines truncated to the width", () => {
    const statuses = new Map([
      ["zed", "first line\nthis second line is quite long indeed"],
    ]);
    const lines = appendStatusLines([], statuses, 20, plainTheme);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(visibleWidth(line) <= 20);
  });

  it("orders statuses by key", () => {
    const lines = appendStatusLines(
      [],
      new Map([
        ["zeta", "z"],
        ["alpha", "a"],
      ]),
      40,
      plainTheme,
    );
    assert.deepEqual(lines, ["a", "z"]);
  });

  it("keeps statuses working alongside the responsive layout", () => {
    const layout = footerLayout(content(), 80);
    const lines = appendStatusLines(
      layout,
      new Map([["worker", "running"]]),
      80,
      plainTheme,
    );
    assert.equal(lines.length, 3);
    assert.equal(lines[2], "running");
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
  });
});

describe("thinkingBadgeLabel", () => {
  it("uppercases thinking levels", () => {
    assert.equal(thinkingBadgeLabel("high"), "HIGH");
    assert.equal(thinkingBadgeLabel("medium"), "MEDIUM");
    assert.equal(thinkingBadgeLabel("off"), "OFF");
    assert.equal(thinkingBadgeLabel("minimal"), "MINIMAL");
    assert.equal(thinkingBadgeLabel("xhigh"), "XHIGH");
    assert.equal(thinkingBadgeLabel("max"), "MAX");
  });

  it("survives surrounding whitespace", () => {
    assert.equal(thinkingBadgeLabel("  high  "), "HIGH");
  });
});

describe("decorateThinkingBorder", () => {
  const plain = (text: string) => text;
  const ansi = (text: string) => `\u001b[31m${text}\u001b[0m`;
  const border = (width: number) => ansi("─".repeat(width));

  it("carves a right-aligned badge out of the border", () => {
    const line = decorateThinkingBorder(border(20), "HIGH", plain, 20);
    assert.equal(stripAnsi(line), "─".repeat(20 - 6) + " HIGH ");
    assert.equal(visibleWidth(line), 20);
    assert.ok(line.endsWith(" HIGH "));
  });

  it("shares the semantic color between badge and border", () => {
    const tagged = (text: string) => `<thinkingHigh>${text}</thinkingHigh>`;
    const line = decorateThinkingBorder(border(20), "HIGH", tagged, 20);
    assert.ok(line.startsWith("<thinkingHigh>─"));
    assert.ok(line.endsWith("<thinkingHigh> HIGH </thinkingHigh>"));
  });

  it("stays exactly within the width for every thinking level", () => {
    for (const level of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      for (const width of [10, 14, 20, 40, 80, 120]) {
        const label = thinkingBadgeLabel(level);
        const line = decorateThinkingBorder(border(width), label, plain, width);
        assert.ok(visibleWidth(line) <= width, `${level} at width ${width}`);
      }
    }
  });

  it("drops the badge with a plain border when the terminal is too narrow", () => {
    // " HIGH " needs 6 columns. At width 5 there is no room, so the label
    // is omitted and the border is returned untouched.
    assert.equal(
      decorateThinkingBorder(border(5), "HIGH", plain, 5),
      border(5),
    );
  });

  it("preserves a scroll indicator on the left while adding the badge", () => {
    const scroll = ansi("─── ↓ 3 more " + "─".repeat(7));
    const line = decorateThinkingBorder(scroll, "HIGH", plain, 20);
    assert.ok(line.startsWith("─── ↓ 3 more "));
    assert.ok(line.endsWith(" HIGH "));
    assert.equal(visibleWidth(line), 20);
  });

  it("defaults to the plain border when the label is empty", () => {
    assert.equal(decorateThinkingBorder(border(20), "", plain, 20), border(20));
  });
});
