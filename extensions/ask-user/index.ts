/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";
import { pageQuestionScroll, renderAskUserLayout } from "./src/layout.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const HERDR_BLOCKED_EVENT = "herdr:blocked";

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

type SelectionResult = {
  answer: string;
  wasCustom: boolean;
  index?: number;
} | null;

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (
        text: string,
        answer: string | null = null,
        wasCustom = false,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((o) => o.label),
          answer,
          wasCustom,
          cancelled: answer === null,
        } satisfies AskUserDetails,
      });

      if (
        params.options.length < MIN_OPTIONS ||
        params.options.length > MAX_OPTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const allOptions: DisplayOption[] = [
        ...params.options,
        { label: "Write my own answer…", isOther: true },
      ];

      const showQuestion = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>(
          (tui, theme, _kb, done) => {
            let optionIndex = 0;
            let editMode = false;
            let detailsExpanded = false;
            let questionScroll = 0;
            let questionLineCount = 1;
            let questionVisibleLines = 1;
            let cachedLines: string[] | undefined;

            let settled = false;

            function finish(result: SelectionResult) {
              if (settled) return;
              settled = true;
              uiSignal.removeEventListener("abort", cancel);
              done(result);
            }

            function cancel() {
              finish(null);
            }

            uiSignal.addEventListener("abort", cancel, { once: true });
            if (uiSignal.aborted) queueMicrotask(cancel);

            const editorTheme: EditorTheme = {
              borderColor: (s) => theme.fg("accent", s),
              selectList: {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => theme.fg("accent", t),
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t),
              },
            };
            const editor = new Editor(tui, editorTheme);

            editor.onSubmit = (value) => {
              const trimmed = value.trim();
              if (trimmed) {
                finish({ answer: trimmed, wasCustom: true });
              } else {
                editMode = false;
                editor.setText("");
                refresh();
              }
            };

            function refresh() {
              cachedLines = undefined;
              tui.requestRender();
            }

            function selectOption(index: number) {
              const selected = allOptions[index];
              if (selected.isOther) {
                optionIndex = index;
                editMode = true;
                detailsExpanded = false;
                refresh();
              } else {
                finish({
                  answer: selected.label,
                  wasCustom: false,
                  index: index + 1,
                });
              }
            }

            function handleInput(data: string) {
              if (editMode) {
                if (matchesKey(data, Key.escape)) {
                  editMode = false;
                  editor.setText("");
                  refresh();
                  return;
                }
                editor.handleInput(data);
                refresh();
                return;
              }

              if (matchesKey(data, Key.up)) {
                optionIndex =
                  (optionIndex - 1 + allOptions.length) % allOptions.length;
                refresh();
                return;
              }
              if (matchesKey(data, Key.down)) {
                optionIndex = (optionIndex + 1) % allOptions.length;
                detailsExpanded = false;
                refresh();
                return;
              }

              if (
                matchesKey(data, Key.pageUp) ||
                matchesKey(data, Key.ctrl("u"))
              ) {
                questionScroll = pageQuestionScroll(
                  questionScroll,
                  -1,
                  questionLineCount,
                  questionVisibleLines,
                );
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.pageDown) ||
                matchesKey(data, Key.ctrl("d"))
              ) {
                questionScroll = pageQuestionScroll(
                  questionScroll,
                  1,
                  questionLineCount,
                  questionVisibleLines,
                );
                refresh();
                return;
              }
              if (matchesKey(data, Key.home)) {
                questionScroll = 0;
                refresh();
                return;
              }
              if (matchesKey(data, Key.end)) {
                questionScroll = Math.max(
                  0,
                  questionLineCount - Math.max(1, questionVisibleLines),
                );
                refresh();
                return;
              }

              if (
                matchesKey(data, Key.tab) &&
                allOptions[optionIndex]?.description
              ) {
                detailsExpanded = !detailsExpanded;
                refresh();
                return;
              }

              // Number keys jump straight to an option
              if (
                data.length === 1 &&
                data >= "1" &&
                data <= String(allOptions.length)
              ) {
                selectOption(Number(data) - 1);
                return;
              }

              if (matchesKey(data, Key.enter)) {
                selectOption(optionIndex);
                return;
              }

              if (matchesKey(data, Key.escape)) {
                finish(null);
              }
            }

            function render(width: number): string[] {
              if (cachedLines) return cachedLines;

              const rendered = renderAskUserLayout(
                {
                  width,
                  terminalRows: tui.terminal.rows,
                  question: params.question,
                  options: allOptions,
                  optionIndex,
                  questionScroll,
                  detailsExpanded,
                  editMode,
                  editorLines: editMode
                    ? editor.render(Math.max(1, width - 2))
                    : undefined,
                },
                {
                  accent: (text) => theme.fg("accent", text),
                  bold: (text) => theme.bold(text),
                  border: (text) => theme.fg("accent", text),
                  dim: (text) => theme.fg("dim", text),
                  muted: (text) => theme.fg("muted", text),
                  text: (text) => theme.fg("text", text),
                },
              );
              questionScroll = rendered.questionScroll;
              questionLineCount = rendered.questionLineCount;
              questionVisibleLines = rendered.questionVisibleLines;
              cachedLines = rendered.lines;
              return rendered.lines;
            }

            return {
              render,
              invalidate: () => {
                cachedLines = undefined;
              },
              handleInput,
              dispose: () => {
                uiSignal.removeEventListener("abort", cancel);
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              margin: 1,
              width: "95%",
              maxHeight: "90%",
            },
          },
        );

      pi.events.emit(HERDR_BLOCKED_EVENT, {
        active: true,
        label: `Ask user: ${params.question}`,
      });
      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise(showQuestion),
        signal ? { signal } : undefined,
      ).finally(() => {
        pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
      });

      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }));
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const result = uiExit.value;

      if (!result) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }

      if (result.wasCustom) {
        return reply(
          buildAskUserResultMessage({
            kind: "custom",
            answer: result.answer,
          }),
          result.answer,
          true,
        );
      }

      return reply(
        buildAskUserResultMessage({
          kind: "selected",
          answer: result.answer,
          index: result.index,
        }),
        result.answer,
      );
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        typeof args.question === "string" ? args.question : "",
      );
      const opts = Array.isArray(args.options)
        ? (args.options as DisplayOption[])
        : [];
      if (opts.length > 0) {
        const numbered = opts.map((o, i) => `${i + 1}. ${o.label}`);
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }

      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", display),
        0,
        0,
      );
    },
  });
}
