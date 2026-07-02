type TextPart = { type: "text"; text: string };
type ContentPart = TextPart | { type: string; [key: string]: unknown };

const SVELTE_RE = /\.svelte(?:\.(?:ts|js))?$/;
const TEST_BUILD_RE = /(?:^|[\s;&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)\b|(?:^|[\s;&|])(?:vitest|jest|mocha|playwright|tsc|svelte-check)\b/;

export function isSveltePath(path: unknown): boolean {
	return typeof path === "string" && SVELTE_RE.test(path);
}

export function toolInputPath(input: Record<string, unknown>): string {
	return String(input.path ?? input.file_path ?? "");
}

export function svelteBackstopReason(path: string): string {
	return `Direct edits to ${path} are blocked by the subagents extension. Route this change through the svelte-worker subagent so Svelte 5 syntax/docs/autofixer validation runs.`;
}

export function isTestOrBuildCommand(command: unknown): boolean {
	return typeof command === "string" && TEST_BUILD_RE.test(command);
}

export function appendDebuggerNudge(content: ContentPart[], command: string): ContentPart[] {
	const nudge = `\n\nSubagents nudge: \`${command}\` failed. Treat this as a known failure event and consider routing root-cause work through the debugger subagent.`;
	const out = [...content];
	for (let i = out.length - 1; i >= 0; i--) {
		const part = out[i];
		if (part.type === "text" && typeof (part as TextPart).text === "string") {
			out[i] = { ...(part as TextPart), text: `${(part as TextPart).text}${nudge}` };
			return out;
		}
	}
	out.push({ type: "text", text: nudge.trimStart() });
	return out;
}
