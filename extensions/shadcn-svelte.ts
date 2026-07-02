import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { Type } from "typebox";

const COMPONENTS = [
	{ slug: "accordion", label: "Accordion", category: "Layout & Navigation", description: "Vertically stacked interactive headings that reveal sections of content." },
	{ slug: "alert", label: "Alert", category: "Feedback & Status", description: "A callout for user attention." },
	{ slug: "alert-dialog", label: "Alert Dialog", category: "Overlays & Dialogs", description: "A modal dialog that interrupts the user and expects a response." },
	{ slug: "aspect-ratio", label: "Aspect Ratio", category: "Display & Media", description: "Display content within a desired ratio." },
	{ slug: "avatar", label: "Avatar", category: "Display & Media", description: "An image element with a fallback for representing a user." },
	{ slug: "badge", label: "Badge", category: "Feedback & Status", description: "Displays a badge or badge-like component." },
	{ slug: "breadcrumb", label: "Breadcrumb", category: "Layout & Navigation", description: "Displays the path to the current resource using hierarchical links." },
	{ slug: "button", label: "Button", category: "Form & Input", description: "Displays a button or button-like component." },
	{ slug: "button-group", label: "Button Group", category: "Form & Input", description: "Groups related buttons with consistent styling." },
	{ slug: "calendar", label: "Calendar", category: "Form & Input", description: "A calendar component for selecting dates." },
	{ slug: "card", label: "Card", category: "Display & Media", description: "Displays a card with header, content, and footer." },
	{ slug: "carousel", label: "Carousel", category: "Display & Media", description: "A carousel with motion and swipe built using Embla." },
	{ slug: "chart", label: "Chart", category: "Display & Media", description: "Charts built using LayerChart." },
	{ slug: "checkbox", label: "Checkbox", category: "Form & Input", description: "A checked/unchecked toggle control." },
	{ slug: "collapsible", label: "Collapsible", category: "Misc", description: "An interactive component that expands or collapses a panel." },
	{ slug: "combobox", label: "Combobox", category: "Form & Input", description: "Autocomplete input and command-palette style suggestions." },
	{ slug: "command", label: "Command", category: "Overlays & Dialogs", description: "Fast, composable command menu for Svelte." },
	{ slug: "context-menu", label: "Context Menu", category: "Overlays & Dialogs", description: "A menu triggered by right click." },
	{ slug: "data-table", label: "Data Table", category: "Display & Media", description: "Powerful tables and datagrids using TanStack Table." },
	{ slug: "date-picker", label: "Date Picker", category: "Form & Input", description: "A date picker with range and preset examples." },
	{ slug: "dialog", label: "Dialog", category: "Overlays & Dialogs", description: "A modal window that renders underlying content inert." },
	{ slug: "drawer", label: "Drawer", category: "Overlays & Dialogs", description: "A drawer component for Svelte." },
	{ slug: "dropdown-menu", label: "Dropdown Menu", category: "Overlays & Dialogs", description: "A button-triggered menu of actions." },
	{ slug: "empty", label: "Empty", category: "Feedback & Status", description: "Displays an empty state." },
	{ slug: "field", label: "Field", category: "Form & Input", description: "Composes labels, controls, and help text for accessible form fields." },
	{ slug: "hover-card", label: "Hover Card", category: "Overlays & Dialogs", description: "Previews content available behind a link." },
	{ slug: "input", label: "Input", category: "Form & Input", description: "Displays a form input field." },
	{ slug: "input-group", label: "Input Group", category: "Form & Input", description: "Displays extra information or actions with an input or textarea." },
	{ slug: "input-otp", label: "Input OTP", category: "Form & Input", description: "Accessible one-time password input with copy/paste support." },
	{ slug: "item", label: "Item", category: "Display & Media", description: "A versatile component for displaying content." },
	{ slug: "kbd", label: "Kbd", category: "Display & Media", description: "Displays textual keyboard input." },
	{ slug: "label", label: "Label", category: "Form & Input", description: "Accessible labels associated with controls." },
	{ slug: "menubar", label: "Menubar", category: "Overlays & Dialogs", description: "A persistent desktop-application style menu." },
	{ slug: "native-select", label: "Native Select", category: "Form & Input", description: "A styled native HTML select element." },
	{ slug: "navigation-menu", label: "Navigation Menu", category: "Layout & Navigation", description: "A collection of links for navigating websites." },
	{ slug: "pagination", label: "Pagination", category: "Misc", description: "Pagination with page, next, and previous links." },
	{ slug: "popover", label: "Popover", category: "Overlays & Dialogs", description: "Rich portal content triggered by a button." },
	{ slug: "progress", label: "Progress", category: "Feedback & Status", description: "An indicator for task completion progress." },
	{ slug: "radio-group", label: "Radio Group", category: "Form & Input", description: "A set of mutually exclusive radio buttons." },
	{ slug: "range-calendar", label: "Range Calendar", category: "Misc", description: "A calendar component for selecting a range of dates." },
	{ slug: "resizable", label: "Resizable", category: "Layout & Navigation", description: "Resizable panel groups and layouts with keyboard support." },
	{ slug: "scroll-area", label: "Scroll Area", category: "Layout & Navigation", description: "Custom cross-browser scroll styling." },
	{ slug: "select", label: "Select", category: "Form & Input", description: "A button-triggered list of options." },
	{ slug: "separator", label: "Separator", category: "Layout & Navigation", description: "Visually or semantically separates content." },
	{ slug: "sheet", label: "Sheet", category: "Overlays & Dialogs", description: "A Dialog extension for complementary side content." },
	{ slug: "sidebar", label: "Sidebar", category: "Layout & Navigation", description: "A composable, themeable, customizable sidebar." },
	{ slug: "skeleton", label: "Skeleton", category: "Feedback & Status", description: "Shows a placeholder while content is loading." },
	{ slug: "slider", label: "Slider", category: "Form & Input", description: "An input for choosing a value within a range." },
	{ slug: "sonner", label: "Sonner", category: "Feedback & Status", description: "An opinionated toast component for Svelte." },
	{ slug: "spinner", label: "Spinner", category: "Feedback & Status", description: "A loading state indicator." },
	{ slug: "switch", label: "Switch", category: "Form & Input", description: "A checked/unchecked toggle control." },
	{ slug: "table", label: "Table", category: "Display & Media", description: "A responsive table component." },
	{ slug: "tabs", label: "Tabs", category: "Layout & Navigation", description: "Layered content panels displayed one at a time." },
	{ slug: "textarea", label: "Textarea", category: "Form & Input", description: "Displays a form textarea." },
	{ slug: "toggle", label: "Toggle", category: "Misc", description: "A two-state on/off button." },
	{ slug: "toggle-group", label: "Toggle Group", category: "Misc", description: "A set of two-state buttons." },
	{ slug: "tooltip", label: "Tooltip", category: "Overlays & Dialogs", description: "A popup shown on keyboard focus or hover." },
	{ slug: "typography", label: "Typography", category: "Display & Media", description: "Styles for headings, paragraphs, lists, and more." },
] as const;

