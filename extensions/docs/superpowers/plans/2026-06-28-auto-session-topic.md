# Auto-Generated Session Topic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `session-description.ts` automatically generate the rainbow widget's topic text from the conversation via a small side LLM call, while still letting `/topic <text>` override it manually.

**Architecture:** Buffer the plain-text user prompts that arrive on the `before_agent_start` event. On `agent_end`, throttled (first turn, then every Nth), fire a single non-streaming `completeSimple` call asking the model for a ≤5-word topic, and route the result through the existing topic-application path (cache invalidate + one repaint + persist as a `session-summary` custom entry). A manual `/topic` sets a per-session lock so auto-generation stops clobbering it; `/topic auto` hands control back.

**Tech Stack:** TypeScript, pi extension API (`@earendil-works/pi-coding-agent`), pi-ai inference (`completeSimple`), pi's existing custom session-entry persistence.

## Global Constraints

- Single file: all changes live in `/Users/jordan/.pi/agent/extensions/session-description.ts`. No new runtime dependencies.
- **Scrollback rule (copied from the file's own comments):** pi renders inline with no alternate screen. Never force a repaint per frame. The widget's `render()` output MUST stay stable across the many repaints pi does while streaming; only recompute on an explicit `widgetInvalidate()` followed by exactly one `tuiRef.requestRender()`. The auto-updater must obey this exactly as `/topic` already does.
- **Never block or crash the agent loop.** The LLM call is fire-and-forget: it must be wrapped so any error (no API key, abort, network) is swallowed silently and the widget keeps showing the last good text.
- At most one summarization call in flight at a time.
- Manual `/topic <text>` always wins until the session ends or the user runs `/topic auto`.
- Existing behavior preserved: `/session-summary` toggle, persistence across `/reload`, "Session in progress" default, rainbow rendering.

---

## File Structure

Only `session-description.ts` changes. New internal pieces, all inside the existing `export default function (pi)` closure unless noted:

- **Pure helpers (module scope, above `export default`)** — testable without pi:
  - `extractAssistantText(message): string` — pull concatenated `text` parts out of an assistant message's `content` array.
  - `sanitizeTopic(raw: string): string` — trim, strip surrounding quotes/markdown/trailing punctuation, collapse whitespace, clamp to a max length.
  - `buildTopicContext(prompts: string[], lastAssistantText: string): Context` — assemble the tiny `{ systemPrompt, messages }` Context handed to `completeSimple`.
- **Closure state:** `recentPrompts: string[]`, `lastAssistantText: string`, `manualLock: boolean`, `turnsSinceSummary: number`, `isGenerating: boolean`, `genAbort: AbortController | null`.
- **Closure functions:** `applyTopic(text, ctx, opts)` (refactor of the inline `/topic` body), `maybeAutoSummarize(ctx)` (throttle + invoke).

---

## Task 1: Resolve and verify model invocation from an extension (spike)

This MUST come first. The whole feature depends on an extension being able to call the model, and that is **not yet proven**: `@earendil-works/pi-ai` is nested under `pi-coding-agent/node_modules` (not top-level in `.npm-global`), and the extension API exposes pi-ai only as type-only imports — there is no `ctx.complete()` helper. We need to confirm the runtime import path before building on it.

**Files:**
- Create (throwaway): `/Users/jordan/.pi/agent/extensions/_spike-model-call.ts`

**Interfaces:**
- Produces (for later tasks): a confirmed import statement for a callable `completeSimple`, and confirmation that `ctx.model` + `ctx.modelRegistry.getApiKeyAndHeaders(model)` yield usable auth. Record the working import line in this task's notes.

- [ ] **Step 1: Write a throwaway spike extension that calls the model on a command**

```ts
// _spike-model-call.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// CANDIDATE IMPORT — the thing we are verifying:
import { completeSimple } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("spike-model", {
		description: "spike: prove an extension can call the model",
		handler: async (_args, ctx: any) => {
			const model = ctx.model;
			if (!model) { ctx.ui.notify("no model", "error"); return; }
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) { ctx.ui.notify("auth failed: " + auth.error, "error"); return; }
			const res = await completeSimple(
				model,
				{
					systemPrompt: "Reply with exactly the single word: pong",
					messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
				},
				{ maxTokens: 16, temperature: 0, apiKey: auth.apiKey, headers: auth.headers },
			);
			const text = res.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
			ctx.ui.notify("model said: " + JSON.stringify(text), "info");
		},
	});
}
```

- [ ] **Step 2: Run pi and invoke the spike**

Run: start pi in this account, then type `/spike-model`.
Expected: a notification `model said: "pong"` (or close). This proves: (a) the `@earendil-works/pi-ai` import resolves at runtime from an extension, (b) `getApiKeyAndHeaders` returns usable auth, (c) `completeSimple` returns an `AssistantMessage` whose `content` text we can extract.

- [ ] **Step 3: If the bare import fails to resolve, try fallbacks in order and record which works**

```ts
// Fallback A: deep path
import { completeSimple } from "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
// Fallback B: dynamic import resolved from the pi-coding-agent package location
const piAiPath = require.resolve("@earendil-works/pi-ai", {
	paths: [require.resolve("@earendil-works/pi-coding-agent")],
});
const { completeSimple } = await import(piAiPath);
```

Expected: one of these yields `model said: "pong"`. Note the winning form — every later task uses it verbatim. If NONE work, STOP and report: model calls from an extension are not viable, and the feature must fall back to the non-LLM heuristic (first-prompt topic). Do not proceed past this task in that case.

- [ ] **Step 4: Delete the spike**

```bash
rm /Users/jordan/.pi/agent/extensions/_spike-model-call.ts
git add -A && git commit -m "spike: verify extension model invocation (reverted)"
```

---

## Task 2: Extract and unit-test pure helpers

Pull the text-wrangling logic into pure functions so it can be tested with `npx tsx` (no pi, no network). These are the parts most likely to misbehave on weird model output.

**Files:**
- Modify: `/Users/jordan/.pi/agent/extensions/session-description.ts` (add helpers at module scope, above `export default function`)
- Test: `/Users/jordan/.pi/agent/extensions/session-description.test.ts`

**Interfaces:**
- Produces:
  - `extractAssistantText(message: { content?: Array<{ type: string; text?: string }> }): string`
  - `sanitizeTopic(raw: string): string`
  - `buildTopicContext(prompts: string[], lastAssistantText: string): { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> }`
  - Module constant `MAX_TOPIC_LEN = 48`

- [ ] **Step 1: Write the failing test**

```ts
// session-description.test.ts
import { strict as assert } from "node:assert";
import { extractAssistantText, sanitizeTopic, buildTopicContext } from "./session-description.ts";

// extractAssistantText
assert.equal(
	extractAssistantText({ content: [{ type: "text", text: "hello " }, { type: "thinking" } as any, { type: "text", text: "world" }] }),
	"hello world",
);
assert.equal(extractAssistantText({ content: [] }), "");
assert.equal(extractAssistantText({}), "");

// sanitizeTopic
assert.equal(sanitizeTopic('  "Refactor auth flow."  '), "Refactor auth flow");
assert.equal(sanitizeTopic("**Fix rainbow widget**"), "Fix rainbow widget");
assert.equal(sanitizeTopic("Topic: debugging scrollback"), "debugging scrollback");
assert.equal(sanitizeTopic(""), "");
assert.equal(sanitizeTopic("a".repeat(100)).length, 48);

// buildTopicContext
const ctx = buildTopicContext(["add dark mode", "make it persist"], "I added a toggle.");
assert.equal(ctx.messages.length, 1);
assert.equal(ctx.messages[0].role, "user");
assert.ok(ctx.messages[0].content.includes("add dark mode"));
assert.ok(ctx.messages[0].content.includes("make it persist"));
assert.ok(ctx.systemPrompt.toLowerCase().includes("topic"));

console.log("all helper tests passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jordan/.pi/agent/extensions && npx tsx session-description.test.ts`
Expected: FAIL — `extractAssistantText` (and the others) are not exported.

- [ ] **Step 3: Add the helpers to session-description.ts (module scope, above `export default function`)**

```ts
export const MAX_TOPIC_LEN = 48;

export function extractAssistantText(message: { content?: Array<{ type: string; text?: string }> }): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("");
}

export function sanitizeTopic(raw: string): string {
	let s = (raw ?? "").trim();
	// strip a leading "Topic:"/"Summary:" label the model sometimes adds
	s = s.replace(/^(topic|summary)\s*[:\-]\s*/i, "");
	// strip surrounding markdown emphasis and quotes
	s = s.replace(/^[*_`"'\s]+/, "").replace(/[*_`"'\s]+$/, "");
	// drop a single trailing sentence-ending punctuation
	s = s.replace(/[.!?]+$/, "");
	// collapse internal whitespace/newlines
	s = s.replace(/\s+/g, " ").trim();
	if (s.length > MAX_TOPIC_LEN) s = s.slice(0, MAX_TOPIC_LEN).trim();
	return s;
}

