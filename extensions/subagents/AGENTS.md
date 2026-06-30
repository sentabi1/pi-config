# Subagents extension — working notes

A personal `pi` extension: delegate tasks to **in-process child `AgentSession`s** (not subprocesses), with a grouped `/agents` dashboard, persistent auto-spawn toggles, ordered "sequences", a remappable keymap, and live cost/usage shown in the tool result. Lives in `~/.pi/agent/extensions/subagents/` + agent defs in `~/.pi/agent/agents/*.md`. Untouched by `npm update` — never patch `dist`. See `README.md` for the user-facing feature tour.

## Run / test

- **Interactive:** `pi -e ~/.pi/agent/extensions/subagents/index.ts` (or just `pi` — auto-discovers). Hot reload: `/reload`.
- **Headless smoke/functional test:** `pi -p -e …/index.ts --no-extensions --no-session "<prompt>"`. Confirms load + tool dispatch; **print mode also runs slash commands**, so `pi -p … "/scout reply PING"` actually tests a per-agent command end to end.
- **Unit tests:** `state.ts`, `keymap.ts` are pure-ish (node-only or self-contained) and run with `node --experimental-strip-types _t.ts`. Modules importing package symbols (`parseFrontmatter`, pi-tui, typebox) need a local `node_modules` symlink:
  ```sh
  cd ~/.pi/agent/extensions/subagents
  PCA=/Users/jordan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent
  mkdir -p node_modules/@earendil-works
  ln -sfn $PCA node_modules/@earendil-works/pi-coding-agent
  ln -sfn $PCA/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/pi-tui
  ln -sfn $PCA/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
  ln -sfn $PCA/node_modules/typebox node_modules/typebox
  ```
  **Delete `node_modules/` and any `_t*.ts`/`_test*.ts` before finishing.**
- Imports `@earendil-works/...` (loader aliases `@mariozechner/...` to the same bundles). Tabs. Raw-ANSI/HSL style (`colors.ts`), supported `ctx.ui.*` only.

## Module map