const COMPONENT_SLUGS = COMPONENTS.map((component) => component.slug) as [
	(typeof COMPONENTS)[number]["slug"],
	...(typeof COMPONENTS)[number]["slug"][],
];

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2_000;

const PACKAGE_MANAGERS = ["auto", "pnpm", "npm", "bun"] as const;
const ACTIONS = ["add", "init", "docs", "list", "install-skill"] as const;
const BASE_COLORS = ["slate", "gray", "zinc", "neutral", "stone"] as const;

const ALIASES: Record<string, (typeof COMPONENTS)[number]["slug"]> = {
	accordian: "accordion",
	accordion: "accordion",
	"alert dialog": "alert-dialog",
	"button group": "button-group",
	calendar: "calendar",
	combobox: "combobox",
	"context menu": "context-menu",
	"data table": "data-table",
	datatable: "data-table",
	"date picker": "date-picker",
	"dropdown menu": "dropdown-menu",
	"hover card": "hover-card",
	"input group": "input-group",
	"input otp": "input-otp",
	menubar: "menubar",
	"native select": "native-select",
	"navigation menu": "navigation-menu",
	"radio group": "radio-group",
	"range calendar": "range-calendar",
	"scroll area": "scroll-area",
	"toggle group": "toggle-group",
};

type PackageManager = (typeof PACKAGE_MANAGERS)[number];
type ComponentSlug = (typeof COMPONENTS)[number]["slug"];

function stringEnum<T extends readonly [string, ...string[]]>(values: T, description?: string) {
	return Type.String({ enum: [...values], description });
}

