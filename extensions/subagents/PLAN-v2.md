# Subagents v2 — Dashboard, Toggles, Chains & Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Rework the subagents extension into a `/agents` control dashboard with persistent agent toggles (auto-spawn), ephemeral number-ordered chains that route your next message, non-blocking + stoppable runs, editable/persisted agent definitions, and fixes for the scroll-pin / frozen-UI / background-hang bugs.

**Architecture:** Agent *definitions* live in `~/.pi/agent/agents/*.md` (frontmatter editable from the dashboard, rewritten in place). Active-toggle state persists in `state.json`. Active agents are advertised to the main model via a `before_agent_start` system-prompt injection so it auto-delegates. An armed chain (numbered in the dashboard) is consumed by an `input` handler: the next typed message becomes the chain task, runs as a non-blocking async job through the existing `runAgent` engine, then the chain disarms. A live "running" panel shows elapsed time + stop.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` SDK 0.80.2, `@earendil-works/pi-tui`, typebox. Builds on the existing v1 modules in `~/.pi/agent/extensions/subagents/`.

## Global Constraints

- All work under `~/.pi/agent/extensions/subagents/` + `~/.pi/agent/agents/`. Never patch `dist`. Import from `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`. Entry `export default function (pi: ExtensionAPI)`. Tabs for indentation.
- **Remove entirely:** nicknames/aliases (`nicknames.ts`, `nicknameCandidates`, the `(agent)` parens), and the foreground/background control (`background` param on the tool, ctrl+b shortcut, `bg` widget tag).
- **Defaults this machine:** provider `deepseek`, models `deepseek-v4-flash` / `deepseek-v4-pro`.
- Unit tests use the local-symlink trick: `mkdir -p node_modules/@earendil-works && ln -sfn <global>/pi-coding-agent node_modules/@earendil-works/pi-coding-agent` (+ `pi-tui`, `pi-ai`, and `ln -sfn <pkg>/node_modules/typebox node_modules/typebox`), run with `node --experimental-strip-types`, then delete `node_modules` + `_test_*.ts` before finishing. UI/integration verified with `pi -e` and `pi -p -e … --no-extensions`.
- Verified hooks: `pi.on("input", h)` → `{action:"continue"|"transform"|"handled", text?}`; `pi.on("before_agent_start", h)` → `{systemPrompt?}` (replaces the turn's system prompt); widget factory `(tui,theme)=>Component&{dispose?}`; `ctx.ui.custom` overlay returns `{render,invalidate,handleInput,dispose?}`.

### Glossary of v1 symbols reused (do not redefine)
- `engine.ts`: `runAgent(args): Promise<RunHandle>`, `RunHandle{promise,steer,abort}`, `RunResult{ok,finalText,usage,contextPercent,error}`, `RunEvent`, `RunUsage`, `emptyUsage()`, `resolveModel()`.
- `agents.ts`: `AgentConfig`, `discoverAgents(cwd,{includeProject})`, `parseAgentFile()`, `resolveChildToolNames()`, `READONLY_TOOLS`.
- `colors.ts`: `colorize`, `colorDot`, `SPINNER_FRAMES`, `COLOR_HEX`.
- `tool.ts`: `dispatchSingle`, `dispatchChain`, `substitutePrevious`, `DispatchDeps`, `registerSubagentTool`.

---

## File Structure

- **Delete** `nicknames.ts`, `roster.ts`.
- `agents.ts` — drop `nicknameCandidates` and `background` from `AgentConfig` (parsing stays tolerant of unknown frontmatter); add `active` is NOT stored here (lives in state).
- `registry.ts` — drop nickname/background; add `elapsedMs()`, `running()`, stop via `handle.abort()`.
- `engine.ts` — early `signal.aborted` guard; surface "(no output)" failures promptly.
- `tool.ts` — collapsed-by-default `renderResult`; remove `background`/nickname; abort guard in `dispatchChain`.
- `state.ts` *(new)* — load/save active-toggle set + armed chain (in-memory) ; `{active:string[]}` persisted to `state.json`.
- `agent-writer.ts` *(new)* — serialize `AgentConfig` → `.md` (frontmatter+body), write/delete files.
- `guidance.ts` *(new)* — build the active-agents system-prompt block.
- `chain-arm.ts` *(new)* — the armed-chain store + the `input` handler that routes the next message.
- `dashboard.ts` *(new, replaces roster.ts)* — the `/agents` overlay (list, toggle, chain-number, edit/new/delete, running zone, stop).
- `widget.ts` — running panel: elapsed time, spinner, no nicknames, collapsed detail by default, non-pinning render.
- `index.ts` — wire widget, `before_agent_start` injection, `input` chain router, `/agents`, per-agent `/<name>`, `/stop-agents`.

---

### Task 1: Fix the scroll-pin / frozen-UI bug (systematic-debugging)

**Files:**
- Modify: `~/.pi/agent/extensions/subagents/widget.ts`
- Repro: `~/.pi/agent/extensions/subagents/_repro_widget.ts`

> **REQUIRED SUB-SKILL:** Use superpowers:systematic-debugging. The symptom (viewport "keeps me down", spinner "completely frozen", "can't tell how long it's running") has two candidate causes: (a) the v1 widget's `setInterval(100ms)` + `tui.requestRender()` re-pins the scroll region to the bottom every tick; (b) during the blocking in-tool run there was no elapsed-time readout so a *working* run looked frozen. Confirm which before changing code.

**Interfaces:**
- Produces (widget): elapsed-time formatter `fmtElapsed(ms): string` → `"0:07"`, `"1:23"`, `"12:05"`.

- [ ] **Step 1: Write a minimal repro extension**

```ts
// _repro_widget.ts — isolates the animated-widget scroll behavior.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		if (!ctx.hasUI) return;
		let frame = 0;
		const start = Date.now();
		ctx.ui.setWidget("repro", (tui: any, theme: any) => {
			const timer = setInterval(() => {
				frame++;
				tui.requestRender();
			}, 100);
			return {
				render: (w: number) => [
					truncateToWidth(theme.fg("accent", `repro spinner ${"|/-\\"[frame % 4]} ${((Date.now() - start) / 1000).toFixed(1)}s`), w),
				],
				invalidate: () => {},
				dispose: () => clearInterval(timer),
			};
		});
	});
}
```

- [ ] **Step 2: Reproduce and observe**

Run: `pi -e ~/.pi/agent/extensions/subagents/_repro_widget.ts --no-extensions`. Send a message that produces several screens of output, then try to scroll up with the mouse/PageUp **while the spinner is animating**.
Expected: confirm whether the timer-driven `requestRender()` forces the viewport back to the bottom. Record the finding (yes = cause (a); no = the freeze was the missing elapsed readout = cause (b)).

- [ ] **Step 3: Apply the fix based on the finding**

If cause (a) — throttle to redraw only on real state changes plus a slow 1s tick for elapsed text, and stop animating when the user is scrolled up isn't detectable from the API, so reduce the tick to 1000ms (elapsed only needs second-resolution) and animate the spinner frame off the same 1s tick is too slow; instead keep a 120ms spinner tick **but** only call `requestRender()` when `registry.hasActive()` AND the rendered line set actually changed (cache the joined string and compare). This removes redundant renders that re-pin. Replace the widget's interval body (full widget rewritten in Task 8's `widget.ts`; for this task, patch the existing interval):

```ts
// in createSubagentsWidget factory, replace the setInterval block:
let lastJoined = "";
const timer = setInterval(() => {
	if (!registry.hasActive()) return;
	frame = (frame + 1) % SPINNER_FRAMES.length;
	const next = renderLines(lastWidth).join("\n"); // renderLines = the pure render fn
	if (next !== lastJoined) {
		lastJoined = next;
		cached = undefined;
		tui.requestRender();
	}
}, 120);
```

Add `fmtElapsed` and show it per row (see Task 8 for the final widget; this task's deliverable is just: animation no longer re-pins scroll, and each running row shows `m:ss` elapsed).

- [ ] **Step 4: Verify the fix**

Run the repro again with the change folded in; confirm you can scroll up while the spinner animates and the elapsed counter advances. Delete `_repro_widget.ts`.

> If neither throttling nor change-detection stops the pin (i.e. `requestRender` always pins), fall back to: only animate while the `/agents` dashboard is open (where scrollback isn't relevant), and in the editor widget show a static `●` + elapsed text updated on registry events only (no timer). Document whichever path shipped.

---

### Task 2: Registry & engine cleanup (drop nicknames, add elapsed/stop, abort guard)

**Files:**
- Modify: `registry.ts`, `engine.ts`, `agents.ts`
- Delete: `nicknames.ts`
- Test: `_test_registry.ts`

**Interfaces:**
- Produces (registry): `RunRecord` without `nickname`/`background`; add nothing new to the record (keep `startedAt`, `endedAt`). Methods: `running(): RunRecord[]`, `elapsedMs(rec): number`, `stop(rec): void` (calls `rec.handle?.abort()`), existing `recent/hasActive/onChange/touch/create/applyEvent/finish`.
- Produces (agents): `AgentConfig` loses `nicknameCandidates` and `background`.

- [ ] **Step 1: Trim `AgentConfig` in `agents.ts`**

Remove `nicknameCandidates` and `background` from the `AgentConfig` interface and from the object built in `parseAgentFile` (delete those two lines and the `nickname_candidates`/`background` reads). Leave `RawFrontmatter` tolerant (unknown keys ignored). Keep `fork`, `spawn`, `readonly`, `color`, `thinking`, `tools`, `model`.

- [ ] **Step 2: Rewrite `registry.ts`** (remove nickname assignment + background; add running/elapsed/stop)

```ts
import type { AgentConfig } from "./agents.ts";
import { emptyUsage, type RunEvent, type RunHandle, type RunResult, type RunStatus, type RunUsage } from "./engine.ts";

