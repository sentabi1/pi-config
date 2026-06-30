import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface QuestionDef {
	question: string;
	details?: string;
	mode: AskUserQuestionMode;
	options: AskOption[];
}

interface TabAnswer {
	questionIndex: number;
	answer: AskAnswer | AskAnswer[] | string | null;
	note?: string;
}

interface BatchQuestionResultDetails {
	status: AskUserQuestionStatus;
	questions: QuestionDef[];
	answers: TabAnswer[];
	message?: string;
}

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
}

interface TabState {
	questionIndex: number;
	mode: AskUserQuestionMode;
	answer: AskAnswer | AskAnswer[] | string | null;
	textBuffer: string;
	selected: Map<string, AskAnswer>;
	note: string;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

const AskQuestionsParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({
				description: "The question text to display.",
			}),
			details: Type.Optional(
				Type.String({
					description: "Optional extra context or instructions shown under the question.",
				}),
			),
			options: Type.Optional(
				Type.Array(OptionSchema, {
					description:
						"Optional multiple-choice options. Omit or pass an empty array for free-form text input.",
				}),
			),
			multiSelect: Type.Optional(
				Type.Boolean({
					description: "Set to true to allow multiple answers to be selected for this question.",
				}),
			),
		}),
		{
			description: "Array of questions to display in tabbed interface. At least one question is required.",
			minItems: 1,
		},
	),
});

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
) {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
	} as AskUserQuestionResultDetails;
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function batchCancelledResult(questions: QuestionDef[]) {
	const message = "User cancelled the batch questions";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "cancelled" as const, questions, answers: [] } as BatchQuestionResultDetails,
	};
}

function batchUnavailableResult(questions: QuestionDef[]) {
	const message = "ask_questions requires interactive TUI mode";
	return {
		content: [{ type: "text" as const, text: message }],
		details: { status: "unavailable" as const, questions, answers: [] } as BatchQuestionResultDetails,
	};
}

function buildBatchResult(questions: QuestionDef[], answers: TabAnswer[]) {
	const text = `User answered all ${questions.length} questions.`;
	return {
		content: [{ type: "text" as const, text }],
		details: { status: "answered" as const, questions, answers } as BatchQuestionResultDetails,
	};
}

function loadSelectedFromPrefill(prefill: TabAnswer): Map<string, AskAnswer> {
	const map = new Map<string, AskAnswer>();
	if (Array.isArray(prefill.answer)) {
		for (const ans of prefill.answer as AskAnswer[]) {
			if (ans.type === "option") map.set(ans.value, ans);
			else if (ans.type === "other") map.set("other", ans);
		}
	} else if (prefill.answer && typeof prefill.answer === "object" && "type" in (prefill.answer as any)) {
		const ans = prefill.answer as AskAnswer;
		if (ans.type === "option") map.set(ans.value, ans);
		else if (ans.type === "other") map.set("other", ans);
	}
	return map;
}

function buildResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[]) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

/**
 * Single-choice question component with SelectList, number shortcuts, and Other inline editor.
 */
function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	const otherLabel = getOtherLabel(options);
	const allOptions: AskOption[] = [...options];

	return ctx.ui.custom<AskAnswer | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer | null) => void) => {
		let editMode = false;
		let cachedLines: string[] | undefined;
		let otherEditorValue = "";
		let _focused = false;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
		};
		const editor = new Editor(tui, editorTheme);

		// Build SelectList items: options + "Other"
		const selectItems: SelectItem[] = allOptions.map((opt, i) => ({
			value: opt.value,
			label: `${i + 1}. ${opt.label}`,
			description: opt.description,
		}));
		selectItems.push({ value: "__other__", label: `${allOptions.length + 1}. ${otherLabel}`, description: "Type a custom answer" });

		const maxVisible = Math.min(selectItems.length, 10);
		const listTheme: SelectListTheme = {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		};
		const selectList = new SelectList(selectItems, maxVisible, listTheme);

		selectList.onSelect = (item) => {
			if (item.value === "__other__") {
				editMode = true;
				editor.setText(otherEditorValue);
				_focused = true;
				editor.focused = true;
				invalidate();
				tui.requestRender();
				return;
			}
			const idx = allOptions.findIndex((o) => o.value === item.value);
			if (idx >= 0) {
				done({
					type: "option",
					label: allOptions[idx].label,
					value: allOptions[idx].value,
					index: idx + 1,
				});
			}
		};
		selectList.onCancel = () => done(null);

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			otherEditorValue = trimmed;
			done({ type: "other", label: trimmed, value: trimmed });
		};

		function invalidate() {
			cachedLines = undefined;
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					otherEditorValue = editor.getText() || "";
					editor.setText("");
					editor.focused = false;
					invalidate();
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				invalidate();
				tui.requestRender();
				return;
			}

			// Number shortcuts (1-9) for direct option selection
			if (/^[1-9]$/.test(data)) {
				const num = parseInt(data, 10);
				const idx = num - 1;
				if (idx < allOptions.length) {
					done({
						type: "option",
						label: allOptions[idx].label,
						value: allOptions[idx].value,
						index: num,
					});
					return;
				}
				if (idx === allOptions.length) {
					// Number for "Other"
					editMode = true;
					editor.setText(otherEditorValue);
					editor.focused = true;
					invalidate();
					tui.requestRender();
					return;
				}
			}

			selectList.handleInput(data);
			invalidate();
			tui.requestRender();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			// Top border
			add(theme.fg("accent", "─".repeat(width)));

			// Question
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}

			lines.push("");

			if (editMode) {
				// Show options for reference but dimmed
				for (let i = 0; i < selectItems.length; i++) {
					const item = selectItems[i];
					const prefix = "  ";
					const styled = theme.fg("dim", `${prefix}${item.label}`);
					add(styled);
					if (item.description) {
						addWrapped(lines, theme.fg("dim", item.description), width, "     ");
					}
				}
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				add(theme.fg("accent", "─".repeat(width)));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to go back"));
			} else {
				// Render SelectList items manually (we use SelectList for logic, custom render for layout)
				const rendered = selectList.render(width);
				for (const line of rendered) {
					add(line);
				}
				lines.push("");
				add(theme.fg("dim", " ↑↓/jk navigate • 1-9 select • Other: Enter • Esc cancel"));
			}

			// Bottom border
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate,
			handleInput,
			get focused(): boolean {
				return _focused;
			},
			set focused(val: boolean) {
				_focused = val;
				editor.focused = val && editMode;
			},
		};
	});
}

