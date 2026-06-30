# Subagents Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal `pi` subagents extension that delegates tasks to in-process child `AgentSession`s with live visuals, a roster/library overlay, background runs with notifications, and isolated-by-default context.

**Architecture:** Each subagent is an in-process child `AgentSession` (NOT a subprocess) created via `createAgentSession({ model, tools, sessionManager: SessionManager.inMemory(), resourceLoader, modelRegistry })`. A child gets a lean `DefaultResourceLoader` whose `systemPrompt` is the agent's markdown body and whose context-file/extension/skill loading is disabled → isolation. We stream `session.subscribe(...)` events into a shared `RunRegistry`, which drives both the `subagent` tool's inline render and a persistent `setWidget("subagents", …)` live widget. A `/agents` overlay (built with `ctx.ui.custom`) browses the roster, dispatches single/chain runs, and scaffolds new agent files.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` SDK (v0.80.2), `@earendil-works/pi-tui`, `typebox`. Loaded by pi from `~/.pi/agent/extensions/subagents/index.ts`. Agent definitions in `~/.pi/agent/agents/*.md`.

## Global Constraints

- All work lives under `~/.pi/agent/extensions/subagents/` and `~/.pi/agent/agents/` (config dirs; untouched by `npm update`). Never patch `dist`.
- Import package symbols from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (pi's loader aliases `@mariozechner/*` to the same bundled modules; either works — pick `@earendil-works` for canonical naming).
- Entry contract: `export default function (pi: ExtensionAPI)`.
- Use only supported `ctx.ui.*` / SDK APIs verified below so the extension survives `pi update`.
- This machine's providers (from `~/.pi/agent/models.json`): provider `deepseek`, models `deepseek-v4-flash` (fast/recon) and `deepseek-v4-pro` (review/plan). No Anthropic models configured.
- Depth cap = 1: a child may not spawn further subagents unless its `spawn` allowlist permits AND current depth < 1. Max concurrency ≈ 6. Max parallel tasks = 6.
- Child verbose tool output stays OFF the main thread: the tool returns only each child's final message (summary), capped per task.
- TypeScript files use tabs (match house style in `~/.pi/agent/extensions/*.ts`).

### Verified SDK surface (copy references, do not re-derive)

```ts
// @earendil-works/pi-coding-agent
createAgentSession(options?: CreateAgentSessionOptions): Promise<{ session: AgentSession; extensionsResult; modelFallbackMessage? }>
//   CreateAgentSessionOptions: { cwd?, agentDir?, authStorage?, modelRegistry?, model?, thinkingLevel?,
//     noTools?: "all"|"builtin", tools?: string[], excludeTools?: string[], customTools?, resourceLoader?,
//     sessionManager?, settingsManager?, sessionStartEvent? }
class AuthStorage { static create(authPath?: string): AuthStorage }
class ModelRegistry {
  static create(authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry
  getAll(): Model[]; getAvailable(): Model[]; find(provider: string, modelId: string): Model | undefined
}
class SessionManager { static inMemory(cwd?: string): SessionManager; static create(cwd, sessionDir?, opts?) }
class DefaultResourceLoader implements ResourceLoader {
  constructor(options: { cwd: string; agentDir: string; settingsManager?: SettingsManager;
    noExtensions?: boolean; noSkills?: boolean; noPromptTemplates?: boolean; noThemes?: boolean;
    noContextFiles?: boolean; systemPrompt?: string; appendSystemPrompt?: string[]; ... })
  reload(): Promise<void>
}
class SettingsManager { static create(cwd?, agentDir?): SettingsManager }
function getAgentDir(): string            // ~/.pi/agent
const CONFIG_DIR_NAME: string             // ".pi"
function parseFrontmatter<T>(content: string): { frontmatter: T; body: string }
function getMarkdownTheme(): MarkdownTheme

// AgentSession instance
session.subscribe(listener: (e: AgentSessionEvent) => void): () => void   // returns unsubscribe
session.prompt(text: string, options?: PromptOptions): Promise<void>      // resolves when run settles (non-streaming)
session.steer(text: string): Promise<void>
session.followUp(text: string): Promise<void>
session.getContextUsage(): { tokens: number|null; contextWindow: number; percent: number|null } | undefined
session.getLastAssistantText(): string | undefined
session.getSessionStats(): SessionStats   // { tokens:{input,output,cacheRead,cacheWrite,total}, cost, ... }
session.dispose(): void
session.isStreaming: boolean
session.messages: AgentMessage[]
```

```ts
// AgentSessionEvent / AgentEvent union members used to drive visuals:
| { type: "agent_start" }
| { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
| { type: "turn_start" }
| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
| { type: "message_start"|"message_update"|"message_end"; message: AgentMessage }
| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
| { type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
| { type: "tool_execution_end"; toolCallId; toolName; result: any; isError: boolean }
// AgentMessage (assistant): { role, content: Array<{type:"text",text} | {type:"toolCall",name,arguments}>,
//   usage?: { input, output, cacheRead, cacheWrite, cost?: {total}, totalTokens }, model?, stopReason?, errorMessage? }
```

```ts
// ExtensionAPI
pi.registerTool({ name, label, description, promptSnippet?, promptGuidelines?, parameters /*TypeBox*/,
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>, renderCall?, renderResult? })
pi.registerCommand(name, { description?, handler: (args, ctx: ExtensionCommandContext) => Promise<void> })
pi.on("session_start", (event, ctx) => void)

// ExtensionContext / ctx.ui (ExtensionUIContext)
ctx.hasUI: boolean; ctx.mode: "tui"|"rpc"|"json"|"print"; ctx.cwd: string
ctx.modelRegistry: ModelRegistry; ctx.getContextUsage()
ctx.ui.notify(message: string, type?: "info"|"warning"|"error"): void
ctx.ui.setWidget(key, (tui, theme) => Component & { dispose?() } | undefined, { placement?: "aboveEditor"|"belowEditor" })
ctx.ui.custom<T>((tui, theme, keybindings, done) => Component & { handleInput?, dispose? }, opts?): Promise<T>
ctx.ui.confirm(title, message): Promise<boolean>
ctx.ui.input(title, placeholder?): Promise<string | undefined>
ctx.ui.editor(title, prefill?): Promise<string | undefined>

// Component (pi-tui): { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void }
// pi-tui exports used: Text, Container, Spacer, Markdown, Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi
```

**Isolation mechanism (critical):** child `DefaultResourceLoader` is constructed with
`{ cwd, agentDir, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: <agentBody> }`, then `await loader.reload()`. `systemPrompt` replaces the base prompt entirely → the child sees only its own system prompt + the task. `noExtensions:true` prevents the subagent extension from recursively loading inside children. For `fork: true`, instead set `noContextFiles: false` and prepend a capped serialized parent transcript to the first prompt (see Task 8a).

---

## File Structure

- `~/.pi/agent/extensions/subagents/index.ts` — entry: wires registry+widget on `session_start`, registers the `subagent` tool, `/agents` command, per-agent `/<name>` commands, ctrl+B shortcut.
- `~/.pi/agent/extensions/subagents/agents.ts` — `AgentConfig` type, frontmatter parsing (all fields + `readonly` shorthand), discovery from user + trusted project dirs, default-inheritance helpers.
- `~/.pi/agent/extensions/subagents/engine.ts` — model resolution, child-session creation (isolated/fork), `runAgent()` returning a `RunHandle` that streams into a `RunRecord`.
- `~/.pi/agent/extensions/subagents/registry.ts` — `RunRegistry`: live list of running/recent `RunRecord`s, nickname assignment, change listeners (drives widget + notifications).
- `~/.pi/agent/extensions/subagents/nicknames.ts` — deterministic distinct-nickname assignment from `nickname_candidates`.
- `~/.pi/agent/extensions/subagents/tool.ts` — the `subagent` tool (single/parallel/chain, depth cap, concurrency, summaries-only return, render).
- `~/.pi/agent/extensions/subagents/widget.ts` — the `aboveEditor` live widget component.
- `~/.pi/agent/extensions/subagents/roster.ts` — `/agents` overlay: browse, dispatch single, compose+launch chain, create.
- `~/.pi/agent/extensions/subagents/scaffold.ts` — generate a well-formed agent `.md` from a plain-English description (uses a child planner session).
- `~/.pi/agent/extensions/subagents/colors.ts` — named color → truecolor ANSI + spinner frames (house raw-ANSI style).
- `~/.pi/agent/agents/{scout,planner,reviewer,worker}.md` — 4 default agents.
- Test scripts (throwaway, run with `node --experimental-strip-types` or `bun`): `~/.pi/agent/extensions/subagents/_test_*.ts`.

> **Testing note:** `~/.pi/agent` is not a git repo and has no test runner. Pure functions (frontmatter→config, `readonly` expansion, default inheritance, `{previous}` substitution, depth gating, nickname assignment, color mapping) are unit-tested with tiny standalone scripts run via `bun` (preferred — pi ships a bun runtime) or `node --experimental-strip-types`. Integration/UI behavior is verified manually with `pi -e ~/.pi/agent/extensions/subagents/index.ts` and `/reload`, per the spec's verify checklist (Task 11). Delete `_test_*.ts` scripts after each task's verification (do not ship them).

---

### Task 1: Agent discovery & config (`agents.ts`, `colors.ts`)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/agents.ts`
- Create: `~/.pi/agent/extensions/subagents/colors.ts`
- Test: `~/.pi/agent/extensions/subagents/_test_agents.ts`

