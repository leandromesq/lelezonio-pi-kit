/**
 * Behavioral tests for renderFixedEditorCluster — the fixed-editor layout engine.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderFixedEditorCluster,
  CURSOR_MARKER,
  type FixedEditorClusterInput,
} from "./src/fixed-editor/cluster.ts";

describe("renderFixedEditorCluster", () => {
  it("returns empty lines and null cursor for empty input", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 24,
      editorLines: [],
    };
    const result = renderFixedEditorCluster(input);
    assert.deepStrictEqual(result.lines, []);
    assert.strictEqual(result.cursor, null);
  });

  it("renders editor lines within the available rows", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 5, // 4 usable rows (terminalRows - 1)
      editorLines: ["line1", "line2"],
    };
    const result = renderFixedEditorCluster(input);
    assert.ok(result.lines.length <= 4, "should not exceed usable rows");
    assert.ok(result.lines.includes("line1"), "should include editor lines");
    assert.ok(result.lines.includes("line2"), "should include editor lines");
  });

  it("clamps editor lines to maxRows", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 4, // 3 usable rows
      editorLines: ["a", "b", "c", "d", "e", "f"],
    };
    const result = renderFixedEditorCluster(input);
    assert.ok(result.lines.length <= 3, "should not exceed maxRows");
  });

  it("distributes status, top, secondary, transcript, and lastPrompt lines", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 10, // 9 usable rows
      editorLines: ["editor1"],
      statusLines: ["[STATUS]"],
      topLines: ["top1", "top2"],
      secondaryLines: ["secondary1"],
      transcriptLines: ["transcript1"],
      lastPromptLines: ["prompt1"],
    };
    const result = renderFixedEditorCluster(input);
    // status should be at top
    assert.ok(result.lines.some((l) => l.includes("[STATUS]")));
    // editor should be present
    assert.ok(result.lines.some((l) => l.includes("editor1")));
    // the layout should include some auxiliary lines
    assert.ok(result.lines.length > 1);
  });

  it("extracts cursor position from CURSOR_MARKER", () => {
    const markerLine = `before${CURSOR_MARKER}after`;
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 5,
      editorLines: ["line1", markerLine, "line3"],
    };
    const result = renderFixedEditorCluster(input);
    assert.notStrictEqual(result.cursor, null);
    assert.ok(result.cursor!.row >= 0);
    assert.strictEqual(result.cursor!.col, "before".length);
    // The cursor marker should be stripped from the output
    const hasMarker = result.lines.some((l) => l.includes(CURSOR_MARKER));
    assert.strictEqual(hasMarker, false, "cursor marker should be stripped");
  });

  it("returns null cursor when no marker is present", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 5,
      editorLines: ["no", "marker", "here"],
    };
    const result = renderFixedEditorCluster(input);
    assert.strictEqual(result.cursor, null);
  });

  it("handles minimum dimensions gracefully", () => {
    const input: FixedEditorClusterInput = {
      width: 1,
      terminalRows: 2, // 1 usable row
      editorLines: ["x"],
    };
    const result = renderFixedEditorCluster(input);
    assert.ok(result.lines.length <= 1);
  });

  it("handles width of 0 gracefully", () => {
    const input: FixedEditorClusterInput = {
      width: 0,
      terminalRows: 24,
      editorLines: ["test"],
    };
    const result = renderFixedEditorCluster(input);
    // width clamped to 1
    assert.ok(Array.isArray(result.lines));
  });

  it("preserves editor content ordering", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 10,
      editorLines: ["first", "second", "third"],
    };
    const result = renderFixedEditorCluster(input);
    const editorContent = result.lines.filter(
      (l) => l === "first" || l === "second" || l === "third",
    );
    assert.strictEqual(editorContent.length, 3);
    assert.strictEqual(editorContent[0], "first");
    assert.strictEqual(editorContent[1], "second");
    assert.strictEqual(editorContent[2], "third");
  });

  it("prioritizes editor lines over auxiliary content when space is tight", () => {
    const input: FixedEditorClusterInput = {
      width: 80,
      terminalRows: 4, // 3 usable rows
      editorLines: ["e1", "e2", "e3"],
      statusLines: ["status"],
      topLines: ["top"],
    };
    const result = renderFixedEditorCluster(input);
    // All 3 editor lines should be present (they fill maxRows)
    const editorCount = result.lines.filter(
      (l) => l === "e1" || l === "e2" || l === "e3",
    ).length;
    assert.strictEqual(editorCount, 3, "all editor lines should be present");
  });
});