export interface RunRecord {
	id: number;
	agentName: string;
	color: string;
	task: string;
	status: RunStatus;
	lastTool?: string;
	lastText?: string;
	usage: RunUsage;
	contextPercent: number | null;
	startedAt: number;
	endedAt?: number;
	mode: "single" | "parallel" | "chain";
	chainStep?: number;
	handle?: RunHandle;
}

export class RunRegistry {
	private records: RunRecord[] = [];
	private listeners = new Set<() => void>();
	private nextId = 1;

	create(opts: { agent: AgentConfig; task: string; mode: "single" | "parallel" | "chain"; chainStep?: number }): RunRecord {
		const rec: RunRecord = {
			id: this.nextId++,
			agentName: opts.agent.name,
			color: opts.agent.color,
			task: opts.task,
			status: "pending",
			usage: emptyUsage(),
			contextPercent: null,
			startedAt: Date.now(),
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

	stop(rec: RunRecord): void {
		rec.handle?.abort();
		rec.status = "aborted";
		this.notify();
	}

	elapsedMs(rec: RunRecord): number {
		return (rec.endedAt ?? Date.now()) - rec.startedAt;
	}

	running(): RunRecord[] {
		return this.records.filter((r) => r.status === "running" || r.status === "pending");
	}

	recent(limit: number): RunRecord[] {
		const finished = this.records.filter((r) => r.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
		return [...this.running(), ...finished].slice(0, limit);
	}

	hasActive(): boolean { return this.running().length > 0; }
	onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
	touch(): void { this.notify(); }
	private notify(): void { for (const cb of this.listeners) cb(); }
}
```

- [ ] **Step 3: Add early-abort guard + fast-fail in `engine.ts`**

In `runAgent`, immediately after computing `model`, add a guard so an already-aborted signal short-circuits, and so a missing model fails fast instead of hanging:

```ts
	if (args.signal?.aborted) {
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: "aborted" }),
			steer: async () => {},
			abort: () => {},
		};
	}
	if (!model) {
		const err = `No model available for agent "${agent.name}" (pattern: ${agent.model ?? "inherit"})`;
		onEvent({ type: "status", status: "error" });
		return {
			promise: Promise.resolve({ ok: false, finalText: "", usage: emptyUsage(), contextPercent: null, error: err }),
			steer: async () => {},
			abort: () => {},
		};
	}
```

(Place this BEFORE constructing the loader/session. Import `emptyUsage` already exists in this module.)

- [ ] **Step 4: Delete `nicknames.ts`**

Run: `rm ~/.pi/agent/extensions/subagents/nicknames.ts`

- [ ] **Step 5: Test registry**

```ts
// _test_registry.ts
import { RunRegistry } from "./registry.ts";
import type { AgentConfig } from "./agents.ts";
let failed = 0; const check = (c: boolean, m: string) => { if (!c) { failed++; console.error("FAIL:", m); } };
const agent = { name: "scout", color: "cyan", readonly: true, fork: false, spawn: [], description: "d", systemPrompt: "p", source: "user", filePath: "" } as unknown as AgentConfig;
const r = new RunRegistry();
const a = r.create({ agent, task: "t", mode: "single" });
check(!("nickname" in a), "no nickname field");
check(r.running().length === 1, "running has 1");
check(r.elapsedMs(a) >= 0, "elapsed non-negative");
r.finish(a, { ok: true, finalText: "x", usage: a.usage, contextPercent: null });
check(r.running().length === 0, "running empty after finish");
check(r.recent(5).length === 1, "recent has the finished one");
console.log(failed === 0 ? "OK registry" : `${failed} FAILURES`); process.exit(failed === 0 ? 0 : 1);
```

Run (after symlink setup): `node --experimental-strip-types _test_registry.ts` → `OK registry`. Delete the test.

---

### Task 3: Active-toggle persistence (`state.ts`)

**Files:**
- Create: `state.ts`
- Test: `_test_state.ts`

**Interfaces:**
- Produces: `class SubagentState { isActive(name): boolean; toggle(name): boolean; setActive(name, on): void; activeNames(): string[]; onChange(cb): ()=>void }`. Persists `{ active: string[] }` to `~/.pi/agent/extensions/subagents/state.json`. The armed chain is NOT persisted (in-memory; see Task 7).

- [ ] **Step 1: Write `state.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_PATH = path.join(new URL(".", import.meta.url).pathname, "state.json");

