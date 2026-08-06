import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  ThinkingSelectorComponent,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ReasoningLevel } from "./config.ts";

export async function openModelPicker(ctx: ExtensionCommandContext) {
  const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
  if (models.length === 0) {
    ctx.ui.notify(
      "No configured models are available for auto-naming.",
      "warning",
    );
    return undefined;
  }

  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const selected = await ctx.ui.select("Title model", labels);
  return selected === undefined ? undefined : models[labels.indexOf(selected)];
}

export function openReasoningPicker(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current: ReasoningLevel,
) {
  const supported = getSupportedThinkingLevels(model);
  const selectedCurrent = supported.includes(current)
    ? current
    : (supported[0] ?? "off");

  return ctx.ui.custom<ModelThinkingLevel | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ThinkingSelectorComponent(
        selectedCurrent,
        supported,
        (level) => done(level),
        () => done(undefined),
      );
      const list = selector.getSelectList();
      return {
        render: (width) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
}
