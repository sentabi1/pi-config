import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const READONLY_TOOLS = ["read", "grep", "find", "ls"];

/** Claude tool names → pi tool names (for optional .claude/agents discovery). */
const CLAUDE_TOOL_MAP: Record<string, string> = {
	Read: "read",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	Bash: "bash",
	Edit: "edit",
	Write: "write",
	MultiEdit: "edit",
};

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	tier?: "fast" | "strong";
	advertise: "always" | "judgment" | "never";
	thinking?: string;
	tools?: string[];
	readonly: boolean;
	color: string;
	/** Inherit the project's AGENTS.md conventions (and only those) into the child. */
	conventions: boolean;
	spawn: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface RawFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	tier?: string;
	advertise?: string;
	thinking?: string;
	tools?: string[] | string;
	readonly?: boolean | string;
	color?: string;
	conventions?: boolean | string;
	/** Legacy alias for `conventions`. */
	fork?: boolean | string;
	spawn?: string[] | string;
}

function asBool(v: boolean | string | undefined): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v.trim().toLowerCase() === "true";
	return false;
}

function asList(v: string[] | string | undefined): string[] {
	if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
	if (typeof v === "string")
		return v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return [];
}

const FALLBACK_COLORS = ["cyan", "purple", "green", "orange", "blue", "pink", "yellow", "magenta"];

function asTier(v: string | undefined): "fast" | "strong" | undefined {
	const s = v?.trim();
	return s === "fast" || s === "strong" ? s : undefined;
}

function asAdvertise(v: string | undefined): "always" | "judgment" | "never" {
	const s = v?.trim();
	return s === "always" || s === "judgment" || s === "never" ? s : "judgment";
}

export function parseAgentFile(
	content: string,
	filePath: string,
	source: "user" | "project",
	translateClaudeTools = false,
): AgentConfig | null {
	const { frontmatter, body } = parseFrontmatter<RawFrontmatter>(content);
	if (!frontmatter.name || !frontmatter.description) return null;

	let tools = asList(frontmatter.tools);
	if (translateClaudeTools) tools = tools.map((t) => CLAUDE_TOOL_MAP[t] ?? t.toLowerCase());

	const nameHash = [...frontmatter.name].reduce((a, c) => a + c.charCodeAt(0), 0);

	return {
		name: frontmatter.name.trim(),
		description: frontmatter.description.trim(),
		model: frontmatter.model?.trim() || undefined,
		tier: asTier(frontmatter.tier),
		advertise: asAdvertise(frontmatter.advertise),
		thinking: frontmatter.thinking?.trim() || undefined,
		tools: tools.length > 0 ? tools : undefined,
		readonly: asBool(frontmatter.readonly),
		color: frontmatter.color?.trim() || FALLBACK_COLORS[nameHash % FALLBACK_COLORS.length],
		conventions: asBool(frontmatter.conventions ?? frontmatter.fork),
		spawn: asList(frontmatter.spawn),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

/** Build the tool config for a child session from an agent's allowlist / readonly shorthand.
 * When `includeSubagent` is set (the agent may delegate), the scoped `subagent` tool is
 * added to any explicit allowlist so the injected custom tool is actually enabled. */
export function resolveChildToolNames(agent: AgentConfig, includeSubagent = false): { tools?: string[]; noTools?: "all" | "builtin" } {
	const withSubagent = (tools: string[]): string[] => (includeSubagent && !tools.includes("subagent") ? [...tools, "subagent"] : tools);
	if (agent.readonly) {
		const base = agent.tools && agent.tools.length > 0 ? agent.tools.filter((t) => READONLY_TOOLS.includes(t)) : READONLY_TOOLS;
		return { tools: withSubagent(base) };
	}
	if (agent.tools && agent.tools.length > 0) return { tools: withSubagent(agent.tools) };
	return {}; // inherit pi defaults (read, bash, edit, write) + custom tools are enabled by default
}

function loadDir(dir: string, source: "user" | "project", translateClaudeTools = false): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: AgentConfig[] = [];
	for (const e of entries) {
		if (!e.name.endsWith(".md")) continue;
		if (!e.isFile() && !e.isSymbolicLink()) continue;
		const fp = path.join(dir, e.name);
		try {
			const cfg = parseAgentFile(fs.readFileSync(fp, "utf-8"), fp, source, translateClaudeTools);
			if (cfg) out.push(cfg);
		} catch {
			/* skip unreadable */
		}
	}
	return out;
}

function findProjectDir(cwd: string, ...segments: string[]): string | null {
	let cur = cwd;
	while (true) {
		const candidate = path.join(cur, ...segments);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* ignore */
		}
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

export function discoverAgents(cwd: string, opts: { includeProject: boolean }): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findProjectDir(cwd, CONFIG_DIR_NAME, "agents");
	const claudeAgentsDir = findProjectDir(cwd, ".claude", "agents");

	const map = new Map<string, AgentConfig>();
	for (const a of loadDir(userDir, "user")) map.set(a.name, a);
	if (opts.includeProject) {
		// .claude/agents first, then native project agents (native wins on conflict).
		if (claudeAgentsDir) for (const a of loadDir(claudeAgentsDir, "project", true)) map.set(a.name, a);
		if (projectAgentsDir) for (const a of loadDir(projectAgentsDir, "project")) map.set(a.name, a);
	}
	return { agents: [...map.values()], projectAgentsDir };
}