const ShadcnParams = Type.Object({
	action: stringEnum(
		ACTIONS,
		"What to do: add components, initialize shadcn-svelte, fetch component docs/options, list components, or install the official shadcn-svelte skill.",
	),
	components: Type.Optional(
		Type.Array(
			stringEnum(
				COMPONENT_SLUGS,
				"Official component slug. Examples: accordion, alert-dialog, button, card, data-table, dialog, sidebar, tabs.",
			),
			{
				description:
					"Official component slugs to add or fetch docs for. Examples: accordion, alert-dialog, button, card, data-table, dialog, sidebar, tabs.",
			},
		),
	),
	customItems: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional registry URLs or custom registry item names to pass to `shadcn-svelte add`.",
		}),
	),
	packageManager: Type.Optional(
		stringEnum(
			PACKAGE_MANAGERS,
			"CLI runner to use. auto detects pnpm-lock.yaml, bun.lock/bun.lockb, or package-lock.json.",
		),
	),
	all: Type.Optional(Type.Boolean({ description: "For action=add, install every component with `--all`." })),
	yes: Type.Optional(
		Type.Boolean({ description: "For action=add, pass `--yes` to skip the CLI confirmation prompt. Defaults to true." }),
	),
	overwrite: Type.Optional(Type.Boolean({ description: "Pass `--overwrite` / `-o` to overwrite existing generated files." })),
	noDeps: Type.Optional(Type.Boolean({ description: "Pass `--no-deps` to skip adding/installing package dependencies." })),
	skipPreflight: Type.Optional(Type.Boolean({ description: "Pass `--skip-preflight` to ignore preflight checks." })),
	proxy: Type.Optional(Type.String({ description: "Proxy URL to pass with `--proxy`." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the shadcn-svelte command. Defaults to the current pi project." })),
	baseColor: Type.Optional(
		stringEnum(BASE_COLORS, "For action=init, base color choice for components.json and CSS variables."),
	),
	css: Type.Optional(Type.String({ description: "For action=init, path to the global CSS file." })),
	componentsAlias: Type.Optional(Type.String({ description: "For action=init, import alias for components." })),
	libAlias: Type.Optional(Type.String({ description: "For action=init, import alias for lib." })),
	utilsAlias: Type.Optional(Type.String({ description: "For action=init, import alias for utils." })),
	hooksAlias: Type.Optional(Type.String({ description: "For action=init, import alias for hooks." })),
	uiAlias: Type.Optional(Type.String({ description: "For action=init, import alias for ui components." })),
});

type ShadcnParamsType = {
	action: (typeof ACTIONS)[number];
	components?: ComponentSlug[];
	customItems?: string[];
	packageManager?: PackageManager;
	all?: boolean;
	yes?: boolean;
	overwrite?: boolean;
	noDeps?: boolean;
	skipPreflight?: boolean;
	proxy?: string;
	cwd?: string;
	baseColor?: (typeof BASE_COLORS)[number];
	css?: string;
	componentsAlias?: string;
	libAlias?: string;
	utilsAlias?: string;
	hooksAlias?: string;
	uiAlias?: string;
};

function findUp(start: string, fileNames: string[]): string | undefined {
	let current = start;
	while (true) {
		for (const name of fileNames) {
			const candidate = join(current, name);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(current);
		if (parent === current || current === parse(current).root) return undefined;
		current = parent;
	}
}

function detectPackageManager(cwd: string): Exclude<PackageManager, "auto"> {
	const packageJsonPath = findUp(cwd, ["package.json"]);
	if (packageJsonPath) {
		try {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { packageManager?: string };
			if (packageJson.packageManager?.startsWith("pnpm@")) return "pnpm";
			if (packageJson.packageManager?.startsWith("bun@")) return "bun";
			if (packageJson.packageManager?.startsWith("npm@")) return "npm";
		} catch {
			// Ignore malformed package.json and fall through to lockfile detection.
		}
	}

	if (findUp(cwd, ["pnpm-lock.yaml"])) return "pnpm";
	if (findUp(cwd, ["bun.lock", "bun.lockb"])) return "bun";
	return "npm";
}

function resolvePackageManager(cwd: string, requested: PackageManager | undefined): Exclude<PackageManager, "auto"> {
	if (requested && requested !== "auto") return requested;
	return detectPackageManager(cwd);
}

function runnerFor(packageManager: Exclude<PackageManager, "auto">, binary: "shadcn-svelte@latest" | "skills") {
	if (packageManager === "pnpm") return { command: "pnpm", args: ["dlx", binary] };
	if (packageManager === "bun") return { command: "bun", args: ["x", binary] };
	return { command: "npx", args: ["--yes", binary] };
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map((part) => (/[\s"'$]/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function normalizeComponent(input: string): ComponentSlug | undefined {
	const cleaned = input
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/^shadcn[- ]svelte\s+/, "")
		.replace(/\s+component$/, "");
	const alias = ALIASES[cleaned];
	if (alias) return alias;
	const slug = cleaned.replace(/\s+/g, "-");
	return COMPONENT_SLUGS.includes(slug as ComponentSlug) ? (slug as ComponentSlug) : undefined;
}

function groupComponents(): string {
	const groups = new Map<string, typeof COMPONENTS[number][]>();
	for (const component of COMPONENTS) {
		const group = groups.get(component.category) ?? [];
		group.push(component);
		groups.set(component.category, group);
	}

	const lines = ["shadcn-svelte components:"];
	for (const [category, components] of groups) {
		lines.push("", `${category}:`);
		for (const component of components) {
			lines.push(`- ${component.slug} — ${component.description}`);
		}
	}
	return lines.join("\n");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function clipByBytes(text: string, maxBytes: number, mode: "head" | "tail"): string {
	let bytes = 0;
	const chars = Array.from(text);
	const kept: string[] = [];
	const iterable = mode === "head" ? chars : [...chars].reverse();
	for (const char of iterable) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		kept.push(char);
		bytes += charBytes;
	}
	return mode === "head" ? kept.join("") : kept.reverse().join("");
}

function truncateText(input: string, mode: "head" | "tail"): {
	content: string;
	truncated: boolean;
	outputLines: number;
	totalLines: number;
	outputBytes: number;
	totalBytes: number;
} {
	const lines = input.split("\n");
	const totalBytes = Buffer.byteLength(input, "utf8");
	if (lines.length <= DEFAULT_MAX_LINES && totalBytes <= DEFAULT_MAX_BYTES) {
		return {
			content: input,
			truncated: false,
			outputLines: lines.length,
			totalLines: lines.length,
			outputBytes: totalBytes,
			totalBytes,
		};
	}

	const source = mode === "head" ? lines : [...lines].reverse();
	const kept: string[] = [];
	let bytes = 0;
	for (const line of source) {
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
		if (kept.length >= DEFAULT_MAX_LINES || bytes + lineBytes > DEFAULT_MAX_BYTES) {
			if (kept.length === 0) kept.push(clipByBytes(line, DEFAULT_MAX_BYTES, mode));
			break;
		}
		kept.push(line);
		bytes += lineBytes;
	}
	const ordered = mode === "head" ? kept : kept.reverse();
	const content = ordered.join("\n");
	return {
		content,
		truncated: true,
		outputLines: ordered.length,
		totalLines: lines.length,
		outputBytes: Buffer.byteLength(content, "utf8"),
		totalBytes,
	};
}

async function fetchComponentDocs(components: ComponentSlug[], signal?: AbortSignal): Promise<string> {
	if (components.length === 0) {
		return `${groupComponents()}\n\nUse action=docs with one or more components to fetch official markdown docs, usage examples, and per-component options.`;
	}

	const sections: string[] = [];
	for (const component of components) {
		try {
			const response = await fetch(`https://shadcn-svelte.com/docs/components/${component}.md`, { signal });
			if (!response.ok) {
				sections.push(`# ${component}\n\nFailed to fetch docs: HTTP ${response.status}`);
				continue;
			}
			const markdown = await response.text();
			sections.push(markdown.trim());
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
			const message = error instanceof Error ? error.message : String(error);
			sections.push(`# ${component}\n\nFailed to fetch docs: ${message}`);
		}
	}

	const docs = sections.join("\n\n---\n\n");
	const truncation = truncateText(docs, "head");
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Docs truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Fetch fewer components for complete docs.]`;
}

function commandOutput(stdout: string, stderr: string): string {
	const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
	if (!combined) return "(no output)";
	const truncation = truncateText(combined, "tail");
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

async function runShadcn(pi: ExtensionAPI, params: ShadcnParamsType, cwd: string, signal?: AbortSignal) {
	const packageManager = resolvePackageManager(cwd, params.packageManager);
	const runner = runnerFor(packageManager, "shadcn-svelte@latest");
	const args = [...runner.args];

	if (params.action === "init") {
		args.push("init");
		if (params.overwrite) args.push("--overwrite");
		if (params.noDeps) args.push("--no-deps");
		if (params.skipPreflight) args.push("--skip-preflight");
		if (params.baseColor) args.push("--base-color", params.baseColor);
		if (params.css) args.push("--css", params.css);
		if (params.componentsAlias) args.push("--components-alias", params.componentsAlias);
		if (params.libAlias) args.push("--lib-alias", params.libAlias);
		if (params.utilsAlias) args.push("--utils-alias", params.utilsAlias);
		if (params.hooksAlias) args.push("--hooks-alias", params.hooksAlias);
		if (params.uiAlias) args.push("--ui-alias", params.uiAlias);
		if (params.proxy) args.push("--proxy", params.proxy);
	} else {
		args.push("add");
		if (params.all) {
			args.push("--all");
		} else {
			const items = [...(params.components ?? []), ...(params.customItems ?? [])];
			if (items.length === 0) throw new Error("action=add needs components, customItems, or all=true.");
			args.push(...items);
		}
		if (params.yes !== false) args.push("--yes");
		if (params.overwrite) args.push("--overwrite");
		if (params.noDeps) args.push("--no-deps");
		if (params.skipPreflight) args.push("--skip-preflight");
		if (params.proxy) args.push("--proxy", params.proxy);
	}

	const result = await pi.exec(runner.command, args, { cwd, signal, timeout: 120_000 });
	return {
		packageManager,
		command: formatCommand(runner.command, args),
		code: result.code,
		output: commandOutput(result.stdout, result.stderr),
	};
}

async function runSkillInstall(pi: ExtensionAPI, params: ShadcnParamsType, cwd: string, signal?: AbortSignal) {
	const packageManager = resolvePackageManager(cwd, params.packageManager);
	const runner = runnerFor(packageManager, "skills");
	const args = [...runner.args, "add", "huntabyte/shadcn-svelte"];
	const result = await pi.exec(runner.command, args, { cwd, signal, timeout: 120_000 });
	return {
		packageManager,
		command: formatCommand(runner.command, args),
		code: result.code,
		output: commandOutput(result.stdout, result.stderr),
	};
}

function parseArgs(args: string): string[] {
	return args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function collectComponents(tokens: string[]): { components: ComponentSlug[]; customItems: string[] } {
	const components: ComponentSlug[] = [];
	const customItems: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const next = tokens[index + 1];
		const combined = next ? normalizeComponent(`${token} ${next}`) : undefined;
		if (combined) {
			components.push(combined);
			index++;
			continue;
		}

		const normalized = normalizeComponent(token);
		if (normalized) components.push(normalized);
		else customItems.push(token);
	}
	return { components, customItems };
}

function helpText(): string {
	return `shadcn-svelte helper

Natural language examples:
- add the shadcn accordion component
- add shadcn alert dialog and button, then use it on the settings page
- show me the shadcn-svelte card docs/options

Slash command examples:
- /shadcn list
- /shadcn docs accordion
- /shadcn add accordion alert-dialog --overwrite
- /shadcn init --base-color zinc --css src/app.css
- /shadcn skill

The extension also exposes the shadcn_svelte tool so the agent can run the official CLI and fetch official component docs automatically.`;
}

export default function shadcnSvelteExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "shadcn_svelte",
		label: "shadcn-svelte",
		description:
			"List, inspect, initialize, and install shadcn-svelte components using the official docs and CLI. Use for natural-language requests like 'add the shadcn accordion component'.",
		promptSnippet: "Add/list/docs/init shadcn-svelte components via the official CLI and markdown docs",
		promptGuidelines: [
			"Use shadcn_svelte when the user asks to add, install, inspect, or use a shadcn-svelte component; normalize common typos such as 'accordian' to 'accordion'.",
			"Use shadcn_svelte action=docs before composing unfamiliar shadcn-svelte components so you can offer the user relevant options from the official docs.",
			"After shadcn_svelte action=add succeeds, inspect or edit project files as needed to actually use the generated component in the app.",
			"Use shadcn_svelte action=install-skill when the user wants the official huntabyte/shadcn-svelte Agent Skill installed for deeper project-aware guidance.",
		],
		parameters: ShadcnParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args as ShadcnParamsType;
			const input = args as ShadcnParamsType & { component?: unknown; components?: unknown };
			if (typeof input.component === "string" && input.components === undefined) {
				const normalized = normalizeComponent(input.component);
				return { ...input, components: normalized ? [normalized] : undefined } as ShadcnParamsType;
			}
			return input;
		},
		async execute(_toolCallId, params: ShadcnParamsType, signal, _onUpdate, ctx) {
			const cwd = params.cwd?.trim() || ctx.cwd;

			if (params.action === "list") {
				return { content: [{ type: "text", text: groupComponents() }], details: { components: COMPONENTS } };
			}

			if (params.action === "docs") {
				const text = await fetchComponentDocs(params.components ?? [], signal);
				return { content: [{ type: "text", text }], details: { components: params.components ?? [] } };
			}

			if (params.action === "install-skill") {
				const result = await runSkillInstall(pi, params, cwd, signal);
				const ok = result.code === 0;
				return {
					content: [
						{
							type: "text",
							text: `${ok ? "Installed" : "Failed to install"} shadcn-svelte skill with ${result.command}\n\n${result.output}`,
						},
					],
					details: result,
				};
			}

			const result = await runShadcn(pi, params, cwd, signal);
			const ok = result.code === 0;
			return {
				content: [
					{
						type: "text",
						text: `${ok ? "shadcn-svelte command succeeded" : "shadcn-svelte command failed"}: ${result.command}\n\n${result.output}`,
					},
				],
				details: result,
			};
		},
		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "?";
			const components = Array.isArray(args.components) ? args.components.join(", ") : "";
			const suffix = components ? ` ${components}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("shadcn_svelte ")) + theme.fg("muted", `${action}${suffix}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { code?: number; command?: string } | undefined;
			if (details?.command) {
				const color = details.code === 0 ? "success" : "error";
				return new Text(theme.fg(color, details.code === 0 ? "✓ " : "✗ ") + theme.fg("muted", details.command), 0, 0);
			}
			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text.split("\n")[0] ?? "" : "", 0, 0);
		},
	});

	pi.registerCommand("shadcn", {
		description: "shadcn-svelte helper: list, docs <component>, add <component...>, init, or skill",
		handler: async (args, ctx) => {
			const parts = parseArgs(args ?? "");
			const command = parts.shift();
			if (!command || command === "help" || command === "--help" || command === "-h") return helpText();

			if (command === "list") return groupComponents();

			const packageManagerFlagIndex = parts.indexOf("--pm");
			const packageManager = packageManagerFlagIndex >= 0 ? (parts[packageManagerFlagIndex + 1] as PackageManager | undefined) : undefined;
			if (packageManagerFlagIndex >= 0) parts.splice(packageManagerFlagIndex, 2);

			if (command === "docs") {
				const { components } = collectComponents(parts.filter((part) => !part.startsWith("-")));
				return fetchComponentDocs(components, ctx.signal);
			}

			if (command === "skill") {
				const result = await runSkillInstall(pi, { action: "install-skill", packageManager }, ctx.cwd, ctx.signal);
				return `${result.command}\n\n${result.output}`;
			}

			if (command === "add") {
				const overwrite = parts.includes("--overwrite") || parts.includes("-o");
				const noDeps = parts.includes("--no-deps");
				const skipPreflight = parts.includes("--skip-preflight");
				const all = parts.includes("--all") || parts.includes("-a");
				const names = parts.filter((part) => !part.startsWith("-"));
				const { components, customItems } = collectComponents(names);
				const result = await runShadcn(
					pi,
					{ action: "add", components, customItems, all, overwrite, noDeps, skipPreflight, packageManager },
					ctx.cwd,
					ctx.signal,
				);
				return `${result.command}\n\n${result.output}`;
			}

			if (command === "init") {
				const getFlagValue = (flag: string) => {
					const index = parts.indexOf(flag);
					return index >= 0 ? parts[index + 1] : undefined;
				};
				const result = await runShadcn(
					pi,
					{
						action: "init",
						packageManager,
						overwrite: parts.includes("--overwrite") || parts.includes("-o"),
						noDeps: parts.includes("--no-deps"),
						skipPreflight: parts.includes("--skip-preflight"),
						baseColor: getFlagValue("--base-color") as (typeof BASE_COLORS)[number] | undefined,
						css: getFlagValue("--css"),
						componentsAlias: getFlagValue("--components-alias"),
						libAlias: getFlagValue("--lib-alias"),
						utilsAlias: getFlagValue("--utils-alias"),
						hooksAlias: getFlagValue("--hooks-alias"),
						uiAlias: getFlagValue("--ui-alias"),
					},
					ctx.cwd,
					ctx.signal,
				);
				return `${result.command}\n\n${result.output}`;
			}

			return helpText();
		},
	});
}
