import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { openModelPicker } from "./src/ui.ts";

initTheme("dark");

interface StubComponent {
  render(width: number): string[];
  handleInput(data: string): void;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const models = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `model-${String(index).padStart(2, "0")}`,
    name: `Model ${index}`,
    provider: index % 2 === 0 ? "alpha" : "beta",
    api: "openai-completions" as const,
  }));

/**
 * Wire a picker invocation to a fake TUI. Returns the rendered component plus
 * the value the picker resolves with once the user confirms or cancels.
 */
function openPicker(modelCount: number) {
  const selection: { value: unknown } = { value: "unset" };
  let component: StubComponent | undefined;

  const ctx = {
    modelRegistry: { getAvailable: () => models(modelCount) },
    ui: {
      notify: () => undefined,
      custom: (factory: (...args: unknown[]) => unknown) => {
        component = factory(
          { requestRender: () => undefined },
          theme,
          undefined,
          (value: unknown) => {
            selection.value = value;
          },
        ) as StubComponent;
        return new Promise(() => undefined);
      },
    },
  } as unknown as ExtensionCommandContext;

  void openModelPicker(ctx, {
    provider: "alpha",
    model: "model-00",
    reasoning: "off",
  });

  assert.ok(component, "picker component was not created");
  return { component, selection };
}

test("long model lists stay bounded and scroll with the selection", () => {
  const { component } = openPicker(60);
  const initial = component.render(120);
  const initialLines = initial.length;

  // The generic ctx.ui.select renders one row per option and overflows the
  // terminal; this picker must cap the visible window instead.
  assert.ok(
    initialLines < 30,
    `expected a bounded picker, rendered ${initialLines} lines`,
  );
  assert.ok(initial.some((line) => line.includes("(1/60)")));

  for (let index = 0; index < 30; index++) component.handleInput("\u001b[B");
  const scrolled = component.render(120);

  assert.equal(scrolled.length, initialLines);
  assert.ok(scrolled.some((line) => line.includes("(31/60)")));
  const selectedRow = scrolled.findIndex((line) => line.includes("→ "));
  assert.ok(selectedRow >= 0, "selected row is not on screen");
  assert.ok(selectedRow < scrolled.length - 1);
});

test("typing filters the list and enter selects the highlighted model", () => {
  const { component, selection } = openPicker(60);

  for (const character of "beta/model-59") component.handleInput(character);
  component.handleInput("\r");

  assert.equal((selection.value as { id?: string })?.id, "model-59");
});

test("escape cancels the picker", () => {
  const { component, selection } = openPicker(60);

  component.handleInput("\u001b");

  assert.equal(selection.value, undefined);
});
