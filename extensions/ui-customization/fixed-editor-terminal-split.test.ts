/**
 * Behavioral tests for terminal-split compositor exported helpers.
 * Tests pure ANSI escape sequence generators and buildFixedClusterPaint.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beginSynchronizedOutput,
  endSynchronizedOutput,
  setScrollRegion,
  resetScrollRegion,
  moveCursor,
  emergencyTerminalModeReset,
  buildFixedClusterPaint,
  TerminalSplitCompositor,
  type InternalTui,
  type TerminalLike,
} from "./src/fixed-editor/terminal-split.ts";
import type { FixedEditorClusterRender } from "./src/fixed-editor/cluster.ts";

class ProxyTerminal implements TerminalLike {
  columns = 80;
  private readonly height = 24;
  writes: string[] = [];

  get rows() {
    return this.height;
  }

  write(data: string) {
    this.writes.push(data);
  }
}

class ProxyTui {
  readonly terminal: ProxyTerminal;
  doRenderCalls = 0;
  renderCalls = 0;

  constructor(terminal: ProxyTerminal) {
    this.terminal = terminal;
  }

  render(width: number) {
    this.renderCalls += 1;
    return [`root:${width}`];
  }

  doRender() {
    this.doRenderCalls += 1;
    this.render(this.terminal.columns);
  }

  requestRender() {}

  addInputListener() {
    return () => {};
  }
}

function createTuiReference(tui: ProxyTui) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        const value = Reflect.get(tui, property, tui);
        if (typeof value !== "function") return value;

        return (...args: never[]) => {
          const method = Reflect.get(tui, property, tui);
          if (typeof method !== "function") {
            throw new TypeError(`${String(property)} is not callable`);
          }
          return Reflect.apply(method, tui, args);
        };
      },
      set(_target, property, value) {
        return Reflect.set(tui, property, value, tui);
      },
      getPrototypeOf: () => Reflect.getPrototypeOf(tui),
    },
  ) as unknown as InternalTui;
}

describe("stable TUI proxy compatibility", () => {
  it("does not recurse when patched renderer methods are called", () => {
    const terminal = new ProxyTerminal();
    const tui = new ProxyTui(terminal);
    const tuiReference = createTuiReference(tui);
    const compositor = new TerminalSplitCompositor({
      tui: tuiReference,
      terminal,
      mouseScroll: false,
      renderCluster: () => ({ lines: [], cursor: null }),
    });

    try {
      compositor.install();
      tuiReference.doRender?.();
    } finally {
      compositor.dispose();
    }

    assert.strictEqual(tui.doRenderCalls, 1);
    assert.strictEqual(tui.renderCalls, 1);
  });
});

describe("ANSI escape sequence helpers", () => {
  describe("beginSynchronizedOutput", () => {
    it("returns the DEC private mode 2026h sequence", () => {
      assert.strictEqual(beginSynchronizedOutput(), "\x1b[?2026h");
    });
  });

  describe("endSynchronizedOutput", () => {
    it("returns the DEC private mode 2026l sequence", () => {
      assert.strictEqual(endSynchronizedOutput(), "\x1b[?2026l");
    });
  });

  describe("setScrollRegion", () => {
    it("emits the correct CSI sequence", () => {
      assert.strictEqual(setScrollRegion(1, 24), "\x1b[1;24r");
    });

    it("works with arbitrary boundaries", () => {
      assert.strictEqual(setScrollRegion(5, 10), "\x1b[5;10r");
    });
  });

  describe("resetScrollRegion", () => {
    it("returns the full-reset sequence", () => {
      assert.strictEqual(resetScrollRegion(), "\x1b[r");
    });
  });

  describe("moveCursor", () => {
    it("emits the CUP (cursor position) sequence", () => {
      assert.strictEqual(moveCursor(1, 1), "\x1b[1;1H");
    });

    it("uses 1-based coordinates", () => {
      assert.strictEqual(moveCursor(10, 40), "\x1b[10;40H");
    });
  });

  describe("emergencyTerminalModeReset", () => {
    it("contains the synchronized output bracket", () => {
      const result = emergencyTerminalModeReset();
      assert.ok(
        result.startsWith("\x1b[?2026h"),
        "should start with sync begin",
      );
      assert.ok(result.endsWith("\x1b[?2026l"), "should end with sync end");
    });

    it("contains scroll region reset", () => {
      assert.ok(emergencyTerminalModeReset().includes("\x1b[r"));
    });

    it("contains mouse reporting disable", () => {
      assert.ok(emergencyTerminalModeReset().includes("\x1b[?1006l"));
      assert.ok(emergencyTerminalModeReset().includes("\x1b[?1002l"));
    });

    it("contains alternate screen exit", () => {
      assert.ok(emergencyTerminalModeReset().includes("\x1b[?1049l"));
    });

    it("contains extended keyboard mode reset", () => {
      assert.ok(emergencyTerminalModeReset().includes("\x1b[<999u"));
    });
  });
});

describe("buildFixedClusterPaint", () => {
  function makeCluster(
    lines: string[],
    cursor?: { row: number; col: number },
  ): FixedEditorClusterRender {
    return { lines, cursor: cursor ?? null };
  }

  it("returns empty string for empty cluster", () => {
    const result = buildFixedClusterPaint(makeCluster([]), 24, 80, false);
    assert.strictEqual(result, "");
  });

  it("contains scroll region reset", () => {
    const result = buildFixedClusterPaint(
      makeCluster(["hello"]),
      24,
      80,
      false,
    );
    assert.ok(result.includes("\x1b[r"), "should reset scroll region");
  });

  it("contains cursor positioning sequences", () => {
    const result = buildFixedClusterPaint(
      makeCluster(["hello"]),
      24,
      80,
      false,
    );
    // Should position cursor at the start row
    assert.ok(result.includes("\x1b["), "should contain ANSI positioning");
  });

  it("positions content near the bottom of the terminal", () => {
    const cluster = makeCluster(["line1", "line2"]);
    const result = buildFixedClusterPaint(cluster, 24, 80, false);
    // 2 cluster lines, startRow = 24 - 2 + 1 = 23
    assert.ok(result.includes("\x1b[23;"), "should position at row 23");
  });

  it("shows cursor when requested and cluster has a cursor position", () => {
    const cluster = makeCluster(["hello"], { row: 0, col: 3 });
    const result = buildFixedClusterPaint(cluster, 24, 80, true);
    assert.ok(result.includes("\x1b[?25h"), "should show cursor");
  });

  it("hides cursor when showHardwareCursor is false", () => {
    const cluster = makeCluster(["hello"], { row: 0, col: 3 });
    const result = buildFixedClusterPaint(cluster, 24, 80, false);
    assert.ok(result.includes("\x1b[?25l"), "should hide cursor");
  });

  it("hides cursor when cluster has no cursor position", () => {
    const cluster = makeCluster(["hello"]);
    const result = buildFixedClusterPaint(cluster, 24, 80, true);
    assert.ok(
      result.includes("\x1b[?25l"),
      "should hide cursor when none provided",
    );
  });

  it("clears each line before writing content", () => {
    const cluster = makeCluster(["content"]);
    const result = buildFixedClusterPaint(cluster, 24, 80, false);
    assert.ok(result.includes("\x1b[2K"), "should clear each line");
  });

  it("single line cluster starts on the last row", () => {
    const cluster = makeCluster(["bottom"]);
    const result = buildFixedClusterPaint(cluster, 10, 80, false);
    // startRow = 10 - 1 + 1 = 10
    assert.ok(result.includes("\x1b[10;1H"));
  });

  it("positions hardware cursor at the correct row/col", () => {
    const cluster = makeCluster(["abc"], { row: 0, col: 1 });
    const result = buildFixedClusterPaint(cluster, 24, 80, true);
    // startRow = 24 - 1 + 1 = 24, cursor row is startRow + 0 = 24, col + 1 = 2
    assert.ok(
      result.includes("\x1b[24;2H"),
      "should position cursor at [24,2]",
    );
  });
});