export function buildTopicContext(
	prompts: string[],
	lastAssistantText: string,
): { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> } {
	const promptBlock = prompts.map((p) => `- ${p}`).join("\n");
	const tail = lastAssistantText ? `\n\nMost recent assistant reply (for context):\n${lastAssistantText.slice(0, 600)}` : "";
	const content =
		`The user's requests so far in this coding session:\n${promptBlock}${tail}\n\n` +
		`Reply with a topic of at most 5 words. No punctuation, no quotes, no preamble.`;
	return {
		systemPrompt:
			"You name the current coding session. Output ONLY a terse topic label of at most 5 words " +
			"describing what the user is working on. No quotes, no trailing punctuation, no explanation.",
		messages: [{ role: "user", content, timestamp: Date.now() }],
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jordan/.pi/agent/extensions && npx tsx session-description.test.ts`
Expected: PASS — prints `all helper tests passed`.

- [ ] **Step 5: Commit**

```bash
git add session-description.ts session-description.test.ts
git commit -m "feat(session-topic): add pure topic helpers with tests"
```

---

## Task 3: Refactor topic application + track manual override

Centralize "set the widget text" into one `applyTopic` function (the inline `/topic` handler currently duplicates this), and add the manual-lock flag plus a `/topic auto` subcommand. No LLM yet — this keeps the refactor independently reviewable.

**Files:**
- Modify: `/Users/jordan/.pi/agent/extensions/session-description.ts` (closure state + `/topic` handler, ~lines 48-52 and 155-173)

**Interfaces:**
- Consumes: `widgetInvalidate` and `tuiRef` (existing closure vars), `ctx.sessionManager.appendCustomEntry`, `summaryText` (existing).
- Produces: `applyTopic(text: string, ctx: any, opts: { fromUser: boolean }): void` and a closure boolean `manualLock`, both used by Task 4.

- [ ] **Step 1: Add closure state near the existing declarations (after `let widgetInvalidate ...`)**

```ts
	let manualLock = false;
	const recentPrompts: string[] = [];
	let lastAssistantText = "";
	let turnsSinceSummary = 0;
	let isGenerating = false;
	let genAbort: AbortController | null = null;
```

- [ ] **Step 2: Add `applyTopic` (place it just above the `pi.registerCommand("session-summary"...)` block)**

```ts
	// Single path for changing the widget text. Obeys the scrollback rule:
	// invalidate the cached line, then exactly one repaint.
	function applyTopic(text: string, ctx: any, opts: { fromUser: boolean }) {
		const clean = sanitizeTopic(text);
		if (!clean) return;
		summaryText = clean;
		if (opts.fromUser) manualLock = true;
		ctx.sessionManager.appendCustomEntry("session-summary", { text: summaryText });
		widgetInvalidate?.();
		tuiRef?.requestRender();
	}
```

- [ ] **Step 3: Rewrite the `/topic` handler to use `applyTopic` and support `auto`**

```ts
	pi.registerCommand("topic", {
		description: "Set the session topic manually, or '/topic auto' to resume auto-generation.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg.toLowerCase() === "auto") {
				manualLock = false;
				turnsSinceSummary = 0; // re-summarize on next agent_end
				ctx.ui.notify("Topic: auto mode", "info");
				return;
			}
			if (!arg) {
				ctx.ui.notify("Usage: /topic <text>  |  /topic auto", "error");
				return;
			}
			applyTopic(arg, ctx, { fromUser: true });
			ctx.ui.notify("Topic set", "info");
		},
	});