**Interfaces:**
- Produces: `interface AgentConfig { name; description; model?; thinking?; tools?: string[]; readonly: boolean; color: string; nicknameCandidates: string[]; background: boolean; fork: boolean; spawn: string[]; systemPrompt: string; source: "user"|"project"; filePath: string }`
- Produces: `discoverAgents(cwd: string, opts: { includeProject: boolean }): { agents: AgentConfig[]; projectAgentsDir: string | null }`
- Produces: `READONLY_TOOLS: string[]` = `["read","grep","find","ls"]`; `resolveChildToolNames(agent: AgentConfig): { tools?: string[]; noTools?: "all"|"builtin" }`
- Produces (colors.ts): `colorize(color: string, text: string): string`, `colorDot(color: string): string`, `SPINNER_FRAMES: string[]`, `COLOR_HEX: Record<string,[number,number,number]>`

- [ ] **Step 1: Write `colors.ts`**

```ts
// Raw-ANSI truecolor helpers (house style; survives pi updates — no theme dependency).
export const COLOR_HEX: Record<string, [number, number, number]> = {
	red: [235, 107, 111], orange: [232, 154, 75], yellow: [229, 192, 88],
	green: [126, 200, 121], cyan: [95, 199, 196], blue: [95, 135, 255],
	purple: [186, 134, 232], magenta: [209, 131, 232], pink: [232, 131, 180],
	gray: [150, 150, 160], white: [220, 220, 225],
};

function rgb([r, g, b]: [number, number, number], s: string): string {
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function colorize(color: string, text: string): string {
	const hex = COLOR_HEX[color] ?? COLOR_HEX.gray;
	return rgb(hex, text);
}

export function colorDot(color: string): string {
	return colorize(color, "●");
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const BOLD = "\x1b[1m";
export const UNBOLD = "\x1b[22m";
```

- [ ] **Step 2: Write `agents.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const READONLY_TOOLS = ["read", "grep", "find", "ls"];

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	readonly: boolean;
	color: string;
	nicknameCandidates: string[];
	background: boolean;
	fork: boolean;
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
	thinking?: string;
	tools?: string;
	readonly?: boolean | string;
	color?: string;
	nickname_candidates?: string[] | string;
	background?: boolean | string;
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
		return v.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}

const FALLBACK_COLORS = ["cyan", "purple", "green", "orange", "blue", "pink", "yellow", "magenta"];

export function parseAgentFile(content: string, filePath: string, source: "user" | "project"): AgentConfig | null {
	const { frontmatter, body } = parseFrontmatter<RawFrontmatter>(content);
	if (!frontmatter.name || !frontmatter.description) return null;

	const tools = asList(frontmatter.tools);
	const nameHash = [...frontmatter.name].reduce((a, c) => a + c.charCodeAt(0), 0);

	return {
		name: frontmatter.name.trim(),
		description: frontmatter.description.trim(),
		model: frontmatter.model?.trim() || undefined,
		thinking: frontmatter.thinking?.trim() || undefined,
		tools: tools.length > 0 ? tools : undefined,
		readonly: asBool(frontmatter.readonly),
		color: frontmatter.color?.trim() || FALLBACK_COLORS[nameHash % FALLBACK_COLORS.length],
		nicknameCandidates: asList(frontmatter.nickname_candidates),
		background: asBool(frontmatter.background),
		fork: asBool(frontmatter.fork),
		spawn: asList(frontmatter.spawn),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

/** Build the tool config for a child session from an agent's allowlist / readonly shorthand. */
export function resolveChildToolNames(agent: AgentConfig): { tools?: string[]; noTools?: "all" | "builtin" } {
	if (agent.readonly) return { tools: agent.tools && agent.tools.length > 0 ? agent.tools.filter((t) => READONLY_TOOLS.includes(t)) : READONLY_TOOLS };
	if (agent.tools && agent.tools.length > 0) return { tools: agent.tools };
	return {}; // inherit pi defaults (read, bash, edit, write)
}

function loadDir(dir: string, source: "user" | "project"): AgentConfig[] {
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
			const cfg = parseAgentFile(fs.readFileSync(fp, "utf-8"), fp, source);
			if (cfg) out.push(cfg);
		} catch {
			/* skip unreadable */
		}
	}
	return out;
}

function findProjectAgentsDir(cwd: string): string | null {
	let cur = cwd;
	while (true) {
		const candidate = path.join(cur, CONFIG_DIR_NAME, "agents");
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
	const projectAgentsDir = findProjectAgentsDir(cwd);
	const map = new Map<string, AgentConfig>();
	for (const a of loadDir(userDir, "user")) map.set(a.name, a);
	if (opts.includeProject && projectAgentsDir)
		for (const a of loadDir(projectAgentsDir, "project")) map.set(a.name, a);
	return { agents: [...map.values()], projectAgentsDir };
}
```

- [ ] **Step 3: Write the test script**

```ts
// _test_agents.ts
import { parseAgentFile, resolveChildToolNames, READONLY_TOOLS } from "./agents.ts";

const md = `---
name: scout
description: Fast recon. Use proactively for codebase questions.
model: deepseek-v4-flash
readonly: true
color: cyan
nickname_candidates: [Scout, Recon, Probe]
spawn: []
---
You are a fast scout. Return compressed findings.`;

const a = parseAgentFile(md, "/x/scout.md", "user");
if (!a) throw new Error("parse failed");
console.assert(a.name === "scout", "name");
console.assert(a.readonly === true, "readonly bool");
console.assert(a.color === "cyan", "color");
console.assert(a.nicknameCandidates.length === 3, "nicknames");
console.assert(a.model === "deepseek-v4-flash", "model");
const tools = resolveChildToolNames(a);
console.assert(JSON.stringify(tools.tools) === JSON.stringify(READONLY_TOOLS), "readonly→tools");

const md2 = `---
name: worker
description: Full tools.
spawn: scout
---
Body`;
const w = parseAgentFile(md2, "/x/worker.md", "user")!;
console.assert(w.readonly === false, "default readonly false");
console.assert(JSON.stringify(w.spawn) === JSON.stringify(["scout"]), "spawn csv→list");
console.assert(JSON.stringify(resolveChildToolNames(w)) === "{}", "no allowlist → inherit");
console.log("OK agents");
```

- [ ] **Step 4: Run the test**

Run: `cd ~/.pi/agent/extensions/subagents && bun _test_agents.ts`
Expected: prints `OK agents`, no assertion output. (If `bun` unavailable, use `node --experimental-strip-types _test_agents.ts`.)

- [ ] **Step 5: Clean up test, commit-equivalent**

Run: `rm ~/.pi/agent/extensions/subagents/_test_agents.ts`
(No git in this dir. If the user later versions `~/.pi/agent` via the `dotfiles` bare repo, that is a separate step.)

---

### Task 2: Default agents + nicknames (`nicknames.ts`, 4 `.md` files)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/nicknames.ts`
- Create: `~/.pi/agent/agents/scout.md`, `planner.md`, `reviewer.md`, `worker.md`
- Test: `~/.pi/agent/extensions/subagents/_test_nicknames.ts`

**Interfaces:**
- Produces: `assignNickname(candidates: string[], taken: Set<string>, agentName: string, ordinal: number): string` — returns a distinct nickname, falling back to `Name #n` when candidates exhausted.

- [ ] **Step 1: Write `nicknames.ts`**

```ts
/** Pick the first candidate not already taken; else synthesize a distinct label. */
export function assignNickname(candidates: string[], taken: Set<string>, agentName: string, ordinal: number): string {
	for (const c of candidates) {
		if (c && !taken.has(c)) {
			taken.add(c);
			return c;
		}
	}
	const base = agentName.charAt(0).toUpperCase() + agentName.slice(1);
	let n = ordinal;
	let label = `${base} #${n}`;
	while (taken.has(label)) {
		n += 1;
		label = `${base} #${n}`;
	}
	taken.add(label);
	return label;
}
```

- [ ] **Step 2: Write `scout.md`** (read-only, flash, fast recon)

```markdown
---
name: scout
description: Use PROACTIVELY for fast read-only codebase recon. Always use for "where/how is X implemented", locating files, tracing a symbol, or summarizing an area before you act. Returns compressed findings, not edits.
model: deepseek-v4-flash
thinking: low
readonly: true
color: cyan
nickname_candidates: [Scout, Recon, Probe, Ranger, Pathfinder, Tracker]
spawn: []
---