export class SubagentState {
	private active = new Set<string>();
	private listeners = new Set<() => void>();

	constructor(file: string = STATE_PATH) {
		this.file = file;
		try {
			const data = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (Array.isArray(data.active)) for (const n of data.active) this.active.add(String(n));
		} catch {
			/* no state yet */
		}
	}
	private file: string;

	isActive(name: string): boolean { return this.active.has(name); }
	activeNames(): string[] { return [...this.active]; }

	setActive(name: string, on: boolean): void {
		if (on) this.active.add(name);
		else this.active.delete(name);
		this.save();
		this.notify();
	}
	toggle(name: string): boolean {
		const next = !this.active.has(name);
		this.setActive(name, next);
		return next;
	}

	onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
	private notify(): void { for (const cb of this.listeners) cb(); }
	private save(): void {
		try {
			fs.writeFileSync(this.file, JSON.stringify({ active: [...this.active] }, null, 2), "utf-8");
		} catch {
			/* best-effort */
		}
	}
}
```

- [ ] **Step 2: Test (with a temp file)**

```ts
// _test_state.ts
import * as os from "node:os"; import * as path from "node:path"; import * as fs from "node:fs";
import { SubagentState } from "./state.ts";
let failed = 0; const check = (c: boolean, m: string) => { if (!c) { failed++; console.error("FAIL:", m); } };
const f = path.join(os.tmpdir(), `sa-state-${Date.now()}.json`);
const s = new SubagentState(f);
check(!s.isActive("svelte"), "inactive by default");
check(s.toggle("svelte") === true, "toggle on returns true");
check(s.isActive("svelte"), "active after toggle");
const s2 = new SubagentState(f); // reload from disk
check(s2.isActive("svelte"), "persisted across instances");
s2.setActive("svelte", false);
check(!new SubagentState(f).isActive("svelte"), "deactivation persists");
fs.unlinkSync(f);
console.log(failed === 0 ? "OK state" : `${failed} FAILURES`); process.exit(failed === 0 ? 0 : 1);
```

Run: `node --experimental-strip-types _test_state.ts` → `OK state`. Delete the test.

---

### Task 4: Agent file writer (`agent-writer.ts`)

**Files:**
- Create: `agent-writer.ts`
- Test: `_test_writer.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `parseAgentFile` (agents.ts).
- Produces: `serializeAgent(a: Pick<AgentConfig, "name"|"description"|"model"|"thinking"|"tools"|"readonly"|"color"|"fork"|"spawn"|"systemPrompt">): string` (returns `.md` text); `writeAgentFile(a, dir): string` (writes `<dir>/<name>.md`, returns path); `deleteAgentFile(filePath): void`.

- [ ] **Step 1: Write `agent-writer.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";

function yamlString(v: string): string {
	// Quote if it contains characters that would break a bare scalar.
	if (v === "" || /[:#\[\]{}",&*!|>%@`]/.test(v) || /^\s|\s$/.test(v) || /^[-?]/.test(v)) {
		return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return v;
}

type WritableAgent = Pick<AgentConfig, "name" | "description" | "model" | "thinking" | "tools" | "readonly" | "color" | "fork" | "spawn" | "systemPrompt">;

export function serializeAgent(a: WritableAgent): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${yamlString(a.name)}`);
	lines.push(`description: ${yamlString(a.description)}`);
	if (a.model) lines.push(`model: ${yamlString(a.model)}`);
	if (a.thinking) lines.push(`thinking: ${yamlString(a.thinking)}`);
	if (a.tools && a.tools.length > 0) lines.push(`tools: [${a.tools.map(yamlString).join(", ")}]`);
	if (a.readonly) lines.push(`readonly: true`);
	lines.push(`color: ${yamlString(a.color)}`);
	if (a.fork) lines.push(`fork: true`);
	if (a.spawn && a.spawn.length > 0) lines.push(`spawn: [${a.spawn.map(yamlString).join(", ")}]`);
	lines.push("---", "", a.systemPrompt.trim(), "");
	return lines.join("\n");
}

export function writeAgentFile(a: WritableAgent, dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const safe = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const file = path.join(dir, `${safe}.md`);
	fs.writeFileSync(file, serializeAgent(a), "utf-8");
	return file;
}

export function deleteAgentFile(filePath: string): void {
	if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
```

- [ ] **Step 2: Round-trip test**

```ts
// _test_writer.ts
import { serializeAgent } from "./agent-writer.ts";
import { parseAgentFile } from "./agents.ts";
let failed = 0; const check = (c: boolean, m: string) => { if (!c) { failed++; console.error("FAIL:", m); } };
const a = { name: "svelte", description: "Use proactively for Svelte: components, runes, stores.", model: "deepseek-v4-pro", thinking: "high", tools: ["read", "edit"], readonly: false, color: "orange", fork: false, spawn: [], systemPrompt: "You are a Svelte expert.\n\nRules:\n- Be precise." };
const md = serializeAgent(a);
const back = parseAgentFile(md, "/x/svelte.md", "user");
check(!!back, "round-trips to a parseable file");
check(back!.name === "svelte" && back!.model === "deepseek-v4-pro", "scalars preserved");
check(JSON.stringify(back!.tools) === JSON.stringify(["read", "edit"]), "tools list preserved");
check(back!.description.includes("Svelte"), "description with colon preserved");
check(back!.systemPrompt.startsWith("You are a Svelte expert"), "body preserved");
console.log(failed === 0 ? "OK writer" : `${failed} FAILURES`); process.exit(failed === 0 ? 0 : 1);
```

Run: `node --experimental-strip-types _test_writer.ts` → `OK writer`. Delete the test.

---

### Task 5: Tool cleanup — collapsed results, no nickname/background, abort guard

**Files:**
- Modify: `tool.ts`

**Interfaces:**
- Consumes: `RunRegistry.stop`, `running()`.
- Produces: `dispatchChain` honoring an `AbortSignal` between steps; `registerSubagentTool` with no `background` param; collapsed-by-default `renderResult`.

- [ ] **Step 1: Remove `background` from the tool params + single-mode background branch**