/**
 * Multi-choice question component with SelectList-based checkbox list, Submit, and Other inline editor.
 */
function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	const otherLabel = getOtherLabel(options);

	return ctx.ui.custom<AskAnswer[] | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer[] | null) => void) => {
		let editMode = false;
		let cachedLines: string[] | undefined;
		let _focused = false;
		const selected = new Map<string, AskAnswer>();
		const otherEditor = new Editor(tui, { borderColor: (s: string) => theme.fg("accent", s) });
		let otherText = "";

		otherEditor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			otherText = trimmed;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			otherEditor.focused = false;
			invalidate();
			tui.requestRender();
		};

		// Build items: checkable options + Other (Submit is rendered separately)
		const selectItems: SelectItem[] = [
			...options.map((opt, i) => ({
				value: opt.value,
				label: `${i + 1}. ${opt.label}`,
				description: opt.description,
			})),
			{ value: "__other__", label: `${options.length + 1}. ${otherLabel}`, description: "Type a custom answer" },
		];

		const maxVisible = Math.min(selectItems.length + 1, 12);
		const listTheme: SelectListTheme = {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		};
		const selectList = new SelectList(selectItems, maxVisible, listTheme);
		selectList.onCancel = () => done(null);

		function invalidate() {
			cachedLines = undefined;
		}

		function toggleOption(value: string) {
			if (selected.has(value)) {
				selected.delete(value);
			} else {
				const idx = options.findIndex((o) => o.value === value);
				if (idx >= 0) {
					selected.set(value, {
						type: "option",
						label: options[idx].label,
						value: options[idx].value,
						index: idx + 1,
					});
				}
			}
			invalidate();
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					otherText = otherEditor.getText() || otherText;
					otherEditor.setText("");
					otherEditor.focused = false;
					invalidate();
					tui.requestRender();
					return;
				}
				otherEditor.handleInput(data);
				invalidate();
				tui.requestRender();
				return;
			}

			// Number shortcuts (1-9) to toggle
			if (/^[1-9]$/.test(data)) {
				const num = parseInt(data, 10);
				const idx = num - 1;
				if (idx < options.length) {
					toggleOption(options[idx].value);
					return;
				}
				if (idx === options.length) {
					// Toggle Other
					if (selected.has("other")) {
						selected.delete("other");
					} else {
						editMode = true;
						_focused = true;
						otherEditor.setText(otherText);
						otherEditor.focused = true;
					}
					invalidate();
					tui.requestRender();
					return;
				}
			}

			// Enter: if any selections, submit; otherwise toggle current
			if (matchesKey(data, Key.enter)) {
				if (selected.size > 0) {
					done(sortAnswers(Array.from(selected.values())));
					return;
				}
				const selectedItem = selectList.getSelectedItem();
				if (selectedItem && selectedItem.value !== "__other__") {
					toggleOption(selectedItem.value);
				}
				return;
			}

			// Space: toggle current item
			if (matchesKey(data, Key.space) || matchesKey(data, " ")) {
				const selectedItem = selectList.getSelectedItem();
				if (selectedItem) {
					if (selectedItem.value === "__other__") {
						if (selected.has("other")) {
							selected.delete("other");
						} else {
							editMode = true;
							_focused = true;
							otherEditor.setText(otherText);
							otherEditor.focused = true;
						}
						invalidate();
						tui.requestRender();
						return;
					}
					toggleOption(selectedItem.value);
				}
				return;
			}

			// Ctrl+Enter: force submit regardless of selection
			if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) {
				if (selected.size > 0) {
					done(sortAnswers(Array.from(selected.values())));
				}
				return;
			}

			selectList.handleInput(data);
			invalidate();
			tui.requestRender();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			// Top border
			add(theme.fg("accent", "─".repeat(width)));

			// Question
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			// Selection count badge
			if (!editMode) {
				if (selected.size > 0) {
					add(theme.fg("success", ` ✓ ${selected.size} selected`));
				} else {
					add(theme.fg("dim", " ○ Select options below"));
				}
				lines.push("");
			}

			if (editMode) {
				// Show items dimmed for reference
				for (let i = 0; i < options.length; i++) {
					const opt = options[i];
					const checked = selected.has(opt.value);
					const marker = checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
					add(`  ${marker} ${theme.fg("dim", `${i + 1}. ${opt.label}`)}`);
				}
				const otherChecked = selected.has("other");
				const otherMarker = otherChecked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				add(`  ${otherMarker} ${theme.fg("dim", `${options.length + 1}. ${otherLabel}`)}`);

				lines.push("");
				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of otherEditor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to save • Esc to go back"));
			} else {
				// Render each option as a checkable item
				for (let i = 0; i < options.length; i++) {
					const opt = options[i];
					const isSelected = selectList.getSelectedItem()?.value === opt.value;
					const checked = selected.has(opt.value);
					const marker = checked ? "[x]" : "[ ]";
					const prefix = isSelected ? theme.fg("accent", ">") : " ";
					const label = `${marker} ${i + 1}. ${opt.label}`;
					const styled = isSelected
						? theme.fg("accent", label)
						: theme.fg(checked ? "success" : "text", label);
					add(`${prefix} ${styled}`);
					if (opt.description) {
						addWrapped(lines, theme.fg("muted", opt.description), width, "      ");
					}
				}

				// Other item
				const otherIdx = options.length + 1;
				const isOtherSelected = selectList.getSelectedItem()?.value === "__other__" || false;
				const otherChecked = selected.has("other");
				const otherMarker = otherChecked ? "[x]" : "[ ]";
				const otherSuffix = otherChecked ? theme.fg("muted", ` — ${selected.get("other")!.label}`) : "";
				const otherPrefix = isOtherSelected ? theme.fg("accent", ">") : " ";
				const otherStyled = isOtherSelected
					? theme.fg("accent", `${otherMarker} ${otherIdx}. ${otherLabel}`)
					: theme.fg(otherChecked ? "success" : "text", `${otherMarker} ${otherIdx}. ${otherLabel}`);
				add(`${otherPrefix} ${otherStyled}${otherSuffix}`);

				// Submit line
				const submitLabel = selected.size > 0
					? `✓ Submit (${selected.size} selected)`
					: "○ Submit";
				const submitStyled = selected.size > 0
					? theme.fg("success", submitLabel)
					: theme.fg("dim", submitLabel);
				add(`   ${submitStyled}`);

				lines.push("");
				if (selected.size === 0) {
					add(theme.fg("dim", " Space to toggle • Enter to submit (with selections) • Ctrl+Enter to force submit"));
				} else {
					add(theme.fg("dim", " Space toggle • Enter submit • 1-9 toggle • Ctrl+Enter submit • Esc cancel"));
				}
			}

			// Bottom border
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate,
			handleInput,
			get focused(): boolean {
				return _focused;
			},
			set focused(val: boolean) {
				_focused = val;
				otherEditor.focused = val && editMode;
			},
		};
	});
}