You are Scout, a fast read-only reconnaissance agent. Your job is to answer a focused question about a codebase or filesystem as quickly as possible.

Rules:
- Use only read, grep, find, ls. Never modify anything.
- Be aggressive and parallel in searching; stop as soon as you can answer.
- Return a COMPRESSED result: exact file paths with line numbers, the key snippets, and a 2-4 sentence synthesis. No preamble, no restating the task.
- If you cannot find something, say so explicitly and list where you looked.
```

- [ ] **Step 3: Write `planner.md`** (pro, read-only)

```markdown
---
name: planner
description: Use PROACTIVELY to turn a goal or spec into a concrete step-by-step implementation plan before coding. Always use for "how should we build X", design trade-offs, or sequencing multi-file changes. Read-only — produces a plan, not edits.
model: deepseek-v4-pro
thinking: high
readonly: true
color: purple
nickname_candidates: [Planner, Architect, Drafter, Strategist, Blueprint]
spawn: []
---

You are Planner, a senior engineer who produces precise implementation plans.

Rules:
- Investigate with read-only tools first; ground every step in real files.
- Output an ordered list of bite-sized steps. For each: which file(s) to touch, what changes, and how to verify.
- Call out risks, edge cases, and decisions that need a human. Be specific — exact paths and function names.
- Do NOT write code changes; you only plan.
```

- [ ] **Step 4: Write `reviewer.md`** (pro, read-only, proactive after changes)

```markdown
---
name: reviewer
description: Use PROACTIVELY immediately after writing or modifying code. Always use for reviewing a diff for correctness bugs, security issues, and simplifications before committing. Read-only — reports findings, does not edit.
model: deepseek-v4-pro
thinking: high
readonly: true
color: orange
nickname_candidates: [Reviewer, Critic, Auditor, Inspector, Sentinel, Warden]
spawn: []
---

You are Reviewer, a meticulous code reviewer. Review the changes described in the task.

Rules:
- Use read-only tools to inspect the relevant code and its context.
- Report findings as a prioritized list: correctness bugs first, then security, then simplification/efficiency. Cite file:line.
- For each finding: what's wrong, why it matters, and a concrete fix. Distinguish blocking issues from nits.
- If the change looks correct, say so plainly and note what you verified. Do not invent problems.
```

- [ ] **Step 5: Write `worker.md`** (full tools, may spawn scout)

```markdown
---
name: worker
description: Use to actually implement a self-contained change end to end — edit files, run commands, make a fix work. Delegate concrete build/fix tasks here. Can spawn a scout for recon.
model: deepseek-v4-pro
thinking: high
color: green
nickname_candidates: [Worker, Builder, Maker, Smith, Forge, Mason]
spawn: [scout]
---

You are Worker, a capable engineer who completes a delegated task end to end.

Rules:
- Implement the task with the tools available (read, bash, edit, write). Verify your work (run/build/test where possible).
- If you need recon first, delegate to scout rather than reading broadly yourself.
- Return a concise summary of what you changed (files + one-line rationale each) and how you verified it.
- Keep the change scoped to the task. Do not refactor unrelated code.
```

- [ ] **Step 6: Write & run the nickname test**

```ts
// _test_nicknames.ts
import { assignNickname } from "./nicknames.ts";
const taken = new Set<string>();
const a = assignNickname(["Reviewer", "Critic"], taken, "reviewer", 1);
const b = assignNickname(["Reviewer", "Critic"], taken, "reviewer", 2);
const c = assignNickname(["Reviewer", "Critic"], taken, "reviewer", 3);
console.assert(a === "Reviewer" && b === "Critic", "distinct from candidates");
console.assert(c === "Reviewer #3", `fallback got ${c}`);
console.log("OK nicknames");
```

Run: `cd ~/.pi/agent/extensions/subagents && bun _test_nicknames.ts` → `OK nicknames`. Then `rm _test_nicknames.ts`.

---

### Task 3: Engine — model resolution & child sessions (`engine.ts`)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/engine.ts`
- Test (manual integration): via Task 5 `pi -e`.

**Interfaces:**
- Consumes: `AgentConfig`, `resolveChildToolNames` (Task 1).
- Produces:
  - `resolveModel(registry: ModelRegistry, pattern: string | undefined): Model<any> | undefined` — matches `provider/id`, bare `id`, or substring against `registry.getAll()`; `undefined` → inherit (caller passes parent model).
  - `interface RunEvent` (discriminated): `{type:"status"; status:RunStatus}`, `{type:"tool"; name:string; argsPreview:string}`, `{type:"text"; text:string}`, `{type:"usage"; usage:RunUsage; contextPercent:number|null}`.
  - `type RunStatus = "pending"|"running"|"done"|"error"|"aborted"`.
  - `interface RunUsage { input:number; output:number; cacheRead:number; cacheWrite:number; cost:number; turns:number; toolCalls:number; contextTokens:number }`.
  - `interface RunHandle { promise: Promise<RunResult>; steer(msg:string):Promise<void>; abort():void }`.
  - `interface RunResult { ok:boolean; finalText:string; usage:RunUsage; contextPercent:number|null; error?:string }`.
  - `async function runAgent(args: { agent:AgentConfig; task:string; parentModel:Model<any>|undefined; registry:ModelRegistry; cwd:string; fork:boolean; parentTranscript?:string; signal?:AbortSignal; onEvent:(e:RunEvent)=>void }): Promise<RunHandle>`.

- [ ] **Step 1: Write `engine.ts`**