In `Params`, delete the `background` field. In `execute`, delete the whole `if (background) { … }` block in single mode and the `background` variable. `dispatchSingle` keeps its `background` parameter for now but the tool always passes `false`; (we leave `dispatchSingle`'s signature intact so the dashboard can still launch fire-and-forget runs — see Task 8). Remove the `nickname` from `ToolDetails.rows` (use `agent` only).

- [ ] **Step 2: Abort guard in `dispatchChain`**

```ts
export async function dispatchChain(deps: DispatchDeps, steps: Array<{ agent: AgentConfig; task: string }>, signal?: AbortSignal): Promise<RunResult> {
	let previous = "";
	let last: RunResult = { ok: true, finalText: "", usage: emptyUsage(), contextPercent: null };
	for (let i = 0; i < steps.length; i++) {
		if (signal?.aborted) { last = { ok: false, finalText: previous, usage: emptyUsage(), contextPercent: null, error: "aborted" }; break; }
		const ctx = deps.getCtx();
		const taskText = substitutePrevious(steps[i].task, previous);
		const rec = deps.registry.create({ agent: steps[i].agent, task: taskText, mode: "chain", chainStep: i + 1 });
		const handle = await runAgent({ agent: steps[i].agent, task: taskText, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd, fork: steps[i].agent.fork, signal, onEvent: (e) => deps.registry.applyEvent(rec, e) });
		rec.handle = handle;
		last = await handle.promise;
		deps.registry.finish(rec, last);
		if (!last.ok) break;
		previous = last.finalText;
	}
	return last;
}
```

(Update `registry.create` calls in `tool.ts` to drop the `background` argument, matching Task 2's `create` signature.)

- [ ] **Step 3: Collapsed-by-default `renderResult`**

Replace `renderResult` so the **collapsed** view (default) shows only a one-line status summary; the **expanded** view (ctrl+o) shows the full text. `options.expanded` drives it:

```ts
		renderResult(result, options, theme) {
			const d = result.details as ToolDetails | undefined;
			const t = result.content[0];
			const fullText = t?.type === "text" ? t.text : "(no output)";
			const rows = d?.rows ?? [];
			const ok = rows.filter((r) => r.status === "done").length;
			const head = rows.length
				? `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", `${d?.mode} · ${ok}/${rows.length} ok`)}`
				: theme.fg("toolTitle", theme.bold("subagent"));
			if (!options.expanded) {
				const firstLine = fullText.split("\n").find((l) => l.trim()) ?? "(no output)";
				return new Text(`${head}\n${theme.fg("dim", truncateToWidth(firstLine, 100))}  ${theme.fg("muted", "(ctrl+o to expand)")}`, 0, 0);
			}
			const c = new Container();
			c.addChild(new Text(head, 0, 0));
			for (const row of rows) {
				const icon = row.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
				c.addChild(new Text(`${icon} ${colorDot(row.color)} ${theme.fg("accent", row.agent)} ${theme.fg("dim", row.preview)}`, 0, 0));
			}
			c.addChild(new Spacer(1));
			c.addChild(new Text(fullText, 0, 0));
			return c;
		},
```

(Add `truncateToWidth` to the pi-tui import in `tool.ts`. Remove `nickname` references in the row mapping; rows now carry `{ color, agent, status, preview }`.)

- [ ] **Step 4: Render smoke test**

Reuse the symlink + a small `_test_tool_render.ts` that builds a fake `theme` (`fg: (_c,t)=>t`, `bold:t=>t`) and asserts: collapsed render output contains `"(ctrl+o to expand)"` and does NOT contain the full body's later lines; expanded contains the full body. Run with `node --experimental-strip-types`; expect `OK tool-render`. Delete after.

---

### Task 6: Auto-spawn — advertise active agents (`guidance.ts` + `before_agent_start`)

**Files:**
- Create: `guidance.ts`
- Modify: `index.ts` (wire the hook)
- Test: `_test_guidance.ts`

**Interfaces:**
- Consumes: `AgentConfig[]`, `SubagentState.activeNames()`.
- Produces: `buildActiveAgentsBlock(active: AgentConfig[]): string` — returns "" when none, else a system-prompt section instructing delegation. Used as `before_agent_start` → `{ systemPrompt: event.systemPrompt + block }`.

- [ ] **Step 1: Write `guidance.ts`**

```ts
import type { AgentConfig } from "./agents.ts";

export function buildActiveAgentsBlock(active: AgentConfig[]): string {
	if (active.length === 0) return "";
	const lines = active.map((a) => `- ${a.name}: ${a.description}`);
	return [
		"",
		"# Active subagents",
		"The user has activated these subagents. When a request matches one, delegate to it by calling the `subagent` tool (single mode) instead of doing the work yourself. Prefer delegating proactively.",
		...lines,
		"",
	].join("\n");
}
```

- [ ] **Step 2: Test**

```ts
// _test_guidance.ts
import { buildActiveAgentsBlock } from "./guidance.ts";
import type { AgentConfig } from "./agents.ts";
let failed = 0; const check = (c: boolean, m: string) => { if (!c) { failed++; console.error("FAIL:", m); } };
const mk = (name: string, description: string) => ({ name, description, color: "cyan", readonly: false, fork: false, spawn: [], systemPrompt: "", source: "user", filePath: "" } as unknown as AgentConfig);
check(buildActiveAgentsBlock([]) === "", "empty when none active");
const b = buildActiveAgentsBlock([mk("svelte", "Use for Svelte work")]);
check(b.includes("svelte: Use for Svelte work"), "lists active agent");
check(b.includes("subagent"), "instructs delegation via subagent tool");
console.log(failed === 0 ? "OK guidance" : `${failed} FAILURES`); process.exit(failed === 0 ? 0 : 1);
```

Run → `OK guidance`. Delete.

- [ ] **Step 3: Wire the hook in `index.ts`** (added in Task 9's full index; the snippet)

```ts
pi.on("before_agent_start", (event, ctx) => {
	const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
	const active = agents.filter((a) => state.isActive(a.name));
	const block = buildActiveAgentsBlock(active);
	if (!block) return {};
	return { systemPrompt: `${event.systemPrompt}\n${block}` };
});
```

- [ ] **Step 4: Verify auto-spawn end to end** (`pi -e`, interactive)

Toggle an agent active (via `/agents`, Task 8) — e.g. activate `reviewer`. Then send "I just edited foo.ts, take a look." Expected: the main model calls `subagent('reviewer', …)` without you naming it. (Headless proxy: temporarily set state.json `{ "active": ["reviewer"] }`, run `pi -p -e index.ts --no-extensions "I changed engine.ts; please act appropriately"` and confirm a subagent reviewer call fires.)

---

### Task 7: Option A chain routing (`chain-arm.ts` + `input` handler)

**Files:**
- Create: `chain-arm.ts`
- Modify: `index.ts`
- Test: `_test_chainarm.ts`

**Interfaces:**
- Produces: `class ArmedChain { set(names: string[]): void; get(): string[]; clear(): void; isArmed(): boolean; onChange(cb): ()=>void }` (in-memory; the dashboard sets it, the input handler consumes it).
- Produces: the `input` handler logic `handleChainInput(text, armed, deps, agentsByName): "handled" | "continue"` — if armed and resolvable, kicks off `dispatchChain` async (non-blocking) and clears the armed chain.

- [ ] **Step 1: Write `chain-arm.ts`**

```ts
import type { AgentConfig } from "./agents.ts";
import { type DispatchDeps, dispatchChain } from "./tool.ts";

export class ArmedChain {
	private names: string[] = [];
	private listeners = new Set<() => void>();
	set(names: string[]): void { this.names = [...names]; this.notify(); }
	get(): string[] { return [...this.names]; }
	clear(): void { if (this.names.length) { this.names = []; this.notify(); } }
	isArmed(): boolean { return this.names.length > 0; }
	onChange(cb: () => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
	private notify(): void { for (const cb of this.listeners) cb(); }
}

/** Returns "handled" if the message was routed into the armed chain (async), else "continue". */
export function routeArmedChain(
	text: string,
	armed: ArmedChain,
	deps: DispatchDeps,
	resolve: (name: string) => AgentConfig | undefined,
	notify: (msg: string, type?: "info" | "warning" | "error") => void,
): "handled" | "continue" {
	if (!armed.isArmed()) return "continue";
	const names = armed.get();
	const agents = names.map(resolve);
	if (agents.some((a) => !a)) {
		notify(`Chain has an unknown agent (${names.join(" → ")}); cleared.`, "warning");
		armed.clear();
		return "continue";
	}
	armed.clear();
	notify(`Running chain: ${names.join(" → ")}…`, "info");
	const steps = (agents as AgentConfig[]).map((a, i) => ({
		agent: a,
		task: i === 0 ? text : `${text}\n\nPrevious step output:\n{previous}`,
	}));
	// Fire-and-forget: non-blocking. Errors surfaced via notify.
	void dispatchChain(deps, steps).then((r) => {
		notify(r.ok ? `Chain done: ${names.join(" → ")}` : `Chain failed: ${r.error ?? "see panel"}`, r.ok ? "info" : "error");
	});
	return "handled";
}
```

- [ ] **Step 2: Test the routing decision (no real dispatch)**

```ts
// _test_chainarm.ts
import { ArmedChain, routeArmedChain } from "./chain-arm.ts";
let failed = 0; const check = (c: boolean, m: string) => { if (!c) { failed++; console.error("FAIL:", m); } };
const armed = new ArmedChain();
check(!armed.isArmed(), "not armed initially");
let dispatched = false;
const deps: any = { registry: { create: () => ({}), applyEvent: () => {}, finish: () => {} }, getCtx: () => ({ model: undefined, modelRegistry: { getAll: () => [], find: () => undefined }, cwd: "/" }) };
const notes: string[] = [];
// unarmed → continue
check(routeArmedChain("hi", armed, deps, () => undefined, (m) => notes.push(m)) === "continue", "unarmed continues");
// armed with unknown agent → continue + cleared + warned
armed.set(["ghost"]);
check(routeArmedChain("hi", armed, deps, () => undefined, (m) => notes.push(m)) === "continue", "unknown agent → continue");
check(!armed.isArmed(), "armed cleared after unknown");
// armed with known agent → handled + cleared
armed.set(["scout"]);
const fake = { name: "scout", color: "cyan", readonly: true, fork: false, spawn: [], description: "d", systemPrompt: "p", source: "user", filePath: "" } as any;
const res = routeArmedChain("do it", armed, deps, (n) => (n === "scout" ? fake : undefined), (m) => notes.push(m));
check(res === "handled", "known agent → handled");
check(!armed.isArmed(), "armed cleared after routing");
console.log(failed === 0 ? "OK chainarm" : `${failed} FAILURES`); process.exit(failed === 0 ? 0 : 1);
```

Run → `OK chainarm` (the dispatch promise may reject in the background harmlessly since deps are fake; the routing decision is what's asserted). Delete.

- [ ] **Step 3: Wire the `input` handler in `index.ts`** (full wiring in Task 9)

```ts
pi.on("input", (event, ctx) => {
	if (event.source !== "interactive") return { action: "continue" };
	holder.ctx = ctx;
	const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
	const resolve = (n: string) => agents.find((a) => a.name === n);
	const action = routeArmedChain(event.text, armed, deps, resolve, (m, t) => ctx.ui.notify(m, t));
	return { action };
});
```

---

### Task 8: The `/agents` dashboard (`dashboard.ts`)

**Files:**
- Create: `dashboard.ts`
- Delete: `roster.ts`
- Rewrite: `widget.ts` (final form — no nicknames, elapsed time, collapsed detail, throttled render from Task 1)

This is the centerpiece. Build it in two sub-deliverables.

**Interfaces:**
- Consumes: `discoverAgents`, `AgentConfig`, `SubagentState`, `ArmedChain`, `RunRegistry`, `DispatchDeps`, `dispatchSingle`, `serializeAgent`/`writeAgentFile`/`deleteAgentFile`, `scaffoldAgent`, `colorDot`, `COLOR_HEX`.
- Produces: `openDashboard(ctx, { state, armed, registry, deps }): Promise<void>`.

- [ ] **Step 1: Rewrite `widget.ts`** (running panel, elapsed, no nicknames, throttled)

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { colorDot, colorize, SPINNER_FRAMES } from "./colors.ts";
import type { RunRecord, RunRegistry } from "./registry.ts";

export function fmtElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function createSubagentsWidget(registry: RunRegistry, getExpanded: () => boolean): (tui: any, theme: Theme) => any {
	return (tui: any, theme: Theme) => {
		let frame = 0;
		let cached: string[] | undefined;
		let lastWidth = 80;
		let lastJoined = "";
		const off = registry.onChange(() => { cached = undefined; tui.requestRender(); });
		const timer = setInterval(() => {
			if (!registry.hasActive()) return;
			frame = (frame + 1) % SPINNER_FRAMES.length;
			const next = build(lastWidth).join("\n");
			if (next !== lastJoined) { lastJoined = next; cached = undefined; tui.requestRender(); }
		}, 120);

		function row(r: RunRecord, width: number): string {
			const spin = r.status === "running" || r.status === "pending" ? colorize(r.color, SPINNER_FRAMES[frame])
				: r.status === "done" ? theme.fg("success", "✓") : r.status === "aborted" ? theme.fg("warning", "◼") : theme.fg("error", "✗");
			const el = theme.fg("dim", fmtElapsed(registry.elapsedMs(r)));
			const toks = theme.fg("dim", fmtTokens(r.usage.input + r.usage.output));
			const ctxPct = r.contextPercent != null ? theme.fg("dim", `${Math.round(r.contextPercent)}%`) : "";
			const task = theme.fg("dim", r.task.replace(/\s+/g, " ").slice(0, 36));
			return truncateToWidth(`${spin} ${colorDot(r.color)} ${theme.fg("accent", r.agentName)} ${el} ${task} ${theme.fg("muted", `${r.usage.toolCalls}⚒`)} ${toks} ${ctxPct}`, width);
		}
		function build(width: number): string[] {
			const runs = registry.recent(6);
			if (runs.length === 0) return [];
			const lines: string[] = [];
			const active = registry.running().length;
			lines.push(truncateToWidth(theme.fg("accent", "▌ subagents ") + theme.fg("muted", `${active} running`) + theme.fg("dim", "  (/agents · ctrl+o detail)"), width));
			const expanded = getExpanded();
			for (const r of runs) {
				lines.push(row(r, width));
				if (expanded) {
					const detail = r.lastTool ?? r.lastText;
					if (detail) lines.push(truncateToWidth(`    ${theme.fg("dim", `→ ${detail.slice(0, width - 6)}`)}`, width));
				}
			}
			return lines;
		}

		return {
			render(width: number): string[] { lastWidth = width; if (cached) return cached; cached = build(width); lastJoined = cached.join("\n"); return cached; },
			invalidate() { cached = undefined; },
			dispose() { off(); clearInterval(timer); },
		};
	};
}
```

- [ ] **Step 2: Verify the rewritten widget** with the Task-1 render harness pattern (mock theme/tui), asserting: no nickname text, elapsed `m:ss` present, empty registry → `[]`, expanded shows `→` detail. `OK widget`. Delete harness.

- [ ] **Step 3: Write `dashboard.ts` — browse + toggle + chain-number + running zone**

Full overlay component. Keys: ↑↓ navigate agents; **space** toggle active (persists via `state`); **c** add focused agent to the chain (auto-numbered) / press again to remove; **e** or **enter** edit focused agent; **n** new (plain-English → scaffold); **d** delete (confirm); **s** stop the first running agent; **esc** close (armed chain set from current numbering; toggles already saved).

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { colorDot } from "./colors.ts";
import { deleteAgentFile } from "./agent-writer.ts";
import { fmtElapsed } from "./widget.ts";
import type { ArmedChain } from "./chain-arm.ts";
import type { RunRegistry } from "./registry.ts";
import type { SubagentState } from "./state.ts";
import { type DispatchDeps, dispatchSingle } from "./tool.ts";
import { openEditor } from "./dashboard-edit.ts";
import { scaffoldAgent } from "./scaffold.ts";

export async function openDashboard(
	ctx: ExtensionContext,
	env: { state: SubagentState; armed: ArmedChain; registry: RunRegistry; deps: DispatchDeps },
): Promise<void> {
	let agents = discoverAgents(ctx.cwd, { includeProject: (ctx as any).isProjectTrusted?.() ?? false }).agents;
	const chain: string[] = env.armed.get(); // pre-seed from any existing arm

	type Result = { kind: "edit" | "new" | "dispatch"; agent?: AgentConfig } | { kind: "close" };

	const result = await ctx.ui.custom<Result>((tui: any, theme: any, _kb: any, done: (r: Result) => void) => {
		let index = 0;
		let cached: string[] | undefined;
		const off = env.registry.onChange(() => { cached = undefined; tui.requestRender(); });
		const spinTimer = setInterval(() => { if (env.registry.hasActive()) { cached = undefined; tui.requestRender(); } }, 200);
		const refresh = () => { cached = undefined; tui.requestRender(); };

		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) { index = Math.max(0, index - 1); refresh(); return; }
			if (matchesKey(data, Key.down)) { index = Math.min(agents.length - 1, index + 1); refresh(); return; }
			if (matchesKey(data, Key.space)) { env.state.toggle(agents[index].name); refresh(); return; }
			if (data === "c") { const n = agents[index].name; const at = chain.indexOf(n); if (at >= 0) chain.splice(at, 1); else chain.push(n); refresh(); return; }
			if (data === "e" || matchesKey(data, Key.enter)) { done({ kind: "edit", agent: agents[index] }); return; }
			if (data === "n") { done({ kind: "new" }); return; }
			if (data === "d") { done({ kind: "dispatch", agent: agents[index] }); return; } // 'dispatch' reused as delete-confirm path below
			if (data === "s") { const r = env.registry.running()[0]; if (r) env.registry.stop(r); refresh(); return; }
			if (matchesKey(data, Key.escape)) { done({ kind: "close" }); return; }
		}

		function build(width: number): string[] {
			const lines: string[] = [];
			const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", " AGENTS") + theme.fg("muted", "   space toggle · c chain · e edit · n new · d delete · s stop · esc close"));
			lines.push("");
			for (let i = 0; i < agents.length; i++) {
				const a = agents[i];
				const focused = i === index;
				const on = env.state.isActive(a.name);
				const order = chain.indexOf(a.name);
				const numTag = order >= 0 ? theme.fg("accent", `①②③④⑤⑥⑦⑧⑨`[order] ?? `(${order + 1})`) : " ";
				const toggle = on ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const tools = a.readonly ? theme.fg("muted", "read-only") : theme.fg("muted", a.tools?.join(",") ?? "default");
				const name = focused ? theme.fg("accent", a.name) : theme.fg("text", a.name);
				add(`${focused ? theme.fg("accent", "> ") : "  "}${toggle} ${colorDot(a.color)} ${name}  ${theme.fg("dim", a.model ?? "inherit")}  ${tools}  ${numTag}`);
				if (focused) for (const w of wrapTextWithAnsi(theme.fg("muted", a.description), Math.max(1, width - 6))) add(`      ${w}`);
			}
			const runs = env.registry.recent(5);
			if (runs.length) {
				lines.push("");
				add(theme.fg("muted", " RUNNING"));
				for (const r of runs) {
					const st = r.status === "running" || r.status === "pending" ? theme.fg("warning", "⠹") : r.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
					add(`  ${st} ${colorDot(r.color)} ${theme.fg("accent", r.agentName)} ${theme.fg("dim", fmtElapsed(env.registry.elapsedMs(r)))} ${theme.fg("dim", r.task.slice(0, 30))}`);
				}
				add(theme.fg("dim", "  press s to stop the running agent"));
			}
			if (chain.length) { lines.push(""); add(theme.fg("accent", ` Chain armed: ${chain.join(" → ")}`) + theme.fg("muted", " — your next message runs through it")); }
			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		}

		return {
			render(width: number) { if (cached) return cached; cached = build(width); return cached; },
			invalidate() { cached = undefined; },
			handleInput,
			dispose() { off(); clearInterval(spinTimer); },
		};
	});

	// Persist armed chain selection on close.
	env.armed.set(chain);

	if (result.kind === "close") return;
	if (result.kind === "edit" && result.agent) { await openEditor(ctx, result.agent); return; }
	if (result.kind === "new") {
		const desc = await ctx.ui.input("New agent", "Describe the agent in plain English…");
		if (desc) await scaffoldAgent(ctx, env.deps, desc);
		return;
	}
	if (result.kind === "dispatch" && result.agent) {
		// 'd' delete path: confirm then remove file.
		const ok = await ctx.ui.confirm("Delete agent", `Delete "${result.agent.name}" (${result.agent.filePath})? This removes the file.`);
		if (ok) { deleteAgentFile(result.agent.filePath); ctx.ui.notify(`Deleted ${result.agent.name}. Run /reload.`, "info"); }
		return;
	}
}
```

> Note: the `done()` callback closes the overlay before sub-actions (edit/new/delete) so we don't nest overlays. After the sub-action the user reopens `/agents`. Re-opening re-reads agents from disk, reflecting edits/new/deletes immediately (no `/reload` needed for the dashboard's own view; `/reload` is only needed for new `/<name>` slash commands and auto-spawn discovery refresh).

- [ ] **Step 4: Write `dashboard-edit.ts` — field editor**

A second overlay to edit one agent's fields and persist. Fields: model (cycle available models from `ctx.modelRegistry.getAll()`), thinking (cycle minimal/low/medium/high/xhigh), readonly (toggle), **color (opens a dedicated swatch picker — a grid of every named color rendered as an actual colored `●` dot, arrow-key navigable, enter to pick; plus an option to type a custom `#rrggbb` hex which is added to `COLOR_HEX` at runtime)**, description (`ctx.ui.editor`), system prompt (`ctx.ui.editor`), tools (`ctx.ui.input` comma list). The color picker is its own `ctx.ui.custom` overlay `pickColor(ctx): Promise<string | undefined>` returning the chosen color name/hex. On save, rebuild the `AgentConfig` and `writeAgentFile` to its existing `filePath`'s directory (preserving filename via the existing path).

