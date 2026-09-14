import {
  DynamicBorder,
  getMarkdownTheme,
  getSelectListTheme,
  ThinkingSelectorComponent,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  Box,
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Markdown,
  SelectList,
  Spacer,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { ReasoningLevel, SummaryConfig } from "./config.ts";
import type { RunRecap } from "./summarizer.ts";

export interface RecapEntryData extends RunRecap {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly fallback?: boolean;
}

class RecapCard {
  private readonly data: RecapEntryData;
  private readonly theme: Theme;
  private readonly expanded: boolean;

  constructor(data: RecapEntryData, theme: Theme, expanded: boolean) {
    this.data = data;
    this.theme = theme;
    this.expanded = expanded;
  }

  render(width: number) {
    const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
    const title =
      this.theme.fg("accent", "✦ ") +
      this.theme.fg("customMessageLabel", this.theme.bold("Run recap"));
    box.addChild(new Text(title, 0, 0));
    box.addChild(
      new Markdown(this.data.recap, 0, 1, getMarkdownTheme(), {
        color: (text) => this.theme.fg("customMessageText", text),
      }),
    );
    box.addChild(
      new Text(
        `${this.theme.fg("accent", this.theme.bold("Next:"))} ${this.theme.fg("customMessageText", this.data.next)}`,
        0,
        0,
      ),
    );
    if (this.expanded) {
      const source = `${this.data.provider}/${this.data.model} · ${this.data.reasoning}${this.data.fallback ? " · local fallback" : ""}`;
      box.addChild(new Text(this.theme.fg("dim", source), 0, 1));
    }
    return box.render(width);
  }

  invalidate() {}
}

export function renderRecap(
  data: RecapEntryData | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!data)
    return new Text(theme.fg("warning", "Run recap unavailable"), 0, 0);
  return new RecapCard(data, theme, expanded);
}

const MODEL_KEY_SEPARATOR = "\u0000";
const MODEL_LIST_LAYOUT = {
  minPrimaryColumnWidth: 34,
  maxPrimaryColumnWidth: 56,
};

/**
 * The generic `ctx.ui.select` selector renders every option as a plain text
 * line, so a long model list overflows the terminal and the entries past the
 * last visible row cannot be read even though the cursor keeps moving. The
 * bounded `SelectList` below scrolls with the selection and reports the
 * position in the full list. The search field keeps a provider/model reachable
 * without scrolling through the whole catalog.
 */
const MAX_VISIBLE_MODELS = 12;

const modelKey = (provider: string, id: string) =>
  `${provider}${MODEL_KEY_SEPARATOR}${id}`;

class ModelPickerComponent extends Container {
  private readonly theme: Theme;
  private readonly allItems: readonly SelectItem[];
  private readonly modelsByKey: ReadonlyMap<string, Model<Api>>;
  private readonly onSelect: (model: Model<Api>) => void;
  private readonly onCancel: () => void;
  private readonly searchInput = new Input();
  private readonly currentValue: string;
  private readonly listContainer = new Container();
  private selectList: SelectList;
  private focusedValue = false;

  constructor(options: {
    theme: Theme;
    items: readonly SelectItem[];
    modelsByKey: ReadonlyMap<string, Model<Api>>;
    currentValue: string;
    onSelect: (model: Model<Api>) => void;
    onCancel: () => void;
  }) {
    super();
    this.theme = options.theme;
    this.allItems = options.items;
    this.modelsByKey = options.modelsByKey;
    this.currentValue = options.currentValue;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.selectList = this.buildSelectList(this.allItems, this.currentValue);

    this.addChild(new DynamicBorder((text) => this.theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(this.theme.fg("accent", this.theme.bold("Summary model")), 1, 0),
    );
    this.addChild(new Spacer(1));

    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.renderList(this.selectList);
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        this.theme.fg("dim", "  ↑↓ navigate · type to filter · enter select · esc cancel"),
        1,
        0,
      ),
    );
    this.addChild(new DynamicBorder((text) => this.theme.fg("accent", text)));
  }

  get focused() {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.searchInput.focused = value;
  }

  private buildSelectList(items: readonly SelectItem[], preselect: string) {
    // maxVisible caps the rendered rows; SelectList scrolls the window with the
    // selection and prints "(n/total)" when the list does not fit.
    const list = new SelectList(
      [...items],
      Math.min(Math.max(items.length, 1), MAX_VISIBLE_MODELS),
      getSelectListTheme(),
      MODEL_LIST_LAYOUT,
    );
    const index = items.findIndex((item) => item.value === preselect);
    if (index !== -1) list.setSelectedIndex(index);
    list.onSelect = (item) => {
      const model = this.modelsByKey.get(item.value);
      if (model) this.onSelect(model);
    };
    list.onCancel = () => this.onCancel();
    return list;
  }

  private renderList(list: SelectList) {
    this.selectList = list;
    this.listContainer.clear();
    this.listContainer.addChild(list);
  }

  private applyFilter(query: string) {
    const filtered = query
      ? fuzzyFilter(
          [...this.allItems],
          query,
          (item) => `${item.label} ${item.description ?? ""}`,
        )
      : [...this.allItems];
    const selectedValue = this.selectList.getSelectedItem()?.value;
    this.renderList(
      this.buildSelectList(filtered, selectedValue ?? this.currentValue),
    );
  }

  handleInput(keyData: string) {
    const keybindings = getKeybindings();
    const isNavigation =
      keybindings.matches(keyData, "tui.select.up") ||
      keybindings.matches(keyData, "tui.select.down") ||
      keybindings.matches(keyData, "tui.select.confirm") ||
      keybindings.matches(keyData, "tui.select.cancel");
    if (isNavigation) {
      this.selectList.handleInput(keyData);
      return;
    }
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }
}

export async function openModelPicker(
  ctx: ExtensionCommandContext,
  config: SummaryConfig,
) {
  const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
  if (models.length === 0) {
    ctx.ui.notify(
      "No configured models are available for run recaps.",
      "warning",
    );
    return undefined;
  }

  const modelsByKey = new Map(
    models.map((model) => [modelKey(model.provider, model.id), model]),
  );
  const items: SelectItem[] = models.map((model) => ({
    value: modelKey(model.provider, model.id),
    label: `${model.provider}/${model.id}`,
    description: model.name && model.name !== model.id ? model.name : undefined,
  }));

  return ctx.ui.custom<Model<Api> | undefined>((tui, theme, _keybindings, done) => {
    const picker = new ModelPickerComponent({
      theme,
      items,
      modelsByKey,
      currentValue: modelKey(config.provider, config.model),
      onSelect: (model) => done(model),
      onCancel: () => done(undefined),
    });
    return {
      render: (width) => picker.render(width),
      invalidate: () => picker.invalidate(),
      handleInput: (data) => {
        picker.handleInput(data);
        tui.requestRender();
      },
      get focused() {
        return picker.focused;
      },
      set focused(value: boolean) {
        picker.focused = value;
      },
    };
  });
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