- `engine.ts` — `runAgent()`: child via `createAgentSession({ model, tools, sessionManager: SessionManager.inMemory(), resourceLoader, modelRegistry })`; streams `session.subscribe` events into a `RunHandle`; `dispose()`s. **Isolation** = `DefaultResourceLoader({ systemPrompt: <agent body>, noContextFiles, noExtensions, noSkills })`. Fast-fail guards for already-aborted/no-model. `resolveModel()` matches `provider/id`/bare-id/substring.
- `agents.ts` — `AgentConfig`, frontmatter parse, `discoverAgents` (user + trusted `.pi/agents` + `.claude/agents` w/ tool-name translation), `resolveChildToolNames`.
- `agent-writer.ts` — `serializeAgent`/`writeAgentFile`/`deleteAgentFile` (frontmatter round-trips with the parser).
- `state.ts` — persists `{ active[], groups[], keybinds{} }` to `state.json`. Methods for toggles, groups (add/delete/rename/setMembers), `renameAgentReferences`, keybind get/set/reset.
- `keymap.ts` — `Action` union, `DEFAULT_KEYS`, `Keymap` (reads overrides from state, `matches/label/rebind`), `dataToKeyId`/`keyIdMatches`.
- `registry.ts` — `RunRegistry`/`RunRecord`: live runs, `running()/recent()/elapsedMs()/stop()`, `onChange`. (No nicknames, no background field — both removed.)
- `tool.ts` — the `subagent` tool (single/parallel/chain). **Streams live usage/cost/context into its `renderResult` via `onUpdate`** (see gotcha #2). Also exports the shared `dispatchSingle/dispatchChain` + `DispatchDeps { registry, getCtx, notify?, showOutput? }` used by dashboard/sequence/commands.
- `chain-arm.ts` — `ArmedChain` + `routeArmedChain` (the `input`-handler logic that consumes the next typed message into the sequence, non-blocking).
- `guidance.ts` — `buildActiveAgentsBlock` (injected via `before_agent_start` for auto-spawn).
- `widget.ts` — below-editor status line, **running-only**, stable output + change-detected repaint, `fmtElapsed`.
- `dashboard.ts` — the grouped `/agents` overlay (keymap-driven; groups + Ungrouped; toggle/sequence/edit/open/new/newGroup/delete/settings; two-press confirm). `openInOS()` opens an agent's `.md` in the OS app.
- `dashboard-edit.ts` — Agent Editor (name [renames file + `renameAgentReferences`], model = `getAvailable()` only, thinking, readonly, color swatch, tools checklist, full description + system-prompt sections, two-press save).
- `wizard.ts` — new-agent overlay (name → description → system prompt → color) with embedded `Editor`, `Tab` AI-suggestion ("Thinking super duper hard…", esc-cancelable via `AbortController`).
- `pickers.ts` — `pickColor`, `pickTools`, `pickGroupMembers` checklists.
- `settings.ts` — keybind remap overlay (fixed nav keys so you can't lock yourself out).
- `index.ts` — wires it all: tool, `before_agent_start` (auto-spawn), `input` (sequence routing), `/agents` (+ `-k`), `/stop-agents`, per-agent `/<name>`, the `subagent-output` message renderer + `showOutput`, the widget.

Deleted over time: `nicknames.ts`, `roster.ts`, `scaffold.ts`, `flash.ts`.

## HARD-WON GOTCHAS

1. **pi renders inline (no alt-screen). Any persistent widget/header/editor whose output changes between frames resets terminal scroll.** Editor-area widgets MUST be stable — cache output, NO animation `setInterval`+`requestRender`, change-detect before repainting. This bit my widget AND the user's `neat-header.ts`/`session-description.ts` (their 25fps rainbow timers → now cached fixed gradients). Live animation only inside focused `ctx.ui.custom` overlays.
2. **Live stats (cost/usage/context) belong in the `subagent` tool's `renderResult`, streamed via `onUpdate` — NOT in a fixed widget.** The tool result is normal transcript output, so it scrolls naturally. (Learned from https://github.com/amosblomqvist/pi-subagents — the reference that has no scroll issue and shows costs/usage.) The persistent widget is kept minimal (running names only).
3. **You can't scroll while the main agent streams a blocking tool call** — pi-core, not fixable. Dashboard/sequence runs are non-blocking async so you can scroll + `-k` them.
4. **Overlays can't nest** (one `ctx.ui.custom`/`editor`/`input` at a time). Pattern: overlay `done()`s an intent → caller runs the sub-action (editor/picker) → reopens in a loop (`openDashboard`, `openEditor`). Choice fields edit inline (`←→`); text/color/tools/members open their own overlay between closes.
5. **`pi.sendMessage` needs `display: true`** (and a string `content`) to render, plus a `registerMessageRenderer(customType, …)`. With `display: undefined` the message is created but invisible — that was the "/<name> does nothing" bug.
6. Confirm UX = **two-press border recolor** (first press arms green/red on the panel's existing border, second commits, any other key disarms). NOT a timed flash box (user rejected that + a duration setting).
7. Hooks: `input` → `{action:"continue"|"transform"|"handled"}`; `before_agent_start` → `{systemPrompt}` replaces the turn's prompt.

## Review conventions (information design)

When reviewing changes to UI / terminal-render code here (`renderResult`, `renderCall`, message renderers, the `setWorkingMessage` line, any `ctx.ui` overlay), add an information-design pass on top of correctness:

- **Redundancy** — the same datum rendered in more than one place (e.g. cost in the header total *and* per-row *and* a child row). Render each fact once, in the most prominent place it belongs.
- **Consistency** — one concept must use one icon/color/label across all render sites (running/done/error glyphs, the agent color dot, the `subagent` label). Watch for a label printed by both `renderCall` and `renderResult` (that was a real "subagent chain twice" bug).
- **Truncation / width** — will it fit at ~80 cols; is `truncateToWidth`/`truncLine` applied to anything user-controlled (task text, agent names).
- **States** — empty (no rows), error, running-vs-done, and collapsed-vs-expanded (`ctrl+o`) are all handled.

These rank as should-fix, below real correctness bugs. (Moved here from the global `reviewer` agent so the global agent stays project-agnostic; `reviewer` defers to this section via its "if the project's AGENTS.md defines review conventions" rule.)

## User preferences (don't regress)

- No nicknames/aliases/parens. Say **"sequence"**, not "chain". Models here: `deepseek-v4-flash`/`-pro` only.
- Toggles are **staged** until `⏎⏎` confirm; `esc esc` reverts (cancel must truly cancel).
- Keyhints: grouped, alphabetical within group, **no `→` arrows**, vertical column. All dashboard keys remappable via `,` settings.
- Status widget: **running only** (no "watching" line), and not duplicated inside `/agents`.
- New-agent wizard wording: "Create a new subagent", running `Name:/Description:/System Prompt:` summary, `Tab` "Want a suggestion?" → "Thinking super duper hard…".
- Stable widgets > eye candy; scroll must keep working.

## Status

Working & verified: in-process engine, isolation, single/parallel/sequence, auto-spawn, grouped dashboard (toggle/sequence/edit/open/new/newGroup/delete), Agent Editor (incl. rename), wizard w/ AI assist, keymap + settings, live usage/cost in tool result, `/<name>` output, `/agents -k`, persistence, `/reload`.

Spawn is wired: an agent's `spawn:` list injects a scoped `subagent` custom tool into the child session (engine.ts, `customTools`), depth-capped at `MAX_SPAWN_DEPTH`. Nested runs surface as `↳` rows under the parent in the tool result; cost rolls into the total. Removed as dead code: `RunHandle.steer`, the `fork`+`parentTranscript` first-message branch (fork still inherits context files via `noContextFiles`), and the `background` param on `dispatchSingle`.

Deferred: full keymap propagation into the sub-overlays (editor/wizard/pickers still use default keys directly — only dashboard + settings are remappable); per-child run **timeout** (a hung child still blocks; the `_spawntest` smoke run exposed this); editing `spawn:` from the Agent Editor (edit the `.md` directly for now); steering/intercom not surfaced.

Plan/spec docs: `PLAN.md`, `PLAN-v2.md`. Reference repo: https://github.com/amosblomqvist/pi-subagents.