// Mutex to serialize concurrent UI interactions.
// showExtensionCustom/editor can only handle one active call at a time.
let uiLock: Promise<void> = Promise.resolve();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = uiLock;
	let release: () => void;
	uiLock = new Promise<void>((r) => { release = r; });
	return prev.then(fn).finally(() => release!());
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const context = params.details?.trim() || undefined;
			const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "ask_user_question requires interactive mode UI", context);
			}

			return withUILock(async () => {
				if (mode === "text") {
					const editorTitle = context ? `${params.question}\n\n${context}` : params.question;
					const answer = await ctx.ui.editor(editorTitle);
					if (answer === undefined) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [
						{ type: "text", label: answer.trim(), value: answer.trim() },
					]);
				}

				if (mode === "single-select") {
					const answer = await askSingleChoice(ctx, params.question, context, options);
					if (!answer) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [answer]);
				}

				const answers = await askMultiChoice(ctx, params.question, context, options);
				if (!answers) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, answers);
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			const mode: AskUserQuestionMode = !options?.length ? "text" : args.multiSelect ? "multi-select" : "single-select";

			const modeIcons: Record<AskUserQuestionMode, string> = {
				"text": "📝",
				"single-select": "☝️",
				"multi-select": "☑️",
			};
			const modeLabels: Record<AskUserQuestionMode, string> = {
				"text": "text",
				"single-select": "single",
				"multi-select": "multi",
			};

			let text = `${modeIcons[mode]} `;
			text += theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", args.question);
			text += theme.fg("dim", ` [${modeLabels[mode]}]`);

			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}

			// Build result with question context + answers
			const resultLines: string[] = [];

			// Mode badge
			const modeBadges: Record<AskUserQuestionMode, string> = {
				"text": "📝",
				"single-select": "☝️",
				"multi-select": "☑️",
			};
			resultLines.push(theme.fg("muted", `${modeBadges[details.mode] || ""} ${details.question}`));

			// Answers
			details.answers.forEach((answer) => {
				switch (answer.type) {
					case "text":
						resultLines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`);
						break;
					case "other":
						resultLines.push(`${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`);
						break;
					case "option":
						resultLines.push(`${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`);
						break;
				}
			});

			return new Text(resultLines.join("\n"), 0, 0);
		},
	});

	// ──────────────────────────────────────────────────────────
	// ask_questions — batch tabbed multi-question tool
	// ──────────────────────────────────────────────────────────

	const ASK_QUESTIONS_STATE_TYPE = "ask-questions-state";

	function saveBatchState(state: { questions: QuestionDef[]; answers: TabAnswer[]; completed: boolean }): void {
		pi.appendEntry(ASK_QUESTIONS_STATE_TYPE, state);
	}

	function loadBatchState(
		ctx: any,
	): { questions: QuestionDef[]; answers: TabAnswer[]; completed: boolean } | null {
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === ASK_QUESTIONS_STATE_TYPE) {
				const data = entry.data as any;
				if (data && !data.completed && data.questions?.length > 0) {
					return data;
				}
			}
		}
		return null;
	}

	class TabbedQuestions {
		private questions: QuestionDef[];
		private tabs: TabState[];
		private activeTab: number;
		private pi: ExtensionAPI;
		private done: (result: any) => void;
		private tui: any;
		private theme: any;
		private cachedWidth?: number;
		private cachedLines?: string[];
		private editMode: boolean;
		private editor: any;
		private selectList: any;
		private selected: Map<string, AskAnswer>;
		private otherText: string;
		private otherEditor: any;
		private _focused: boolean;
		private noteEditor: any;
		private noteFocused: boolean;
		private tabSelectLists: Map<number, any>;

		constructor(
			pi: ExtensionAPI,
			questions: QuestionDef[],
			prefillAnswers: TabAnswer[] | null,
			tui: any,
			theme: any,
			_kb: any,
			done: (result: any) => void,
		) {
			this.pi = pi;
			this.questions = questions;
			this.tui = tui;
			this.theme = theme;
			this.done = done;
			this.activeTab = 0;
			this.editMode = false;
			this._focused = false;
			this.selected = new Map();
			this.otherText = "";
			this.selectList = null;
			this.tabSelectLists = new Map();

			this.otherEditor = new Editor(tui, {
				borderColor: (s: string) => theme.fg("accent", s),
			});
			this.otherEditor.onSubmit = (value: string) => {
				const trimmed = value.trim();
				if (!trimmed) return;
				this.otherText = trimmed;
				const tab = this.getActiveTab();
				if (tab && tab.mode === "single-select") {
					const answer: AskAnswer = { type: "other" as const, label: trimmed, value: trimmed };
					tab.answer = answer;
					this.selected = new Map();
					this.selected.set("other", answer);
					this.editMode = false;
					this.otherEditor.focused = false;
					this.invalidate();
					this.persist();
					tui.requestRender();
					return;
				}
				this.selected.set("other", { type: "other" as const, label: trimmed, value: trimmed });
				this.editMode = false;
				this.otherEditor.focused = false;
				this.syncMultiSelectState();
				this.invalidate();
				this.persist();
				tui.requestRender();
			};

			this.editor = new Editor(tui, {
				borderColor: (s: string) => theme.fg("accent", s),
			});

			this.noteEditor = new Editor(tui, {
				borderColor: (s: string) => theme.fg("accent", s),
			});
			this.noteFocused = false;

			// Initialize tabs
			const tabs: TabState[] = [];
			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				const prefill = prefillAnswers
					? prefillAnswers.find((a) => a.questionIndex === i)
					: null;
				tabs.push({
					questionIndex: i,
					mode: q.mode,
					answer: prefill ? prefill.answer : null,
					textBuffer:
						prefill && q.mode === "text" && typeof prefill.answer === "string"
							? (prefill.answer as string)
							: "",
					selected:
						prefill &&
						(q.mode === "single-select" || q.mode === "multi-select")
							? loadSelectedFromPrefill(prefill)
							: new Map(),
					note:
						prefill && prefill.note
							? prefill.note
							: "",
				});
			}
			this.tabs = tabs;

			// Prepare active tab
			this.prepareActiveTab();

			// Restore note for first tab
			if (this.tabs.length > 0) {
				this.noteEditor.setText(this.tabs[0].note || "");
			}
		}

		private persist(): void {
			const answers = this.tabs.map((t, i) => ({
				questionIndex: i,
				answer: t.answer,
				note: t.note,
			}));
			saveBatchState({
				questions: this.questions,
				answers,
				completed: false,
			});
		}

		private getActiveTab(): TabState {
			return this.tabs[this.activeTab];
		}

		private syncAnswerFromTab(): void {
			const tab = this.getActiveTab();
			if (!tab) return;
			if (tab.mode === "text") {
				const val = this.editor?.getText?.() ?? "";
				tab.answer = val;
				tab.textBuffer = val;
			} else if (tab.mode === "multi-select") {
				const vals = Array.from(this.selected.values());
				tab.answer = vals.length > 0 ? vals : null;
			}
			tab.note = this.noteEditor.getText() || "";
		}

		private syncMultiSelectState(): void {
			const tab = this.getActiveTab();
			if (!tab || tab.mode !== "multi-select") return;
			tab.selected = new Map(this.selected);
			const vals = Array.from(this.selected.values());
			tab.answer = vals.length > 0 ? vals : null;
			this.invalidate();
			this.tui.requestRender();
			this.persist();
		}

		private selectTab(index: number): void {
			if (index < 0 || index >= this.tabs.length || index === this.activeTab) return;
			this.syncAnswerFromTab();
			this.activeTab = index;
			this.editMode = false;
			this.noteFocused = false;
			this.otherEditor.focused = false;
			this.editor.focused = false;
			this.noteEditor.focused = false;
			this.prepareActiveTab();
			this.noteEditor.setText(this.tabs[index].note || "");
			this.invalidate();
			this.tui.requestRender();
		}

		private prepareActiveTab(): void {
			const tab = this.getActiveTab();
			if (!tab) return;
			if (tab.mode === "text") {
				this.editor.setText(tab.textBuffer || "");
				this.editor.focused = true;
			} else if (tab.mode === "single-select" || tab.mode === "multi-select") {
				this.selected = new Map(tab.selected || new Map());
			}
			this.noteEditor.setText(tab.note || "");
		}

		private submitAll(): void {
			this.syncAnswerFromTab();
			for (let i = 0; i < this.tabs.length; i++) {
				const tab = this.tabs[i];
				if (tab.mode === "text") continue;
				if (tab.answer === null || (Array.isArray(tab.answer) && tab.answer.length === 0)) {
					this.activeTab = i;
					this.prepareActiveTab();
					this.invalidate();
					this.tui.requestRender();
					return;
				}
			}
			const answers: TabAnswer[] = this.tabs.map((t, i) => ({
				questionIndex: i,
				answer: t.answer,
				note: t.note || "",
			}));
			saveBatchState({ questions: this.questions, answers, completed: true });
			this.done(answers);
		}

		invalidate(): void {
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
		}

		get focused(): boolean {
			return this._focused;
		}

		set focused(val: boolean) {
			this._focused = val;
			if (this.editMode) {
				this.otherEditor.focused = val;
			} else if (this.noteFocused) {
				this.noteEditor.focused = val;
			} else {
				const tab = this.getActiveTab();
				if (tab?.mode === "text") {
					this.editor.focused = val;
				}
			}
		}

		handleInput(data: string): void {
			if (this.editMode) {
				if (matchesKey(data, Key.escape)) {
					this.editMode = false;
					this.otherText = this.otherEditor.getText() || this.otherText;
					this.otherEditor.setText("");
					this.otherEditor.focused = false;
					this.invalidate();
					this.tui.requestRender();
					return;
				}
				this.otherEditor.handleInput(data);
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			// Note editor is focused
			if (this.noteFocused) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
					this.noteFocused = false;
					this.noteEditor.focused = false;
					const tab = this.getActiveTab();
					if (tab) tab.note = this.noteEditor.getText() || "";
					if (tab?.mode === "text") {
						this.editor.focused = true;
					}
					this.invalidate();
					this.tui.requestRender();
					return;
				}
				this.noteEditor.handleInput(data);
				const tab = this.getActiveTab();
				if (tab) tab.note = this.noteEditor.getText() || "";
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			const tab = this.getActiveTab();
			if (!tab) return;

			// Left/Right arrows to switch tabs
			if (matchesKey(data, Key.left)) {
				this.selectTab((this.activeTab - 1 + this.tabs.length) % this.tabs.length);
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.selectTab((this.activeTab + 1) % this.tabs.length);
				return;
			}

			// Tab to focus note editor
			if (matchesKey(data, Key.tab)) {
				this.noteFocused = true;
				this.noteEditor.focused = true;
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			// Ctrl+Enter to submit all
			if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.alt("enter"))) {
				this.submitAll();
				return;
			}

			// Escape to cancel — save cancelled state so we don't reprompt
			if (matchesKey(data, Key.escape)) {
				const answers: TabAnswer[] = this.tabs.map((t, i) => ({
					questionIndex: i,
					answer: t.answer,
				}));
				saveBatchState({ questions: this.questions, answers, completed: true });
				this.done(null);
				return;
			}

			// Enter on text mode: move to next tab or submit on last
			if (tab.mode === "text" && matchesKey(data, Key.enter)) {
				this.syncAnswerFromTab();
				if (this.activeTab === this.tabs.length - 1) {
					this.submitAll();
				} else {
					this.selectTab(this.activeTab + 1);
				}
				return;
			}

			// Delegate to tab type
			if (tab.mode === "text") {
				this.editor.handleInput(data);
				tab.textBuffer = this.editor.getText() || "";
				tab.answer = tab.textBuffer;
				this.invalidate();
				this.tui.requestRender();
			} else if (tab.mode === "single-select") {
				this.handleSingleSelectInput(data, tab);
			} else if (tab.mode === "multi-select") {
				this.handleMultiSelectInput(data, tab);
			}
		}

		private handleSingleSelectInput(data: string, tab: TabState): void {
			const q = this.questions[this.activeTab];

			if (/^[1-9]$/.test(data)) {
				const num = parseInt(data, 10);
				const idx = num - 1;
				if (idx < q.options.length) {
					this.selectOption(tab, q.options[idx], num);
					return;
				}
				if (idx === q.options.length) {
					this.openOtherEditor();
					return;
				}
			}

			if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, "k") || matchesKey(data, "j")) {
				if (this.selectList) {
					this.selectList.handleInput(data);
					this.invalidate();
					this.tui.requestRender();
				}
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (!this.selectList) return;
				const item = this.selectList.getSelectedItem();
				if (!item) return;
				if (item.value === "__other__") {
					this.openOtherEditor();
					return;
				}
				const idx = q.options.findIndex((o) => o.value === item.value);
				if (idx >= 0) {
					this.selectOption(tab, q.options[idx], idx + 1);
				}
			}
		}

		private selectOption(tab: TabState, opt: AskOption, index: number): void {
			const answer: AskAnswer = { type: "option", label: opt.label, value: opt.value, index } as OptionAnswer;
			tab.answer = answer;
			this.selected = new Map();
			this.selected.set(opt.value, answer);
			this.invalidate();
			this.tui.requestRender();
			this.persist();
		}

		private openOtherEditor(): void {
			this.editMode = true;
			this.otherEditor.setText(this.otherText);
			this.otherEditor.focused = true;
			this.invalidate();
			this.tui.requestRender();
		}

		private handleMultiSelectInput(data: string, tab: TabState): void {
			const q = this.questions[this.activeTab];

			if (/^[1-9]$/.test(data)) {
				const num = parseInt(data, 10);
				const idx = num - 1;
				if (idx < q.options.length) {
					this.toggleOption(q.options[idx]);
					this.syncMultiSelectState();
					return;
				}
				if (idx === q.options.length) {
					this.toggleOther();
					return;
				}
			}

			if (matchesKey(data, Key.space) || matchesKey(data, " ")) {
				const selectedItem = this.selectList?.getSelectedItem();
				if (!selectedItem) return;
				if (selectedItem.value === "__other__") {
					this.toggleOther();
				} else {
					const opt = q.options.find((o) => o.value === selectedItem.value);
					if (opt) {
						this.toggleOption(opt);
						this.syncMultiSelectState();
					}
				}
				return;
			}

			if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, "k") || matchesKey(data, "j")) {
				if (this.selectList) {
					this.selectList.handleInput(data);
					this.invalidate();
					this.tui.requestRender();
				}
				return;
			}
		}

		private toggleOption(opt: AskOption): void {
			if (this.selected.has(opt.value)) {
				this.selected.delete(opt.value);
			} else {
				const idx = this.questions[this.activeTab].options.indexOf(opt) + 1;
				this.selected.set(opt.value, { type: "option", label: opt.label, value: opt.value, index: idx } as OptionAnswer);
			}
			this.invalidate();
			this.tui.requestRender();
		}

		private toggleOther(): void {
			if (this.selected.has("other")) {
				this.selected.delete("other");
				this.syncMultiSelectState();
			} else {
				this.openOtherEditor();
			}
		}

		render(width: number): string[] {
			if (this.cachedLines && this.cachedWidth === width) {
				return this.cachedLines;
			}

			const lines: string[] = [];
			const th = this.theme;
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(th.fg("borderMuted", "─".repeat(width)));

			// Tab bar: pill-style tabs with Q labels
			const tabBarParts: string[] = [];
			for (let i = 0; i < this.tabs.length; i++) {
				const isActive = i === this.activeTab;
				const hasAnswer = this.tabs[i].answer !== null && this.tabs[i].answer !== "";
				const checkmark = hasAnswer ? th.fg("success", "✓") : "";
				const label = ` ${checkmark}Q${i + 1} `;
				if (isActive) {
					tabBarParts.push(th.bg("selectedBg", th.fg("accent", th.bold(label))));
				} else if (hasAnswer) {
					tabBarParts.push(th.fg("success", label));
				} else {
					tabBarParts.push(th.fg("dim", label));
				}
			}
			const tabBar = tabBarParts.join(th.fg("borderMuted", " | "));
			add(truncateToWidth(tabBar, width));

			add(th.fg("borderMuted", "─".repeat(width)));

			lines.push("");

			const tab = this.getActiveTab();
			const q = this.questions[this.activeTab];

			// Question header
			addWrapped(lines, th.fg("text", th.bold(`Q${this.activeTab + 1}: ${q.question}`)), width);
			if (q.details) {
				addWrapped(lines, th.fg("muted", ` ${q.details}`), width);
			}
			lines.push("");

			if (tab.mode === "text") {
				this.renderTextTab(width, lines, add, th);
			} else if (tab.mode === "single-select") {
				this.renderSingleSelectTab(width, lines, add, th, tab, q);
			} else if (tab.mode === "multi-select") {
				this.renderMultiSelectTab(width, lines, add, th, tab, q);
			}

			lines.push("");

			// Note area
			const notePlaceholder = this.noteFocused
				? ""
				: th.fg("dim", " (type a note — Tab to focus)");
			add(th.fg("muted", " Add a note (optional):") + notePlaceholder);
			add(th.fg("borderMuted", "─".repeat(width)));
			for (const line of this.noteEditor.render(Math.max(1, width - 2))) {
				add(` ${line}`);
			}

			lines.push("");

			// Footer: submit hint + key help
			add(th.fg("borderMuted", "─".repeat(width)));
			add(th.fg("dim", " ← → Switch  •  ") + th.fg("success", th.bold("Ctrl+Enter Submit")) + th.fg("dim", "  •  Esc Cancel"));

			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		private renderTextTab(width: number, lines: string[], add: (text: string) => void, th: any): void {
			add(th.fg("accent", "─".repeat(width)));
			for (const line of this.editor.render(Math.max(1, width - 2))) {
				add(` ${line}`);
			}
		}

		private getOrCreateSelectList(th: any, q: QuestionDef): void {
			const key = this.activeTab;
			if (this.tabSelectLists.has(key)) {
				this.selectList = this.tabSelectLists.get(key)!;
				return;
			}
			const selectItems: SelectItem[] = q.options.map((opt, i) => ({
				value: opt.value,
				label: `${i + 1}. ${opt.label}`,
				description: opt.description,
			}));
			selectItems.push({
				value: "__other__",
				label: `${q.options.length + 1}. Type a custom answer`,
				description: "Type a custom answer",
			});
			this.selectList = new SelectList(selectItems, Math.min(selectItems.length, 8), {
				selectedPrefix: (t: string) => th.fg("accent", t),
				selectedText: (t: string) => th.fg("accent", t),
				description: (t: string) => th.fg("muted", t),
				scrollInfo: (t: string) => th.fg("dim", t),
				noMatch: (t: string) => th.fg("warning", t),
			});
			this.selectList.onCancel = () => this.done(null);
			this.tabSelectLists.set(key, this.selectList);
		}

		private renderSingleSelectTab(width: number, lines: string[], add: (text: string) => void, th: any, tab: TabState, q: QuestionDef): void {
			if (this.editMode) {
				for (let i = 0; i < q.options.length; i++) {
					add(`  ${th.fg("dim", `${i + 1}. ${q.options[i].label}`)}`);
				}
				add(`  ${th.fg("dim", `${q.options.length + 1}. Type a custom answer`)}`);
				lines.push("");
				add(th.fg("muted", " Write your custom answer:"));
				add(th.fg("accent", "─".repeat(width)));
				for (const line of this.otherEditor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				add(th.fg("dim", " Enter to save  •  Esc to go back"));
				return;
			}

			this.getOrCreateSelectList(th, q);

			if (tab.answer && typeof tab.answer === "object" && !Array.isArray(tab.answer)) {
				add(th.fg("success", ` ✓ Selected: ${(tab.answer as AskAnswer).label}`));
				lines.push("");
			}

			for (const line of this.selectList.render(width - 2)) {
				add(` ${line}`);
			}
		}

		private renderMultiSelectTab(width: number, lines: string[], add: (text: string) => void, th: any, tab: TabState, q: QuestionDef): void {
			if (this.editMode) {
				for (let i = 0; i < q.options.length; i++) {
					const checked = this.selected.has(q.options[i].value);
					add(`  ${th.fg("dim", `${checked ? "[x]" : "[ ]"} ${i + 1}. ${q.options[i].label}`)}`);
				}
				const otherChecked = this.selected.has("other");
				add(`  ${th.fg("dim", `${otherChecked ? "[x]" : "[ ]"} ${q.options.length + 1}. Type a custom answer`)}`);
				lines.push("");
				add(th.fg("accent", "─".repeat(width)));
				add(th.fg("muted", " Write your custom answer:"));
				for (const line of this.otherEditor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				add(th.fg("dim", " Enter to save  •  Esc to go back"));
				return;
			}

			if (this.selected.size > 0) {
				add(th.fg("success", ` ✓ ${this.selected.size} selected`));
			} else {
				add(th.fg("dim", " ○ Select options below"));
			}
			lines.push("");

			this.getOrCreateSelectList(th, q);

			for (let i = 0; i < q.options.length; i++) {
				const opt = q.options[i];
				const isSelected = this.selectList.getSelectedItem()?.value === opt.value;
				const checked = this.selected.has(opt.value);
				const marker = checked ? "[x]" : "[ ]";
				const prefix = isSelected ? th.fg("accent", ">") : " ";
				const styled = isSelected ? th.fg("accent", `${marker} ${i + 1}. ${opt.label}`) : th.fg(checked ? "success" : "text", `${marker} ${i + 1}. ${opt.label}`);
				add(`${prefix} ${styled}`);
				if (opt.description) {
					addWrapped(lines, th.fg("muted", opt.description), width, "      ");
				}
			}

			const otherChecked = this.selected.has("other");
			const otherSuffix = otherChecked ? th.fg("muted", ` — ${this.selected.get("other")!.label}`) : "";
			const isOtherSelected = this.selectList.getSelectedItem()?.value === "__other__";
			const otherPrefix = isOtherSelected ? th.fg("accent", ">") : " ";
			const otherStyled = isOtherSelected
				? th.fg("accent", `${otherChecked ? "[x]" : "[ ]"} ${q.options.length + 1}. Type a custom answer`)
				: th.fg(otherChecked ? "success" : "text", `${otherChecked ? "[x]" : "[ ]"} ${q.options.length + 1}. Type a custom answer`);
			add(`${otherPrefix} ${otherStyled}${otherSuffix}`);
		}
	}

	pi.registerTool({
		name: "ask_questions",
		label: "ask_questions",
		description:
			"Ask the user multiple questions in a tabbed interface and pause execution until all are answered. Use this when you need answers to several related questions at once. Each question can be text, single-select, or multi-select. The user can switch between tabs freely, answers are persisted per question, and a single Submit action finalizes all answers. If the session ends or the user cancels, partial answers are saved and can be resumed on the next call.",
		promptSnippet:
			"Use this tool to ask multiple related questions at once in a tabbed batch interface.",
		promptGuidelines: [
			"Use ask_questions for 2+ related questions where the answers are needed together. For a single question, use ask_user_question instead.",
			"Each question in the array can have its own options and multiSelect flag.",
			"Users can switch between tabs, and all partial answers are preserved even if the tool is cancelled or interrupted — the next ask_questions call will resume where they left off.",
		],
		parameters: AskQuestionsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions: QuestionDef[] = params.questions.map((q: any) => {
				const opts = normalizeOptions(q.options);
				const mode: AskUserQuestionMode =
					opts.length === 0 ? "text" : q.multiSelect ? "multi-select" : "single-select";
				return { question: q.question, details: q.details?.trim() || undefined, mode, options: opts };
			});

			if (signal?.aborted) return batchCancelledResult(questions);

			if (!ctx.hasUI) {
				return batchUnavailableResult(questions);
			}

			return withUILock(async () => {
				const saved = loadBatchState(ctx);
				const prefillAnswers =
					saved &&
					saved.questions.length === questions.length &&
					saved.questions.every((sq: QuestionDef, i: number) => sq.question === questions[i].question)
						? saved.answers
						: null;

				const result = await ctx.ui.custom<any>(
					(tui: any, theme: any, kb: any, done: (r: any) => void) => {
						return new TabbedQuestions(pi, questions, prefillAnswers, tui, theme, kb, done);
					},
				);

				if (!result) {
					return batchCancelledResult(questions);
				}

				saveBatchState({
					questions,
					answers: result as TabAnswer[],
					completed: true,
				});

				return buildBatchResult(questions, result as TabAnswer[]);
			});
		},

		renderCall(args, theme) {
			const count = (args.questions as any[])?.length || 0;
			const qs = (args.questions as any[]) || [];
			const qLabels = qs
				.map((q: any) => {
					const opts = normalizeOptions(q.options);
					const mode = !opts?.length ? "text" : q.multiSelect ? "Multi-Choice" : "Single Choice";
					return `${q.question} [${mode}]`;
				})
				.join(" • ");

			let text = theme.fg("toolTitle", theme.bold(`☰ ask_questions (${count}) `));
			text += theme.fg("muted", qLabels);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as BatchQuestionResultDetails | undefined;
			if (!details || details.status !== "answered") {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const resultLines: string[] = [];
			resultLines.push(
				theme.fg("success", `✓ ${details.questions.length} questions answered`),
			);

			for (let i = 0; i < details.questions.length; i++) {
				const q = details.questions[i];
				const ans = details.answers[i];
				if (!ans) continue;

				resultLines.push("");
				resultLines.push(
					theme.fg("accent", `Q${i + 1}: `) + theme.fg("muted", q.question),
				);

				if (q.mode === "text") {
					const val = typeof ans.answer === "string" ? ans.answer : "";
					resultLines.push(
						`  ${theme.fg("success", "✓ ")}${theme.fg("text", val || "(empty)")}`,
					);
				} else if (Array.isArray(ans.answer)) {
					for (const a of ans.answer as AskAnswer[]) {
						if (a.type === "option") {
							resultLines.push(
								`  ${theme.fg("success", "✓ ")}${theme.fg("accent", `${a.index}. ${a.label}`)}`,
							);
						} else if (a.type === "other") {
							resultLines.push(
								`  ${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", a.label)}`,
							);
						}
					}
				} else if (ans.answer && typeof ans.answer === "object") {
					const a = ans.answer as AskAnswer;
					if (a.type === "option") {
						resultLines.push(
							`  ${theme.fg("success", "✓ ")}${theme.fg("accent", `${a.index}. ${a.label}`)}`,
						);
					} else if (a.type === "other") {
						resultLines.push(
							`  ${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", a.label)}`,
						);
					}
				}
			}

			return new Text(resultLines.join("\n"), 0, 0);
		},
	});
}
