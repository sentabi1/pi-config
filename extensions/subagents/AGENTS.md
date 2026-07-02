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
  The `*.test.ts` files are permanent (run them all: `for f in *.test.ts; do node --experimental-strip-types $f; done`); the `node_modules/` symlinks are gitignored and stay. Delete only throwaway `_t*.ts` scratch files.
- Imports `@earendil-works/...` (loader aliases `@mariozechner/...` to the same bundles). Tabs. Raw-ANSI/HSL style (`colors.ts`), supported `ctx.ui.*` only.

## Module map

- `engine.ts` — `runAgent()`: child via `createAgentSession({ model, tools, sessionManager: SessionManager.inMemory(), resourceLoader, modelRegistry })`; streams `session.subscribe` events into a `RunHandle`; `dispose()`s. **Isolation** = `DefaultResourceLoader({ systemPrompt: <agent body>, noContextFiles, noExtensions, noSkills })`. Fast-fail guards for already-aborted/no-model. `resolveModel()` matches `provider/id`/bare-id/substring.
- `agents.ts` — `AgentConfig`, frontmatter parse, `discoverAgents` (user + trusted `.pi/agents` + `.claude/agents` w/ tool-name translation), `resolveChildToolNames`.
- `agent-writer.ts` — `serializeAgent`/`writeAgentFile`/`deleteAgentFile` (frontmatter round-trips with the parser).
- `state.ts` — persists `{ active[], groups[], keybinds{} }` to `state.json`. Methods for toggles, groups (add/delete/rename/setMembers), `renameAgentReferences`, keybind get/set/reset.
- `keymap.ts` — `Action` union, `DEFAULT_KEYS`, `Keymap` (reads overrides from state, `matches/label/rebind`), `dataToKeyId`/`keyIdMatches`.
- `registry.ts` — `RunRegistry`/`RunRecord`: live runs, `running()/recent()/elapsedMs()/stop()`, `onChange`, `onFinish` (fires once per finished run — feeds the run log), `childCost` (nested spawn cost, included in `totalCost()`). (No nicknames, no background field — both removed.)
- `runlog.ts` — the cost feedback loop: `entryFromRecord`/`appendRunLog` persist every finished run to `runs.jsonl` (gitignored, all sessions); `readRunLog`/`aggregateRunStats`/`formatRunStats` back the `/agents stats` table (per-agent runs, failures, total/avg cost, avg duration, avg return size — sorted by total cost, the tuning signal).
- `tool.ts` — the `subagent` tool (single/parallel/sequence; API field remains `chain`). **Streams live usage/cost/context into its `renderResult` via `onUpdate`** (see gotcha #2). Also exports the shared `dispatchSingle/dispatchChain` + `DispatchDeps { registry, getCtx, notify?, showOutput? }` used by dashboard/sequence/commands.
- `chain-arm.ts` — `ArmedChain` + `routeArmedChain` (the `input`-handler logic that consumes the next typed message into the sequence, non-blocking).
- `guidance.ts` — `buildActiveAgentsBlock` (injected via `before_agent_start` for auto-spawn).
- `dashboard.ts` — the grouped `/agents` overlay (keymap-driven; groups + Ungrouped; toggle/sequence/edit/open/new/newGroup/delete/settings; two-press confirm). `openInOS()` opens an agent's `.md` in the OS app.
- `dashboard-edit.ts` — Agent Editor (name [renames file + `renameAgentReferences`], model = `getAvailable()` only, thinking, readonly, color swatch, tools checklist, full description + system-prompt sections, two-press save).
- `wizard.ts` — new-agent overlay (name → description → system prompt → color) with embedded `Editor`, `Tab` AI-suggestion ("Thinking super duper hard…", esc-cancelable via `AbortController`).
- `pickers.ts` — `pickColor`, `pickTools`, `pickGroupMembers` checklists.
- `settings.ts` — keybind remap overlay (fixed nav keys so you can't lock yourself out).
- `index.ts` — wires it all: tool, `before_agent_start` (auto-spawn), `input` (sequence routing), roster-gated backstops (`tool_call` svelte block / `tool_result` debugger nudge — only when that agent exists), `/agents` (+ `-k`, `auto`, `stats`), `/stop-agents`, per-agent `/<name>`, the `subagent-output` + `subagent-stats` message renderers, `registry.onFinish → runs.jsonl`, the footer cost segment.

Deleted over time: `nicknames.ts`, `roster.ts`, `scaffold.ts`, `flash.ts`.

## HARD-WON GOTCHAS

1. **pi renders inline (no alt-screen). Any persistent widget/header/editor whose output changes between frames resets terminal scroll.** Editor-area widgets MUST be stable — cache output, NO animation `setInterval`+`requestRender`, change-detect before repainting. This bit my widget AND the user's `neat-header.ts`/`session-description.ts` (their 25fps rainbow timers → now cached fixed gradients). Live animation only inside focused `ctx.ui.custom` overlays.
2. **Live stats (cost/usage/context) belong in the `subagent` tool's `renderResult`, streamed via `onUpdate` — NOT in a fixed widget.** The tool result is normal transcript output, so it scrolls naturally. (Learned from https://github.com/amosblomqvist/pi-subagents — the reference that has no scroll issue and shows costs/usage.) `widget.ts` was removed entirely; the only persistent surface left is the footer cost segment.
3. **You can't scroll while the main agent streams a blocking tool call** — pi-core, not fixable. Dashboard/sequence runs are non-blocking async so you can scroll + `-k` them.
4. **Overlays can't nest** (one `ctx.ui.custom`/`editor`/`input` at a time). Pattern: overlay `done()`s an intent → caller runs the sub-action (editor/picker) → reopens in a loop (`openDashboard`, `openEditor`). Choice fields edit inline (`←→`); text/color/tools/members open their own overlay between closes.
5. **`pi.sendMessage` needs `display: true`** (and a string `content`) to render, plus a `registerMessageRenderer(customType, …)`. With `display: undefined` the message is created but invisible — that was the "/<name> does nothing" bug.
6. Confirm UX = **two-press border recolor** (first press arms green/red on the panel's existing border, second commits, any other key disarms). NOT a timed flash box (user rejected that + a duration setting).
7. Hooks: `input` → `{action:"continue"|"transform"|"handled"}`; `before_agent_start` → `{systemPrompt}` replaces the turn's prompt.

## Review conventions (information design)

When reviewing changes to UI / terminal-render code here (`renderResult`, `renderCall`, message renderers, the `setWorkingMessage` line, any `ctx.ui` overlay), add an information-design pass on top of correctness:

- **Redundancy** — the same datum rendered in more than one place (e.g. cost in the header total *and* per-row *and* a child row). Render each fact once, in the most prominent place it belongs.
- **Consistency** — one concept must use one icon/color/label across all render sites (running/done/error glyphs, the agent color dot, the `subagent` label). Watch for a label printed by both `renderCall` and `renderResult` (that was a real duplicated subagent label bug).
- **Truncation / width** — will it fit at ~80 cols; is `truncateToWidth`/`truncLine` applied to anything user-controlled (task text, agent names).
- **States** — empty (no rows), error, running-vs-done, and collapsed-vs-expanded (`ctrl+o`) are all handled.

These rank as should-fix, below real correctness bugs. (Moved here from the global `reviewer` agent so the global agent stays project-agnostic; `reviewer` defers to this section via its "if the project's AGENTS.md defines review conventions" rule.)

## User preferences (don't regress)

- No nicknames/aliases/parens. Say **"sequence"**, not "chain". Models here: `deepseek-v4-flash`/`-pro` only.
- Toggles are **staged** until `⏎⏎` confirm; `esc esc` reverts (cancel must truly cancel).
- Keyhints: grouped, alphabetical within group, **no `→` arrows**, vertical column. All dashboard keys remappable via `,` settings.
- New-agent wizard wording: "Create a new subagent", running `Name:/Description:/System Prompt:` summary, `Tab` "Want a suggestion?" → "Thinking super duper hard…".
- Stable widgets > eye candy; scroll must keep working.

## Routing policy

Agent frontmatter is the source of truth for auto-delegation shape:

- `advertise: always` = hard trigger. Show every turn and route whenever its signal is present.
- `advertise: judgment` = soft trigger. Show every turn, but use only when the breadth/event tripwire applies.
- `advertise: never` = explicit-only. Show as an available specialist, but do not use proactively unless the user asked for that artifact/workflow.
- Omit `model:` by default so the child inherits the parent session model. Use `thinking:` for reasoning effort. Use `tier: fast|strong` only when the agent needs a capability tier instead of a concrete provider model; `SUBAGENT_MODEL_TIER_FAST` and `SUBAGENT_MODEL_TIER_STRONG` map tiers to model patterns.
- `conventions: true` (frontmatter; `fork` is the accepted legacy alias, internal field is `conventions`) belongs on doers that need project conventions (`worker`, `debugger`, `test-writer`, `svelte-worker`). Read-only recon/review/planning usually skip it to stay lean unless they specifically need inherited conventions.

Routing precedence when layers conflict: agent frontmatter policy, then the agent `description`, then `guidance.ts`, then the agent body, then general AGENTS.md notes. New descriptions should follow this template: trigger signal -> scale gate -> NOT-for boundaries -> return format.

Trust boundary: recon/review results may be used as references, but edits from worker/debugger/svelte-worker must be verified by the parent before declaring done. Nested spawning compounds cost; child agents should not spawn again for small work.

Mechanical backstops: the top-level extension blocks direct `edit`/`write` calls to `.svelte`, `.svelte.ts`, and `.svelte.js` files and nudges failed test/build bash results toward `debugger`. Both are **roster-gated** — they only fire if the named specialist (`svelte-worker` / `debugger`) is actually discovered, so a shared install without those agents is never blocked. Child `AgentSession`s run with `noExtensions: true`, so child Svelte routing is enforced by agent instructions/spawn policy rather than the top-level hook.

Cost feedback loop: every finished run (with nested spawn cost) is appended to `runs.jsonl`; `/agents stats` renders the per-agent aggregate. Review it periodically — an agent whose avg cost rivals doing the work inline, or that runs often with unused returns, has a mis-tuned trigger.

Routing eval: `node --experimental-strip-types routing-eval.ts` (13 cases). `--fast` runs the 6-case per-edit smoke tier (no-spawn guards + hard triggers); the full suite is for pre-merge. Timeouts are flagged `[timeout]` (spawn assertions still valid); an infra crash (non-zero exit, no spawns, not a timeout) is retried once automatically and flagged `[retried]`. **Mutation safety:** print-mode runs execute for real, so any case whose flow may edit files is tagged `cwd: "fixture"` and runs in a fresh throwaway scratch project (`createFixture()`, deleted after each attempt); only read-only breadth/recon cases run against this repo. Never point a mutation-capable prompt at repo files, and never use fictional paths either — an agent that can't find the named file stalls instead of routing.

## Status

Working & verified: in-process engine, isolation, single/parallel/sequence, auto-spawn, grouped dashboard (toggle/sequence/edit/open/new/newGroup/delete), Agent Editor (incl. rename), wizard w/ AI assist, keymap + settings, live usage/cost in tool result, `/<name>` output, `/agents -k`, persistence, `/reload`.

Spawn is wired: an agent's `spawn:` list injects a scoped `subagent` custom tool into the child session (engine.ts, `customTools`), depth-capped at `MAX_SPAWN_DEPTH`. Nested runs surface as `↳` rows under the parent in the tool result; cost rolls into the total. Removed as dead code: `RunHandle.steer`, the `fork`+`parentTranscript` first-message branch (fork still inherits context files via `noContextFiles`), and the `background` param on `dispatchSingle`.

Deferred: full keymap propagation into the sub-overlays (editor/wizard/pickers still use default keys directly — only dashboard + settings are remappable); per-child run **timeout** (a hung child still blocks; the `_spawntest` smoke run exposed this); editing `spawn:` from the Agent Editor (edit the `.md` directly for now); steering/intercom not surfaced.

Plan/spec docs: `DELEGATION-TUNING-PLAN.md`. Reference repo: https://github.com/amosblomqvist/pi-subagents.