```ts
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { resolveChildToolNames } from "./agents.ts";

export type RunStatus = "pending" | "running" | "done" | "error" | "aborted";

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	contextTokens: number;
}

export type RunEvent =
	| { type: "status"; status: RunStatus }
	| { type: "tool"; name: string; argsPreview: string }
	| { type: "text"; text: string }
	| { type: "usage"; usage: RunUsage; contextPercent: number | null };

export interface RunResult {
	ok: boolean;
	finalText: string;
	usage: RunUsage;
	contextPercent: number | null;
	error?: string;
}

export interface RunHandle {
	promise: Promise<RunResult>;
	steer(msg: string): Promise<void>;
	abort(): void;
}

function emptyUsage(): RunUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, contextTokens: 0 };
}

/** Match a model pattern against the registry. Supports "provider/id", bare "id", or substring. */
export function resolveModel(registry: ModelRegistry, pattern: string | undefined): Model<any> | undefined {
	if (!pattern) return undefined;
	const all = registry.getAll();
	if (pattern.includes("/")) {
		const [p, id] = pattern.split("/", 2);
		const exact = registry.find(p, id);
		if (exact) return exact;
	}
	const byId = all.find((m: any) => m.id === pattern);
	if (byId) return byId;
	const sub = all.find((m: any) => `${m.provider}/${m.id}`.includes(pattern) || m.id.includes(pattern));
	return sub;
}

function argsPreview(name: string, args: any): string {
	try {
		if (name === "bash") return `$ ${String(args?.command ?? "").slice(0, 60)}`;
		if (name === "read" || name === "edit" || name === "write") return `${name} ${args?.file_path ?? args?.path ?? ""}`;
		if (name === "grep") return `grep /${args?.pattern ?? ""}/`;
		if (name === "find") return `find ${args?.pattern ?? ""}`;
		const s = JSON.stringify(args ?? {});
		return `${name} ${s.length > 50 ? `${s.slice(0, 50)}…` : s}`;
	} catch {
		return name;
	}
}

export async function runAgent(args: {
	agent: AgentConfig;
	task: string;
	parentModel: Model<any> | undefined;
	registry: ModelRegistry;
	cwd: string;
	fork: boolean;
	parentTranscript?: string;
	signal?: AbortSignal;
	onEvent: (e: RunEvent) => void;
}): Promise<RunHandle> {
	const { agent, registry, cwd, onEvent } = args;
	const model = resolveModel(registry, agent.model) ?? args.parentModel;

	// Lean, isolated resource loader. systemPrompt = agent body → child sees only its prompt + task.
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		settingsManager: SettingsManager.create(cwd, getAgentDir()),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: !args.fork, // fork inherits project context files
		systemPrompt: agent.systemPrompt || undefined,
	});
	await loader.reload();

	const toolCfg = resolveChildToolNames(agent);
	const authStorage = AuthStorage.create();
	const { session } = await createAgentSession({
		cwd,
		model,
		thinkingLevel: agent.thinking as any,
		tools: toolCfg.tools,
		noTools: toolCfg.noTools,
		resourceLoader: loader,
		modelRegistry: registry,
		authStorage,
		sessionManager: SessionManager.inMemory(cwd),
	});

	const usage = emptyUsage();
	const recomputeContext = (): number | null => {
		const cu = session.getContextUsage();
		if (cu?.tokens != null) usage.contextTokens = cu.tokens;
		return cu?.percent ?? null;
	};

	const unsubscribe = session.subscribe((e) => {
		switch (e.type) {
			case "agent_start":
				onEvent({ type: "status", status: "running" });
				break;
			case "tool_execution_start":
				usage.toolCalls += 1;
				onEvent({ type: "tool", name: e.toolName, argsPreview: argsPreview(e.toolName, e.args) });
				break;
			case "message_end": {
				const msg: any = e.message;
				if (msg?.role === "assistant") {
					usage.turns += 1;
					const u = msg.usage;
					if (u) {
						usage.input += u.input || 0;
						usage.output += u.output || 0;
						usage.cacheRead += u.cacheRead || 0;
						usage.cacheWrite += u.cacheWrite || 0;
						usage.cost += u.cost?.total || 0;
						if (u.totalTokens) usage.contextTokens = u.totalTokens;
					}
					for (const part of msg.content ?? []) {
						if (part.type === "text" && part.text?.trim()) onEvent({ type: "text", text: part.text });
					}
				}
				onEvent({ type: "usage", usage: { ...usage }, contextPercent: recomputeContext() });
				break;
			}
		}
	});

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		void session.abort();
	};
	if (args.signal) {
		if (args.signal.aborted) onAbort();
		else args.signal.addEventListener("abort", onAbort, { once: true });
	}

	const firstMessage = args.fork && args.parentTranscript
		? `# Parent conversation (context)\n${args.parentTranscript}\n\n# Task\n${args.task}`
		: `Task: ${args.task}`;

	const promise: Promise<RunResult> = (async () => {
		try {
			onEvent({ type: "status", status: "running" });
			await session.prompt(firstMessage);
			const finalText = session.getLastAssistantText() ?? "";
			const contextPercent = recomputeContext();
			const ok = !aborted && !!finalText.trim();
			onEvent({ type: "status", status: aborted ? "aborted" : ok ? "done" : "error" });
			return { ok, finalText: finalText || "(no output)", usage: { ...usage }, contextPercent, error: aborted ? "aborted" : undefined };
		} catch (err) {
			onEvent({ type: "status", status: aborted ? "aborted" : "error" });
			return { ok: false, finalText: "", usage: { ...usage }, contextPercent: recomputeContext(), error: err instanceof Error ? err.message : String(err) };
		} finally {
			unsubscribe();
			args.signal?.removeEventListener("abort", onAbort);
			session.dispose();
		}
	})();

	return {
		promise,
		steer: (msg: string) => session.steer(msg),
		abort: onAbort,
	};
}
```

- [ ] **Step 2: Type-check the module in isolation**

Run: `cd ~/.pi/agent/extensions/subagents && bun build engine.ts --target=node --outfile=/dev/null` (or `node --experimental-strip-types -e "import('./engine.ts')"`).
Expected: no module-resolution / syntax errors. (Bundled pi types resolve at pi load time; a bare type-check may warn on `@earendil-works/*` resolution — acceptable. The real check is `pi -e` in Task 5.)

> **VERIFICATION CHECKPOINT (do before relying on the engine):** isolation hinges on `DefaultResourceLoader({ systemPrompt })` replacing the base prompt and `noContextFiles` excluding `AGENTS.md`. Confirm in Task 5 Step 4 with the "child can't see prior conversation" probe. If `systemPrompt` does not fully replace the base prompt in this build, fall back to `appendSystemPrompt: [agent.systemPrompt]` plus a leading instruction line; re-verify isolation.

---

### Task 4: Run registry (`registry.ts`)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/registry.ts`

**Interfaces:**
- Consumes: `RunStatus`, `RunUsage`, `RunEvent` (Task 3); `assignNickname` (Task 2); `AgentConfig`.
- Produces:
  - `interface RunRecord { id:number; agentName:string; color:string; nickname:string; task:string; status:RunStatus; lastTool?:string; lastText?:string; usage:RunUsage; contextPercent:number|null; startedAt:number; endedAt?:number; background:boolean; mode:"single"|"parallel"|"chain"; chainStep?:number; handle?:RunHandle }`.
  - `class RunRegistry` with: `create(opts): RunRecord`, `applyEvent(rec, e: RunEvent)`, `finish(rec, result)`, `setBackground(rec, bg)`, `recent(limit): RunRecord[]`, `hasActive(): boolean`, `onChange(cb): () => void`, internal `notify()`.

- [ ] **Step 1: Write `registry.ts`**

```ts
import type { AgentConfig } from "./agents.ts";
import { assignNickname } from "./nicknames.ts";
import type { RunEvent, RunHandle, RunResult, RunStatus, RunUsage } from "./engine.ts";

export interface RunRecord {
	id: number;
	agentName: string;
	color: string;
	nickname: string;
	task: string;
	status: RunStatus;
	lastTool?: string;
	lastText?: string;
	usage: RunUsage;
	contextPercent: number | null;
	startedAt: number;
	endedAt?: number;
	background: boolean;
	mode: "single" | "parallel" | "chain";
	chainStep?: number;
	handle?: RunHandle;
}

export class RunRegistry {
	private records: RunRecord[] = [];
	private takenNicknames = new Set<string>();
	private listeners = new Set<() => void>();
	private nextId = 1;
	private ordinal = 0;

	create(opts: {
		agent: AgentConfig;
		task: string;
		background: boolean;
		mode: "single" | "parallel" | "chain";
		chainStep?: number;
	}): RunRecord {
		this.ordinal += 1;
		const rec: RunRecord = {
			id: this.nextId++,
			agentName: opts.agent.name,
			color: opts.agent.color,
			nickname: assignNickname(opts.agent.nicknameCandidates, this.takenNicknames, opts.agent.name, this.ordinal),
			task: opts.task,
			status: "pending",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, contextTokens: 0 },
			contextPercent: null,
			startedAt: Date.now(),
			background: opts.background,
			mode: opts.mode,
			chainStep: opts.chainStep,
		};
		this.records.push(rec);
		this.notify();
		return rec;
	}

	applyEvent(rec: RunRecord, e: RunEvent): void {
		switch (e.type) {
			case "status": rec.status = e.status; break;
			case "tool": rec.lastTool = e.argsPreview; break;
			case "text": rec.lastText = e.text.split("\n").find((l) => l.trim()) ?? rec.lastText; break;
			case "usage": rec.usage = e.usage; rec.contextPercent = e.contextPercent; break;
		}
		this.notify();
	}

	finish(rec: RunRecord, result: RunResult): void {
		rec.status = result.ok ? "done" : rec.status === "aborted" ? "aborted" : "error";
		rec.usage = result.usage;
		rec.contextPercent = result.contextPercent;
		rec.endedAt = Date.now();
		rec.handle = undefined;
		this.notify();
	}

	setBackground(rec: RunRecord, bg: boolean): void {
		rec.background = bg;
		this.notify();
	}

	recent(limit: number): RunRecord[] {
		const active = this.records.filter((r) => r.status === "running" || r.status === "pending");
		const finished = this.records.filter((r) => r.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
		return [...active, ...finished].slice(0, limit);
	}

	hasActive(): boolean {
		return this.records.some((r) => r.status === "running" || r.status === "pending");
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private notify(): void {
		for (const cb of this.listeners) cb();
	}
}
```

---

### Task 5: The `subagent` tool (`tool.ts`) + wire into `index.ts`

**Files:**
- Create: `~/.pi/agent/extensions/subagents/tool.ts`
- Create: `~/.pi/agent/extensions/subagents/index.ts` (minimal wiring; expanded in later tasks)
- Test: `pi -e ~/.pi/agent/extensions/subagents/index.ts`

**Interfaces:**
- Consumes: `discoverAgents`, `AgentConfig` (Task 1); `runAgent`, `RunResult` (Task 3); `RunRegistry`, `RunRecord` (Task 4).
- Produces: `registerSubagentTool(pi, ctxRef: { registry: RunRegistry; depth: number })`. Depth is 0 in the main session; children would run at depth 1 (children don't load this extension, so depth is effectively a guard for the spawn-allowlist path documented in Step 1).
- Produces helper `substitutePrevious(task: string, previous: string): string` = `task.replace(/\{previous\}/g, previous)`.
- Produces helper `mapWithConcurrency<I,O>(items, limit, fn): Promise<O[]>` (port from reference index.ts lines 219-237).

- [ ] **Step 1: Write `tool.ts`**

```ts
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { type RunResult, runAgent } from "./engine.ts";
import type { RunRecord, RunRegistry } from "./registry.ts";
import { colorDot } from "./colors.ts";

export const MAX_PARALLEL = 6;
export const MAX_CONCURRENCY = 6;
const PER_TASK_CAP = 16 * 1024;

export function substitutePrevious(task: string, previous: string): string {
	return task.replace(/\{previous\}/g, previous);
}

async function mapWithConcurrency<I, O>(items: I[], limit: number, fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
	if (items.length === 0) return [];
	const n = Math.max(1, Math.min(limit, items.length));
	const out: O[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		new Array(n).fill(0).map(async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

function cap(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_TASK_CAP) return text;
	let t = text.slice(0, PER_TASK_CAP);
	while (Buffer.byteLength(t, "utf8") > PER_TASK_CAP) t = t.slice(0, -1);
	return `${t}\n[truncated]`;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name to invoke" }),
	task: Type.String({ description: "Task for the agent" }),
});
const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent name to invoke" }),
	task: Type.String({ description: "Task; may include {previous} to substitute the prior step's final output" }),
});
const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single mode: the task" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: agents run concurrently" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode: sequential; {previous} substitutes prior output" })),
	background: Type.Optional(Type.Boolean({ description: "Run without blocking; notify on completion" })),
});

interface ToolDetails {
	mode: "single" | "parallel" | "chain";
	rows: Array<{ nickname: string; color: string; agent: string; status: string; preview: string }>;
}

export function registerSubagentTool(pi: ExtensionAPI, env: { registry: RunRegistry; depth: number }): void {
	pi.registerTool<typeof Params, ToolDetails>({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to specialized subagents that run with their own isolated context and return only a summary.",
			"Three modes: single { agent, task }; parallel { tasks: [{agent,task}…] } (concurrent); chain { chain: [{agent,task}…] } (sequential, use {previous} to pass the prior step's output forward).",
			"Prefer this over doing large recon/review yourself: delegate read-only investigation to scout, planning to planner, post-change review to reviewer, and self-contained implementation to worker.",
			"Set background:true for long tasks you don't want to block on.",
		].join(" "),
		promptSnippet: "Delegate recon/planning/review/implementation to subagents (single, parallel, or chain) with isolated context.",
		promptGuidelines: [
			"Use subagent('scout', …) proactively for codebase questions instead of reading many files yourself.",
			"After making code changes, use subagent('reviewer', …) to review the diff.",
			"For multi-stage work, use chain mode and reference {previous} to hand a step's output to the next.",
			"Use parallel mode (tasks array) when independent investigations can run at once.",
			"Subagents return only their final summary; their intermediate tool output is intentionally hidden.",
		],
		parameters: Params,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
			const byName = (n: string) => agents.find((a) => a.name === n);
			const background = params.background ?? false;

			const modes = [Boolean(params.agent && params.task), (params.tasks?.length ?? 0) > 0, (params.chain?.length ?? 0) > 0].filter(Boolean).length;
			if (modes !== 1) {
				const list = agents.map((a) => a.name).join(", ") || "none";
				return { content: [{ type: "text", text: `Provide exactly one of {agent,task} | {tasks} | {chain}. Available agents: ${list}` }], details: { mode: "single", rows: [] } };
			}

			const runOne = async (agent: AgentConfig, task: string, mode: "single" | "parallel" | "chain", chainStep?: number): Promise<RunResult & { nickname: string; color: string; agentName: string }> => {
				const rec: RunRecord = env.registry.create({ agent, task, background, mode, chainStep });
				const handle = await runAgent({
					agent, task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd,
					fork: agent.fork, signal,
					onEvent: (e) => env.registry.applyEvent(rec, e),
				});
				rec.handle = handle;
				const result = await handle.promise;
				env.registry.finish(rec, result);
				return { ...result, nickname: rec.nickname, color: rec.color, agentName: agent.name };
			};

			// SINGLE
			if (params.agent && params.task) {
				const agent = byName(params.agent);
				if (!agent) return { content: [{ type: "text", text: `Unknown agent "${params.agent}". Available: ${agents.map((a) => a.name).join(", ")}` }], details: { mode: "single", rows: [] }, isError: true };
				const r = await runOne(agent, params.task, "single");
				return {
					content: [{ type: "text", text: r.ok ? cap(r.finalText) : `Agent failed: ${r.error ?? r.finalText}` }],
					details: { mode: "single", rows: [{ nickname: r.nickname, color: r.color, agent: r.agentName, status: r.ok ? "done" : "error", preview: r.finalText.slice(0, 80) }] },
					isError: !r.ok,
				};
			}

			// PARALLEL
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL) return { content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}); max ${MAX_PARALLEL}.` }], details: { mode: "parallel", rows: [] }, isError: true };
				const unknown = params.tasks.find((t) => !byName(t.agent));
				if (unknown) return { content: [{ type: "text", text: `Unknown agent "${unknown.agent}".` }], details: { mode: "parallel", rows: [] }, isError: true };
				const results = await mapWithConcurrency(params.tasks, MAX_CONCURRENCY, (t) => runOne(byName(t.agent)!, t.task, "parallel"));
				const ok = results.filter((r) => r.ok).length;
				const text = results.map((r) => `### [${r.nickname} · ${r.agentName}] ${r.ok ? "ok" : "failed"}\n\n${cap(r.finalText)}`).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${text}` }],
					details: { mode: "parallel", rows: results.map((r) => ({ nickname: r.nickname, color: r.color, agent: r.agentName, status: r.ok ? "done" : "error", preview: r.finalText.slice(0, 80) })) },
				};
			}

			// CHAIN
			if (params.chain && params.chain.length > 0) {
				const unknown = params.chain.find((s) => !byName(s.agent));
				if (unknown) return { content: [{ type: "text", text: `Unknown agent "${unknown.agent}".` }], details: { mode: "chain", rows: [] }, isError: true };
				const rows: ToolDetails["rows"] = [];
				let previous = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const r = await runOne(byName(step.agent)!, substitutePrevious(step.task, previous), "chain", i + 1);
					rows.push({ nickname: r.nickname, color: r.color, agent: r.agentName, status: r.ok ? "done" : "error", preview: r.finalText.slice(0, 80) });
					if (!r.ok) return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${r.error ?? r.finalText}` }], details: { mode: "chain", rows }, isError: true };
					previous = r.finalText;
				}
				return { content: [{ type: "text", text: cap(previous || "(no output)") }], details: { mode: "chain", rows } };
			}

			return { content: [{ type: "text", text: "No mode selected." }], details: { mode: "single", rows: [] }, isError: true };
		},

		renderCall(args, theme) {
			if (args.chain) return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length})`), 0, 0);
			if (args.tasks) return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`), 0, 0);
			return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent ?? "?") + theme.fg("dim", ` ${(args.task ?? "").slice(0, 60)}`), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const d = result.details as ToolDetails | undefined;
			const c = new Container();
			if (d?.rows?.length) {
				for (const row of d.rows) {
					const icon = row.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
					c.addChild(new Text(`${icon} ${colorDot(row.color)} ${theme.fg("accent", row.nickname)} ${theme.fg("muted", `(${row.agent})`)} ${theme.fg("dim", row.preview)}`, 0, 0));
				}
				c.addChild(new Spacer(1));
			}
			const t = result.content[0];
			c.addChild(new Text(t?.type === "text" ? t.text : "(no output)", 0, 0));
			return c;
		},
	});
}
```

- [ ] **Step 2: Write minimal `index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunRegistry } from "./registry.ts";
import { registerSubagentTool } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const registry = new RunRegistry();
	registerSubagentTool(pi, { registry, depth: 0 });
	// Widget, /agents, /<name> commands, ctrl+B added in later tasks.
}
```

- [ ] **Step 3: Load the extension**

Run: `pi -e ~/.pi/agent/extensions/subagents/index.ts`
Expected: pi starts with no load errors. In the session, type: `Use the scout subagent to find where models are configured in ~/.pi/agent`.
Expected: the LLM calls `subagent` with `{agent:"scout", task:…}`; a child deepseek-v4-flash session runs and returns a compressed summary citing `~/.pi/agent/models.json`.

- [ ] **Step 4: Verify isolation + delegation + modes**

In the same `pi -e` session:
1. Auto-delegation: a natural request ("review the changes I just made to X") should trigger `subagent('reviewer', …)` without you naming the tool — confirm the model picks it up from the description/guidelines.
2. Isolated context probe: first tell the main agent a secret ("remember the codeword is PLATYPUS"), then ask it to `Use scout to tell me the codeword`. Expected: scout reports it does NOT know the codeword (proves the child can't see prior conversation). If scout knows it, isolation failed → apply the Task 3 fallback.
3. Parallel: "run two scouts in parallel, one for X one for Y" → both run; combined result returned.
4. Chain: "chain scout then planner, feeding scout's findings in" → planner's task contains `{previous}` substituted; final = planner output.

- [ ] **Step 5: Confirm child tool output stays off the main thread**

In the parallel/single result, confirm the parent sees only each child's final summary (not every read/grep the child ran). The inline `renderResult` shows one row per child + the summary.

---

### Task 6: Live widget (`widget.ts`)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/widget.ts`
- Modify: `~/.pi/agent/extensions/subagents/index.ts` (mount widget on `session_start`)

**Interfaces:**
- Consumes: `RunRegistry`, `RunRecord` (Task 4); `colorDot`, `SPINNER_FRAMES`, `colorize` (Task 1).
- Produces: `createSubagentsWidget(registry: RunRegistry, getCollapsed: () => boolean): (tui, theme) => Component & { dispose() }`. Returns `undefined`-able content when no runs (caller clears widget).
- Produces: `mountWidget(pi, ctx, registry, state)` helper that sets the widget on change and toggles via a shared `state.collapsed`.

- [ ] **Step 1: Write `widget.ts`**

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { colorDot, colorize, SPINNER_FRAMES } from "./colors.ts";
import type { RunRecord, RunRegistry } from "./registry.ts";

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function createSubagentsWidget(registry: RunRegistry, getCollapsed: () => boolean): (tui: any, theme: Theme) => any {
	return (tui: any, theme: Theme) => {
		let frame = 0;
		let cached: string[] | undefined;
		const off = registry.onChange(() => {
			cached = undefined;
			tui.requestRender();
		});
		// Spinner animation while anything is active.
		const timer = setInterval(() => {
			if (registry.hasActive()) {
				frame = (frame + 1) % SPINNER_FRAMES.length;
				cached = undefined;
				tui.requestRender();
			}
		}, 100);

		function rowLine(r: RunRecord, width: number): string {
			const spin = r.status === "running" || r.status === "pending" ? colorize(r.color, SPINNER_FRAMES[frame]) : r.status === "done" ? theme.fg("success", "✓") : r.status === "aborted" ? theme.fg("warning", "◼") : theme.fg("error", "✗");
			const label = colorize(r.color, r.nickname);
			const tools = theme.fg("muted", `${r.usage.toolCalls}⚒`);
			const toks = theme.fg("dim", fmtTokens(r.usage.input + r.usage.output));
			const ctxPct = r.contextPercent != null ? theme.fg("dim", `${Math.round(r.contextPercent)}%`) : "";
			const bg = r.background ? theme.fg("warning", " bg") : "";
			const task = theme.fg("dim", r.task.replace(/\s+/g, " ").slice(0, 40));
			return truncateToWidth(`${spin} ${colorDot(r.color)} ${label} ${theme.fg("muted", `(${r.agentName})`)} ${task} ${tools} ${toks} ${ctxPct}${bg}`, width);
		}

		return {
			render(width: number): string[] {
				if (cached) return cached;
				const runs = registry.recent(8);
				if (runs.length === 0) { cached = []; return cached; }
				const collapsed = getCollapsed();
				const lines: string[] = [];
				const active = runs.filter((r) => r.status === "running" || r.status === "pending").length;
				lines.push(truncateToWidth(theme.fg("accent", `▌ subagents `) + theme.fg("muted", `${active} active · ${runs.length} recent`) + theme.fg("dim", "  (ctrl+o detail · ctrl+b background)"), width));
				for (const r of runs) {
					lines.push(rowLine(r, width));
					if (!collapsed) {
						const detail = r.lastTool ?? r.lastText;
						if (detail) lines.push(truncateToWidth(`    ${theme.fg("dim", "→ " + detail.slice(0, width - 6))}`, width));
					}
				}
				cached = lines;
				return lines;
			},
			invalidate() { cached = undefined; },
			dispose() { off(); clearInterval(timer); },
		};
	};
}
```

- [ ] **Step 2: Mount it in `index.ts`** (replace the placeholder comment)

```ts
import { createSubagentsWidget } from "./widget.ts";
// inside default export, after registerSubagentTool:
const state = { collapsed: true };
pi.on("session_start", (_e, ctx) => {
	if (!ctx.hasUI) return;
	const setWidget = () => {
		const runs = registry.recent(1);
		if (runs.length === 0) { ctx.ui.setWidget("subagents", undefined, { placement: "aboveEditor" }); return; }
		ctx.ui.setWidget("subagents", createSubagentsWidget(registry, () => state.collapsed), { placement: "aboveEditor" });
	};
	registry.onChange(setWidget);
	setWidget();
});
```

> Note: `setWidget` is called on every change; pi replaces the keyed widget. The widget factory itself subscribes for live frame/render updates, so re-setting only matters for first-mount and teardown. Keep the factory stable while runs exist.

- [ ] **Step 3: Verify the widget**

Run: `pi -e ~/.pi/agent/extensions/subagents/index.ts`. Dispatch 3 parallel reviewers ("run three reviewers in parallel on files A, B, C"). Confirm:
- Three rows appear above the editor, each with a distinct nickname (Reviewer/Critic/Auditor) and the agent's color dot.
- Each row shows an animated spinner while running, then ✓/✗.
- Tool count, token count, and context% update live.
- Rows collapse by default; detail line (latest tool/prose) is hidden until expanded (ctrl+o wired in Task 7).

---

### Task 7: Background runs, notifications, ctrl+B, ctrl+O

**Files:**
- Modify: `~/.pi/agent/extensions/subagents/index.ts`
- Modify: `~/.pi/agent/extensions/subagents/tool.ts` (background path: don't block; notify on completion)

**Interfaces:**
- Consumes: `ctx.ui.notify`, `pi.registerShortcut` (ExtensionAPI), `RunRegistry`.
- Produces: `notifyCompletion(ctx, rec, result)` formatting `✓/✗ <nickname> (<agent>) · Nt turns · Tk tokens · Ns · "<preview>"`.

- [ ] **Step 1: Background path in `tool.ts`** — when `background` is true, the tool returns immediately after spawning and notifies on completion.

Replace `runOne` so that, for `background`, it does NOT await `handle.promise`; instead attaches a `.then` that calls `env.registry.finish` and `env.notify(rec, result)` (pass a notify callback into `env`). Add to `env`: `notify?: (rec: RunRecord, result: RunResult) => void`. For background single mode, return `{ content: [{type:"text", text:`Started ${rec.nickname} (${agent.name}) in background; you'll be notified on completion.`}], details:{…} }`.

```ts
// in execute(), SINGLE mode, when background:
if (background && params.agent && params.task) {
	const agent = byName(params.agent)!;
	const rec = env.registry.create({ agent, task: params.task, background: true, mode: "single" });
	const handle = await runAgent({ agent, task: params.task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: agent.fork, onEvent: (e) => env.registry.applyEvent(rec, e) });
	rec.handle = handle;
	void handle.promise.then((result) => { env.registry.finish(rec, result); env.notify?.(rec, result); });
	return { content: [{ type: "text", text: `Started ${rec.nickname} (${agent.name}) in background. You'll get a notification when it finishes.` }], details: { mode: "single", rows: [{ nickname: rec.nickname, color: rec.color, agent: agent.name, status: "running", preview: "(running in background)" }] } };
}
```

- [ ] **Step 2: Provide `notify` from `index.ts`** when registering the tool

```ts
const fmtDur = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
let notifyCtx: any;
pi.on("session_start", (_e, ctx) => { notifyCtx = ctx; /* …existing widget mount… */ });
registerSubagentTool(pi, {
	registry, depth: 0,
	notify: (rec, result) => {
		if (!notifyCtx?.hasUI) return;
		const icon = result.ok ? "✓" : "✗";
		const dur = fmtDur((rec.endedAt ?? Date.now()) - rec.startedAt);
		const toks = result.usage.input + result.usage.output;
		const preview = result.finalText.replace(/\s+/g, " ").slice(0, 80);
		notifyCtx.ui.notify(`${icon} ${rec.nickname} (${rec.agentName}) · ${result.usage.turns} turns · ${toks} tok · ${dur} · ${preview}`, result.ok ? "info" : "error");
	},
});
```

- [ ] **Step 3: ctrl+O (toggle detail) and ctrl+B (background newest running) shortcuts**

```ts
pi.registerShortcut("ctrl+o", { description: "Toggle subagent widget detail", handler: () => { state.collapsed = !state.collapsed; registry.onChange; /* trigger render */ } });
pi.registerShortcut("ctrl+b", {
	description: "Background the running subagents",
	handler: (ctx) => {
		let n = 0;
		for (const r of registry.recent(8)) if (r.status === "running" && !r.background) { registry.setBackground(r, true); n++; }
		if (n > 0) ctx.ui.notify(`Backgrounded ${n} subagent${n > 1 ? "s" : ""}.`, "info");
	},
});
```

> ctrl+o note: the widget reads `getCollapsed()` each render; after toggling, force a redraw by calling the registry's notify (expose a `registry.touch()` method that calls `notify()`), or re-`setWidget`. Add `touch(): void { this.notify(); }` to `RunRegistry`.

- [ ] **Step 4: Verify background + notifications + keys**

Run `pi -e …`. 
1. "Run scout in the background to map the extensions dir." → tool returns immediately; widget shows the row with `bg`; on completion a themed `ctx.ui.notify` toast fires with ✓, turns, tokens, duration, preview.
2. Start a foreground run, press ctrl+B → row flips to `bg`, main thread frees.
3. Press ctrl+O → widget detail lines appear/disappear.

> If `registerShortcut` key ids differ (e.g. ctrl+o is reserved for tool expansion globally), fall back to ctrl+g for detail toggle and document it. Verify the key isn't already bound before shipping.

---

### Task 8: `/agents` roster overlay (`roster.ts`)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/roster.ts`
- Modify: `~/.pi/agent/extensions/subagents/index.ts` (register `/agents` command + per-agent `/<name>` commands)