```ts
import type { AgentConfig } from "./agents.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { COLOR_HEX, colorDot } from "./colors.ts";
import { serializeAgent } from "./agent-writer.ts";
import * as fs from "node:fs";

const THINKING = ["minimal", "low", "medium", "high", "xhigh"];

export async function openEditor(ctx: ExtensionContext, agent: AgentConfig): Promise<void> {
	const models = ctx.modelRegistry.getAll().map((m: any) => `${m.provider}/${m.id}`);
	const colors = Object.keys(COLOR_HEX);
	const draft = {
		model: agent.model ?? "",
		thinking: agent.thinking ?? "",
		readonly: agent.readonly,
		color: agent.color,
		tools: agent.tools?.join(", ") ?? "",
		description: agent.description,
		systemPrompt: agent.systemPrompt,
	};
	type Field = { key: keyof typeof draft; label: string; kind: "cycle" | "toggle" | "editor" | "input"; options?: string[] };
	const fields: Field[] = [
		{ key: "model", label: "Model", kind: "cycle", options: ["", ...models] },
		{ key: "thinking", label: "Thinking", kind: "cycle", options: ["", ...THINKING] },
		{ key: "readonly", label: "Read-only", kind: "toggle" },
		{ key: "color", label: "Color", kind: "cycle", options: colors },
		{ key: "tools", label: "Tools", kind: "input" },
		{ key: "description", label: "Description", kind: "editor" },
		{ key: "systemPrompt", label: "System prompt", kind: "editor" },
	];

	const action = await ctx.ui.custom<"save" | "cancel">((tui: any, theme: any, _kb: any, done: (r: "save" | "cancel") => void) => {
		let index = 0; let cached: string[] | undefined; const refresh = () => { cached = undefined; tui.requestRender(); };
		const cycle = (f: Field, dir: number) => { const o = f.options!; const cur = o.indexOf(String(draft[f.key])); const next = o[(cur + dir + o.length) % o.length]; (draft as any)[f.key] = next; };
		async function activate(f: Field) {
			if (f.kind === "toggle") { (draft as any)[f.key] = !draft[f.key]; refresh(); return; }
			if (f.kind === "cycle") { cycle(f, 1); refresh(); return; }
			if (f.kind === "input") { const v = await ctx.ui.input(f.label, String(draft[f.key])); if (v !== undefined) (draft as any)[f.key] = v; refresh(); return; }
			if (f.kind === "editor") { const v = await ctx.ui.editor(f.label, String(draft[f.key])); if (v !== undefined) (draft as any)[f.key] = v; refresh(); return; }
		}
		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) { index = Math.max(0, index - 1); refresh(); return; }
			if (matchesKey(data, Key.down)) { index = Math.min(fields.length - 1, index + 1); refresh(); return; }
			if (matchesKey(data, Key.left)) { const f = fields[index]; if (f.kind === "cycle") { cycle(f, -1); refresh(); } return; }
			if (matchesKey(data, Key.right)) { const f = fields[index]; if (f.kind === "cycle") { cycle(f, 1); refresh(); } return; }
			if (matchesKey(data, Key.enter)) { void activate(fields[index]); return; }
			if (data === "s") { done("save"); return; }
			if (matchesKey(data, Key.escape)) { done("cancel"); return; }
		}
		function build(width: number): string[] {
			const lines: string[] = []; const add = (t: string) => lines.push(truncateToWidth(t, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", ` Edit ${agent.name}`) + theme.fg("muted", "   ↑↓ field · ←→/enter change · s save · esc cancel"));
			lines.push("");
			for (let i = 0; i < fields.length; i++) {
				const f = fields[i]; const focused = i === index;
				let val = String(draft[f.key]);
				if (f.kind === "toggle") val = draft[f.key] ? "yes" : "no";
				if (f.key === "color") val = `${colorDot(draft.color)} ${draft.color}`;
				if (f.kind === "editor") val = val.replace(/\s+/g, " ").slice(0, width - 24) || "(empty)";
				add(`${focused ? theme.fg("accent", "> ") : "  "}${theme.fg(focused ? "accent" : "text", f.label.padEnd(14))} ${theme.fg("muted", val)}`);
			}
			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		}
		return { render: (w: number) => (cached ??= build(w)), invalidate: () => { cached = undefined; }, handleInput };
	});

	if (action !== "save") return;
	const tools = draft.tools.split(",").map((t) => t.trim()).filter(Boolean);
	const updated: AgentConfig = { ...agent, model: draft.model || undefined, thinking: draft.thinking || undefined, readonly: draft.readonly, color: draft.color, tools: tools.length ? tools : undefined, description: draft.description, systemPrompt: draft.systemPrompt };
	// Write back to the SAME file path (preserve filename).
	fs.writeFileSync(agent.filePath, serializeAgent(updated), "utf-8");
	ctx.ui.notify(`Saved ${agent.name} → ${agent.filePath}`, "info");
}
```