```

- [ ] **Step 4: Verify it still builds/loads (no test runner for the TUI parts — manual)**

Run: start pi, then:
- `/topic hello world` → widget shows `⌘ hello world`.
- `/reload` → widget still shows `hello world` (persistence intact).
- `/topic auto` → notification "Topic: auto mode" (text unchanged for now).
Expected: all three behave as described; no crash, scrollback not jumping.

- [ ] **Step 5: Commit**

```bash
git add session-description.ts
git commit -m "refactor(session-topic): centralize applyTopic, add manual lock + /topic auto"
```

---

## Task 4: Wire up auto-generation on conversation events

Buffer prompts on `before_agent_start`, and on `agent_end` (throttled) call the model and apply the result — unless the user has a manual lock.

**Files:**
- Modify: `/Users/jordan/.pi/agent/extensions/session-description.ts` (add import; add `maybeAutoSummarize`; register two event handlers near the existing `pi.on("session_start", ...)`)

**Interfaces:**
- Consumes: `applyTopic`, `recentPrompts`, `lastAssistantText`, `manualLock`, `turnsSinceSummary`, `isGenerating`, `genAbort`, `extractAssistantText`, `buildTopicContext` (all from Tasks 2-3); `ctx.model`, `ctx.modelRegistry.getApiKeyAndHeaders`.
- Produces: nothing downstream (final task).

- [ ] **Step 1: Add the verified import from Task 1 at the top of the file**

Use the exact form Task 1 proved. Default (if the bare import resolved):

```ts
import { completeSimple } from "@earendil-works/pi-ai";
```

- [ ] **Step 2: Add `maybeAutoSummarize` (place it just below `applyTopic`)**

```ts
	const SUMMARIZE_EVERY = 5; // turns between refreshes (first turn always summarizes)
	const MAX_BUFFERED_PROMPTS = 8;

	async function maybeAutoSummarize(ctx: any) {
		if (manualLock) return;
		if (isGenerating) return;
		if (!ctx.model) return;
		if (recentPrompts.length === 0) return;
		// Throttle: summarize on the first turn, then every Nth turn.
		if (summaryText !== "Session in progress" && turnsSinceSummary < SUMMARIZE_EVERY) return;

		isGenerating = true;
		genAbort = new AbortController();
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) return;
			const context = buildTopicContext(recentPrompts, lastAssistantText);
			const res = await completeSimple(ctx.model, context, {
				maxTokens: 24,
				temperature: 0.3,
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: genAbort.signal,
			});
			const topic = extractAssistantText(res as any);
			if (topic && !manualLock) {
				applyTopic(topic, ctx, { fromUser: false });
				turnsSinceSummary = 0;
			}
		} catch {
			// Swallow: never disrupt the session over a cosmetic topic.
		} finally {
			isGenerating = false;
			genAbort = null;
		}
	}