**Interfaces:**
- Consumes: `discoverAgents`, `AgentConfig`; `ctx.ui.custom`, `ctx.ui.input`; the dispatch path from `tool.ts` (extract a reusable `dispatchSingle`/`dispatchChain` — see Step 0).
- Produces: `openRoster(pi, ctx, deps): Promise<void>` — the overlay.
- Produces: `dispatchByCommand(deps, agentName, task)` for `/<name>` commands.

- [ ] **Step 0: Extract a shared dispatch surface in `tool.ts`** so both the tool and the roster launch runs identically.

Add and export from `tool.ts`:
```ts
export interface DispatchDeps { registry: RunRegistry; getCtx: () => any /* ExtensionContext */; notify?: (rec: RunRecord, r: RunResult) => void; }
export async function dispatchSingle(deps: DispatchDeps, agent: AgentConfig, task: string, background: boolean): Promise<RunResult> {
	const ctx = deps.getCtx();
	const rec = deps.registry.create({ agent, task, background, mode: "single" });
	const handle = await runAgent({ agent, task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: agent.fork, onEvent: (e) => deps.registry.applyEvent(rec, e) });
	rec.handle = handle;
	if (background) { void handle.promise.then((r) => { deps.registry.finish(rec, r); deps.notify?.(rec, r); }); return { ok: true, finalText: "(background)", usage: rec.usage, contextPercent: null }; }
	const r = await handle.promise; deps.registry.finish(rec, r); return r;
}
export async function dispatchChain(deps: DispatchDeps, steps: Array<{ agent: AgentConfig; task: string }>): Promise<RunResult> {
	let previous = "";
	let last: RunResult = { ok: true, finalText: "", usage: { input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,turns:0,toolCalls:0,contextTokens:0 }, contextPercent: null };
	for (let i = 0; i < steps.length; i++) {
		const ctx = deps.getCtx();
		const rec = deps.registry.create({ agent: steps[i].agent, task: substitutePrevious(steps[i].task, previous), background: false, mode: "chain", chainStep: i + 1 });
		const handle = await runAgent({ agent: steps[i].agent, task: rec.task, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: steps[i].agent.fork, onEvent: (e) => deps.registry.applyEvent(rec, e) });
		rec.handle = handle; last = await handle.promise; deps.registry.finish(rec, last);
		if (!last.ok) break; previous = last.finalText;
	}
	return last;
}
```
(Refactor the tool's `execute` to call these where natural; keeping the existing inline logic is acceptable as long as both paths use `runAgent` identically.)

- [ ] **Step 1: Write `roster.ts`** — the overlay (mirrors `ask-user-question.ts` custom-component pattern)

```ts
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { colorDot } from "./colors.ts";
import { type DispatchDeps, dispatchChain, dispatchSingle } from "./tool.ts";

function editorTheme(theme: any): EditorTheme {
	return { borderColor: (s) => theme.fg("accent", s), selectList: { selectedPrefix: (t) => theme.fg("accent", t), selectedText: (t) => theme.fg("accent", t), description: (t) => theme.fg("muted", t), scrollInfo: (t) => theme.fg("dim", t), noMatch: (t) => theme.fg("warning", t) } };
}

type RosterResult =
	| { kind: "dispatch"; agent: AgentConfig; task: string }
	| { kind: "chain"; agents: AgentConfig[]; task: string }
	| { kind: "create"; description: string }
	| { kind: "cancel" };

export async function openRoster(ctx: any, deps: DispatchDeps): Promise<void> {
	const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
	if (agents.length === 0) { ctx.ui.notify("No agents found in ~/.pi/agent/agents.", "warning"); return; }

	const result = await ctx.ui.custom<RosterResult>((tui: any, theme: any, _kb: any, done: (r: RosterResult) => void) => {
		let index = 0;
		let mode: "browse" | "task" | "create" = "browse";
		const chain: number[] = []; // selected agent indices, in order
		let cached: string[] | undefined;
		const editor = new Editor(tui, editorTheme(theme));
		const refresh = () => { cached = undefined; tui.requestRender(); };

		editor.onSubmit = (value) => {
			const text = value.trim();
			if (!text) return;
			if (mode === "create") { done({ kind: "create", description: text }); return; }
			if (chain.length > 1) done({ kind: "chain", agents: chain.map((i) => agents[i]), task: text });
			else done({ kind: "dispatch", agent: agents[chain[0] ?? index], task: text });
		};

		function handleInput(data: string) {
			if (mode === "task" || mode === "create") {
				if (matchesKey(data, Key.escape)) { mode = "browse"; editor.setText(""); refresh(); return; }
				editor.handleInput(data); refresh(); return;
			}
			if (matchesKey(data, Key.up)) { index = Math.max(0, index - 1); refresh(); return; }
			if (matchesKey(data, Key.down)) { index = Math.min(agents.length - 1, index + 1); refresh(); return; }
			if (matchesKey(data, Key.space)) {
				const at = chain.indexOf(index);
				if (at >= 0) chain.splice(at, 1); else chain.push(index);
				refresh(); return;
			}
			if (matchesKey(data, "c")) { mode = "create"; editor.setText(""); refresh(); return; }
			if (matchesKey(data, Key.enter)) { mode = "task"; editor.setText(""); refresh(); return; }
			if (matchesKey(data, Key.escape)) { done({ kind: "cancel" }); return; }
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " Agent roster") + theme.fg("muted", "  — your workers at your disposal"));
			lines.push("");
			for (let i = 0; i < agents.length; i++) {
				const a = agents[i];
				const focused = i === index;
				const order = chain.indexOf(i);
				const num = order >= 0 ? theme.fg("accent", `${order + 1}.`) : "  ";
				const prefix = focused ? theme.fg("accent", "> ") : "  ";
				const tools = a.readonly ? theme.fg("muted", "read-only") : theme.fg("muted", a.tools?.join(",") ?? "default tools");
				const head = `${prefix}${num} ${colorDot(a.color)} ${focused ? theme.fg("accent", a.name) : theme.fg("text", a.name)} ${theme.fg("dim", a.model ?? "inherit")} ${tools}`;
				add(head);
				for (const w of wrapTextWithAnsi(theme.fg("muted", a.description), width - 6)) add(`      ${w}`);
			}
			lines.push("");
			if (mode === "task") {
				add(theme.fg("muted", chain.length > 1 ? ` Task for chain (${chain.map((i) => agents[i].name).join(" → ")}); {previous} flows between steps:` : ` Task for ${agents[chain[0] ?? index].name}:`));
				for (const l of editor.render(Math.max(1, width - 2))) add(` ${l}`);
				add(theme.fg("dim", " Enter to launch • Esc to go back"));
			} else if (mode === "create") {
				add(theme.fg("muted", " Describe the new agent in plain English:"));
				for (const l of editor.render(Math.max(1, width - 2))) add(` ${l}`);
				add(theme.fg("dim", " Enter to generate • Esc to go back"));
			} else {
				add(theme.fg("dim", " ↑↓ navigate • space add to chain • enter dispatch/launch chain • c create • esc cancel"));
			}
			add(theme.fg("accent", "─".repeat(width)));
			cached = lines; return lines;
		}

		return { render, invalidate: () => { cached = undefined; }, handleInput };
	});

	if (result.kind === "cancel") return;
	if (result.kind === "dispatch") { ctx.ui.notify(`Dispatching ${result.agent.name}…`, "info"); await dispatchSingle(deps, result.agent, result.task, result.agent.background); return; }
	if (result.kind === "chain") { ctx.ui.notify(`Launching chain: ${result.agents.map((a) => a.name).join(" → ")}…`, "info"); await dispatchChain(deps, result.agents.map((a, i) => ({ agent: a, task: i === 0 ? result.task : `${result.task}\n\nPrevious step output:\n{previous}` }))); return; }
	if (result.kind === "create") { await import("./scaffold.ts").then((m) => m.scaffoldAgent(ctx, deps, result.description)); return; }
}
```

- [ ] **Step 2: Register `/agents` + per-agent `/<name>` in `index.ts`**

```ts
import { openRoster } from "./roster.ts";
import { dispatchSingle } from "./tool.ts";
// after registering the tool:
const deps = { registry, getCtx: () => notifyCtx, notify: /* same notify fn as Task 7 */ };
pi.registerCommand("agents", { description: "Browse the subagent roster; dispatch a task or compose a chain", handler: async (_args, ctx) => { notifyCtx = ctx; await openRoster(ctx, { ...deps, getCtx: () => ctx }); } });
// Register a /<name> command per discovered agent (refresh on session_start):
function registerAgentCommands(ctx: any) {
	const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
	for (const a of agents) {
		pi.registerCommand(a.name, { description: `Delegate to ${a.name}: ${a.description.slice(0, 60)}`, handler: async (args, c) => {
			const task = args.trim() || (await c.ui.input(`Task for ${a.name}`, "Describe the task…")) || "";
			if (!task) return;
			await dispatchSingle({ ...deps, getCtx: () => c }, a, task, a.background);
		} });
	}
}
// call registerAgentCommands(ctx) inside session_start (guard against double-registration with a Set of names).
```

> Commands are registered once per name. Guard with a module-level `Set<string>` so `/reload` or repeated `session_start` doesn't double-register (catch/ignore if pi throws on duplicate).

- [ ] **Step 3: Verify `/agents` + `/<name>`**

Run `pi -e …`:
1. `/agents` → overlay lists scout/planner/reviewer/worker with color dots, descriptions, model, tools/readonly.
2. Highlight scout, Enter, type a task → single run launches (widget shows it).
3. Space on scout then space on planner (rows numbered 1, 2) → Enter → type one task → a chain launches (scout → planner, `{previous}` handed off).
4. Esc cancels cleanly.
5. `/scout find the widget code` → dispatches scout directly.

---

### Task 9: Author new agents from description (`scaffold.ts`)

**Files:**
- Create: `~/.pi/agent/extensions/subagents/scaffold.ts`

**Interfaces:**
- Consumes: `dispatchSingle`/`runAgent` infra; a `planner`-style child to draft the file; `getAgentDir`.
- Produces: `scaffoldAgent(ctx, deps, description: string): Promise<void>` — generates a well-formed `.md`, writes to `~/.pi/agent/agents/<name>.md`, registers `/<name>`, notifies.

- [ ] **Step 1: Write `scaffold.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentFile } from "./agents.ts";
import { runAgent } from "./engine.ts";
import { resolveModel } from "./engine.ts";
import type { DispatchDeps } from "./tool.ts";

const COLORS = ["cyan", "purple", "green", "orange", "blue", "pink", "yellow", "magenta"];

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

const GENERATOR_PROMPT = `You generate pi subagent definition files. Given a plain-English description, output ONLY a markdown file with YAML frontmatter and a system-prompt body. Frontmatter fields:
name (kebab-case), description (written as WHEN to delegate to this agent, with "use proactively"/"always use for" cues), model (deepseek-v4-flash for fast/recon, deepseek-v4-pro for careful work), readonly (true if it should not edit), tools (omit to inherit; or a comma list from read,grep,find,ls,bash,edit,write), color (one of: cyan purple green orange blue pink yellow magenta), nickname_candidates (4-6 distinct names).
The body is the agent's system prompt: role, rules, and an explicit instruction to return a concise final summary.
Output the file content only — no fences, no commentary.`;

export async function scaffoldAgent(ctx: any, deps: DispatchDeps, description: string): Promise<void> {
	ctx.ui.notify("Generating agent definition…", "info");
	const pseudoAgent = {
		name: "agent-smith", description: "generator", model: "deepseek-v4-pro", thinking: "high",
		tools: undefined, readonly: true, color: "purple", nicknameCandidates: [], background: false, fork: false, spawn: [],
		systemPrompt: GENERATOR_PROMPT, source: "user" as const, filePath: "",
	};
	const handle = await runAgent({ agent: pseudoAgent, task: description, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: false, onEvent: () => {} });
	const result = await handle.promise;
	let content = result.finalText.trim();
	// Strip accidental code fences.
	content = content.replace(/^```[a-z]*\n/i, "").replace(/\n```$/i, "").trim();

	const parsed = parseAgentFile(content, "", "user");
	if (!parsed) { ctx.ui.notify("Generation failed: output wasn't a valid agent file. Nothing written.", "error"); return; }
	// Ensure color valid; default if not.
	if (!COLORS.includes(parsed.color)) content = content.replace(/^color:.*$/m, `color: ${COLORS[parsed.name.length % COLORS.length]}`);

	const slug = slugify(parsed.name);
	const dir = path.join(getAgentDir(), "agents");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${slug}.md`);
	if (fs.existsSync(file)) {
		const ok = await ctx.ui.confirm("Agent exists", `${file} already exists. Overwrite?`);
		if (!ok) { ctx.ui.notify("Cancelled; existing agent kept.", "warning"); return; }
	}
	fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
	ctx.ui.notify(`Created agent "${slug}" → ${file}. Run /reload, then use /${slug} or delegate to it.`, "info");
}
```

- [ ] **Step 2: Verify scaffolding**

Run `pi -e …`: `/agents` → press `c` → type "an agent that writes clear git commit messages from a diff, read-only, fast". Expected:
- A new file `~/.pi/agent/agents/<name>.md` is written with valid frontmatter (name, when-to-delegate description, model, color, nicknames) and a body.
- `/reload` → the new agent appears in `/agents` and is callable via `/<name>`.
- Re-running create with the same name prompts before overwrite.

---

### Task 10 (optional, low priority): `.claude/agents` discovery + tool-name translation

**Files:**
- Modify: `~/.pi/agent/extensions/subagents/agents.ts`

**Interfaces:**
- Produces: extend `discoverAgents` to also scan `<cwd>/.claude/agents/*.md` (only when project-trusted), translating Claude tool names → pi names.

- [ ] **Step 1: Add translation map + loader**

```ts
const CLAUDE_TOOL_MAP: Record<string, string> = { Read: "read", Grep: "grep", Glob: "find", LS: "ls", Bash: "bash", Edit: "edit", Write: "write", MultiEdit: "edit" };
// In parseAgentFile, after computing tools: tools = tools.map((t) => CLAUDE_TOOL_MAP[t] ?? t.toLowerCase());
// Add a loadDir(path.join(findProjectRoot(cwd), ".claude", "agents"), "project") branch gated on opts.includeProject.
```

- [ ] **Step 2: Verify** with a sample `.claude/agents/foo.md` containing `tools: Read, Grep` in a trusted project dir → appears in `/agents` with `read, grep`.

---

### Task 11: End-to-end verification (the spec's checklist)

**Files:** none (verification only). Run `pi -e ~/.pi/agent/extensions/subagents/index.ts`, then separately verify auto-discovery (drop the dir under `extensions/` and start `pi` normally).

- [ ] **Step 1:** Auto-delegation from natural language — "review what I just changed" triggers `subagent('reviewer')` unprompted.
- [ ] **Step 2:** Single / parallel / chain dispatch all work; chain substitutes `{previous}`.
- [ ] **Step 3:** Isolated child context — the PLATYPUS codeword probe (Task 5 Step 4.2) confirms the child can't see the parent conversation.
- [ ] **Step 4:** Live widget renders status/spinner/tokens/context% with distinct nicknames for 3 parallel reviewers; ctrl+O collapses/expands.
- [ ] **Step 5:** Background run returns immediately and fires a themed completion `notify` (✓/✗, turns, tokens, duration, preview); ctrl+B backgrounds a running agent.
- [ ] **Step 6:** `/agents` lists the full roster; dispatch single; compose + launch a chain (numbered picks); `c` scaffolds a new agent that becomes callable via `/<name>` after `/reload`.
- [ ] **Step 7:** Survives `/reload` — extension reloads, agents re-discovered, commands still work, no duplicate-registration errors.
- [ ] **Step 8:** Confirm only summaries reach the main thread (no child tool spam in the parent transcript).
- [ ] **Step 9:** Remove any `_test_*.ts` scaffolding files. Final tree under `extensions/subagents/` contains only the modules listed in File Structure.

---

## Self-Review notes (gaps & decisions surfaced)

1. **Fork (`fork:true`)** is implemented as "inherit project context files + prepend a parent transcript blurb," not a true history clone (ExtensionContext exposes only a read-only session manager; cloning live agent state in-process is out of scope). Isolated-by-default (the verified requirement) is fully correct. Full history-fork is a documented limitation. Cross-ref `[[pi-subagents-fork-limitation]]` if revisited.
2. **Steering / intercom (fast-follow)** are not in the core tasks. `RunHandle.steer` and `rec.handle` are wired so a later task can add a widget-selected `session.steer(msg)`; intercom (child→parent decision) would need a child custom tool that calls back into `ctx.ui` — deferred.
3. **Depth cap**: children don't load this extension (`noExtensions:true`), so a child literally cannot call `subagent` — depth>1 is structurally impossible by default. The `spawn` allowlist + `depth` field are retained for the documented exception (worker→scout) which, if enabled later, would register the tool inside the child with `depth:1` and a name-filtered allowlist. As shipped, the cap holds for free.
4. **`registerShortcut` key availability** (ctrl+o/ctrl+b) is verified at runtime in Task 7 Step 4; fallbacks documented.
5. **`systemPrompt` replacement vs append** for isolation is the one SDK behavior to confirm empirically (Task 3 checkpoint + Task 5 probe); fallback documented.
```