- [ ] **Step 5: Delete `roster.ts`**

Run: `rm ~/.pi/agent/extensions/subagents/roster.ts`

- [ ] **Step 6: Verify the dashboard** (`pi -e`, interactive)

Open `/agents`. Confirm: list shows `[x]/[ ]` toggle, color dot, model, tools/readonly; **space** persists a toggle (reopen → still on; check `state.json`); **c** numbers agents ①②③ and the "Chain armed" line appears; **e** opens the field editor, change model, **s** saves, and the `.md` on disk now has the new `model:` (verify with a read); **n** scaffolds; **d** confirms+deletes; **s** stops a running agent. Close with esc and confirm the armed chain persists into the next message (Task 7).

---

### Task 9: Wire `index.ts` (remove old wiring, add hooks/commands/stop)

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Rewrite `index.ts`**

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { buildActiveAgentsBlock } from "./guidance.ts";
import { ArmedChain, routeArmedChain } from "./chain-arm.ts";
import { openDashboard } from "./dashboard.ts";
import { RunRegistry } from "./registry.ts";
import { SubagentState } from "./state.ts";
import { type DispatchDeps, dispatchSingle, registerSubagentTool } from "./tool.ts";
import { createSubagentsWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
	const registry = new RunRegistry();
	const state = new SubagentState();
	const armed = new ArmedChain();
	const holder: { ctx?: ExtensionContext } = {};
	const registered = new Set<string>();
	const deps: DispatchDeps = { registry, getCtx: () => holder.ctx as ExtensionContext };

	registerSubagentTool(pi, deps);

	const getExpanded = () => holder.ctx?.ui.getToolsExpanded?.() ?? false;

	pi.on("before_agent_start", (event, ctx) => {
		holder.ctx = ctx;
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		const block = buildActiveAgentsBlock(agents.filter((a) => state.isActive(a.name)));
		return block ? { systemPrompt: `${event.systemPrompt}\n${block}` } : {};
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		holder.ctx = ctx;
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		const action = routeArmedChain(event.text, armed, deps, (n) => agents.find((a) => a.name === n), (m, t) => ctx.ui.notify(m, t));
		return { action };
	});

	pi.registerCommand("agents", {
		description: "Open the subagents dashboard (toggle, chain, edit, run)",
		handler: async (_args, ctx) => { holder.ctx = ctx; await openDashboard(ctx, { state, armed, registry, deps }); },
	});

	pi.registerCommand("stop-agents", {
		description: "Stop all running subagents",
		handler: async (_args, ctx) => {
			let n = 0;
			for (const r of registry.running()) { registry.stop(r); n++; }
			ctx.ui.notify(n ? `Stopped ${n} subagent${n > 1 ? "s" : ""}.` : "No running subagents.", "info");
		},
	});

	function registerAgentCommands(ctx: ExtensionContext) {
		const { agents } = discoverAgents(ctx.cwd, { includeProject: ctx.isProjectTrusted?.() ?? false });
		for (const a of agents) {
			if (registered.has(a.name)) continue;
			registered.add(a.name);
			try {
				pi.registerCommand(a.name, {
					description: `Delegate to ${a.name}: ${a.description.slice(0, 60)}`,
					handler: async (args, c) => {
						holder.ctx = c;
						const task = args.trim() || (await c.ui.input(`Task for ${a.name}`, "Describe the task…")) || "";
						if (task) await dispatchSingle(deps, a, task, false);
					},
				});
			} catch { /* duplicate across reloads */ }
		}
	}

	pi.on("session_start", (_e, ctx) => {
		holder.ctx = ctx;
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("subagents", createSubagentsWidget(registry, getExpanded), { placement: "aboveEditor" });
		registerAgentCommands(ctx);
	});
}
```

- [ ] **Step 2: Load smoke test**

Run: `pi -p -e ~/.pi/agent/extensions/subagents/index.ts --no-extensions --no-session "Reply with exactly: LOADED2"` → prints `LOADED2`, no load errors.

---

### Task 10: End-to-end verification

- [ ] **Step 1:** `pi -e index.ts` (or normal startup). `/agents` opens; toggle `reviewer` on (space), close; send "I edited engine.ts, please act" → reviewer auto-spawns (auto-spawn injection works). ✓
- [ ] **Step 2:** `/agents` → `c` on scout then planner then reviewer (①②③), close → type "add caching to the session store" → it routes through the chain, panel shows each step with elapsed time, then the armed chain clears. ✓ Option A
- [ ] **Step 3:** While a run is going, confirm you can **scroll up** and the spinner shows **elapsed time** (Task 1 fix). ✓
- [ ] **Step 4:** `/agents` → `e` on an agent → change model → `s` save → read the `.md` file → `model:` updated and persists. ✓
- [ ] **Step 5:** `/agents` → `s` (or `/stop-agents`) stops a running agent (status ◼). ✓
- [ ] **Step 6:** `/agents` → `n` → describe an agent → file created; `/reload` → callable via `/<name>` and appears in dashboard. ✓
- [ ] **Step 7:** Subagent tool result is **collapsed by default**; ctrl+o expands it. ✓
- [ ] **Step 8:** No nicknames/aliases/parens anywhere; no ctrl+b/background tag. ✓
- [ ] **Step 9:** `/reload` survives (no duplicate-command errors). ✓
- [ ] **Step 10:** Remove `node_modules` symlink dir and all `_test_*.ts` / `_repro_*.ts`. Final tree: `agents.ts colors.ts engine.ts registry.ts state.ts agent-writer.ts guidance.ts chain-arm.ts tool.ts widget.ts dashboard.ts dashboard-edit.ts scaffold.ts index.ts` + the two PLAN docs + `state.json`.

---

## Self-Review notes

1. **Spec coverage:** dashboard control center (T8), persistent toggles + auto-spawn (T3, T6), ephemeral number-chains routing next message (T7, T8), non-blocking + stoppable (T2 stop, T7 fire-and-forget, T9 `/stop-agents`), edit/persist to `.md` (T4, T8 edit), new/delete (T8), remove nicknames/parens/bg (T2, T5, T8), collapsed-by-default results (T5), scroll/frozen fix + elapsed (T1, T8 widget), background-hang/abort guard (T2, T5). All covered.
2. **Known seams:** auto-spawn relies on the model honoring injected guidance (encouragement, not a hard trigger) — acceptable per design. The scroll-pin root cause is confirmed empirically in T1 with a fallback documented if change-detection alone doesn't stop the pin.
3. **Type consistency:** `RunRecord` loses `nickname`/`background` in T2 and every consumer (tool rows, widget, dashboard) uses `agentName`/`color` only. `dispatchChain` gains an optional `signal` (T5) used by T7's router (passes none) and any future abort. `AgentConfig` loses `nicknameCandidates`/`background` (T2); `serializeAgent`/scaffold only emit the retained fields.
4. **`scaffold.ts`** stays as-is from v1 (already emits valid frontmatter; it does not write `nickname_candidates`, so it's already compatible — verify in T8/T10 that generated files parse).
```