```

- [ ] **Step 3: Register the event handlers (near the existing `pi.on("session_start", ...)`)**

```ts
	pi.on("before_agent_start", (event: any, _ctx) => {
		const p = (event?.prompt ?? "").trim();
		if (!p) return;
		recentPrompts.push(p);
		while (recentPrompts.length > MAX_BUFFERED_PROMPTS) recentPrompts.shift();
		turnsSinceSummary++;
	});

	pi.on("agent_end", (event: any, ctx) => {
		if (ctx.mode && ctx.mode !== "tui") return;
		const msgs = Array.isArray(event?.messages) ? event.messages : [];
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i]?.role === "assistant") {
				lastAssistantText = extractAssistantText(msgs[i]);
				break;
			}
		}
		// Fire and forget; maybeAutoSummarize guards its own concurrency.
		void maybeAutoSummarize(ctx);
	});
```

- [ ] **Step 4: Abort any in-flight call on session shutdown (extend existing teardown or add a handler)**

```ts
	pi.on("session_shutdown", () => {
		genAbort?.abort();
	});
```

- [ ] **Step 5: Re-run the pure-helper tests (guard against accidental breakage)**

Run: `cd /Users/jordan/.pi/agent/extensions && npx tsx session-description.test.ts`
Expected: PASS — `all helper tests passed`.

- [ ] **Step 6: Manual end-to-end verification in pi**

Run: start a fresh pi session and:
1. Send a real first message (e.g. "help me refactor the auth middleware"). After the reply completes, the widget should update from "Session in progress" to a ≤5-word topic within a second or two.
2. Send several more messages; confirm the topic refreshes roughly every 5 turns, and that the terminal scrollback does **not** jump when it updates.
3. Run `/topic locked manually` → topic changes and stays put across further turns (auto no longer overrides).
4. Run `/topic auto` → next turn regenerates a topic automatically.
5. `/reload` → last topic persists.
6. (Negative) Temporarily unset the provider API key / use an account with none; confirm the session still works and the widget just stays on its last text (no crash, no error spam).
Expected: all six behave as described.

- [ ] **Step 7: Commit**

```bash
git add session-description.ts
git commit -m "feat(session-topic): auto-generate topic from conversation via completeSimple"
```

---

## Notes / Decisions

- **Why buffer plain prompt strings instead of feeding the real message history?** `agent_end.messages` are `AgentMessage[]` (a superset of pi-ai's `Message`), and converting them into a clean `Context` is fragile (tool calls, thinking blocks, custom entries). The `before_agent_start.prompt` field is already plain text — cheap, robust, and enough signal for a 5-word label. `lastAssistantText` is added only as light extra context.
- **Cost control:** `maxTokens: 24`, throttled to first turn + every 5th, single-flight. Uses the session's current model (`ctx.model`); no separate cheap-model wiring (YAGNI — revisit if cost matters).
- **Open question deferred to Task 1:** exact runtime import path for `completeSimple`. Everything downstream assumes it resolves; Task 1 is the gate.
- **Event-name caveat:** handler registration assumes `pi.on("before_agent_start" | "agent_end" | "session_shutdown", ...)`. These match the `BeforeAgentStartEvent` / `AgentEndEvent` / `SessionShutdownEvent` types in `pi-coding-agent/dist/core/extensions/types.d.ts`. If `pi.on` rejects a name at load, check that file for the registered string and adjust.
```
