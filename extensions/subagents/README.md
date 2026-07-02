# Subagents

Delegate work to specialized AI subagents that run with their own **isolated context**, in-process (no subprocesses), with a live `/agents` control dashboard, tiered auto-delegation, agent groups, ordered "sequences", mechanical routing backstops, per-agent cost history, and live cost/usage right in the tool output.

---

## What it does

A subagent is a child agent session with its own system prompt, thinking level, and tool set. You delegate a focused task to it; it works in isolation and returns only a summary — keeping noisy intermediate steps off your main thread. Subagents can run one at a time, several in parallel, or chained so each one's output feeds the next.

There are three ways to invoke them:

1. **The model delegates automatically** — every agent is advertised to the main model each turn (in tiers, see below), and it delegates when your request matches an agent's description.
2. **You invoke one explicitly** — `/<agent-name> <task>`, or by saying *"use the reviewer subagent to …"*.
3. **You compose a sequence** in the dashboard and your next message runs through it.

---

## Quick start

1. The extension auto-loads from `~/.pi/agent/extensions/subagents/`. Agents live in `~/.pi/agent/agents/*.md`.
2. Open the dashboard: **`/agents`**.
3. Create an agent (`n`), or use one of the seven bundled ones.
4. Run it: `/<name> do the thing` — or just talk; auto-delegation routes by description.

---

## Agents

Each agent is a markdown file with YAML frontmatter; the body is its system prompt.

```markdown
---
name: scout
description: Use for broad read-only codebase reconnaissance when you cannot
  name the file/symbol up front. If one or two targeted greps would answer,
  do not use. Returns terse file:line findings only. NOT for planning
  (planner), editing (worker), or review (reviewer).
advertise: judgment          # always | judgment | never — the routing tier
thinking: low                # minimal | low | medium | high | xhigh
readonly: true               # shorthand: only read, grep, find, ls
tools: [read, grep, find]    # explicit allow-list (overrides readonly default)
color: cyan
conventions: false           # true = inherit your AGENTS.md conventions (only)
spawn: []                    # agents this one may itself delegate to
# tier: fast | strong        # optional capability tier; omit to inherit the session model
---

You are Scout, a fast read-only reconnaissance agent. …
```

The **`description` drives auto-delegation**. Write it to a contract: *trigger signal → scale gate ("if it's small, do it inline") → NOT-for boundaries → return format*. A description with a falsifiable trigger routes reliably; adjectives ("non-trivial", "complex") route flaky.

**Models are provider-agnostic.** Agents don't name concrete models: omitting `model:` inherits the session model, `thinking:` carries reasoning effort portably, and the optional `tier: fast | strong` maps to a model pattern via the `SUBAGENT_MODEL_TIER_FAST` / `SUBAGENT_MODEL_TIER_STRONG` environment variables. Switching providers changes one mapping, not seven agent files.

**Context is isolated by default** — a child sees only its own system prompt + the task. `conventions: true` (legacy alias: `fork`) additionally feeds it your `AGENTS.md` conventions (global + project, nearest-wins) and *nothing else* — not `CLAUDE.md`, not pi's wider context stack, not your conversation. It costs tokens every run, so it belongs on agents that *edit* code and need your conventions, not on recon.

### The bundled roster

| Agent | Tier | Job |
|---|---|---|
| `scout` | judgment | Read-only recon when the answer crosses many unfamiliar files. Terse `file:line` findings. |
| `planner` | explicit-only | A written, file-anchored implementation plan — only when the plan itself is the deliverable. |
| `worker` | judgment | Multi-file/multi-step implementation with built-in review/test gates. Small nameable edits stay inline. |
| `svelte-worker` | **always** | Any `.svelte` / `.svelte.ts` / `.svelte.js` edit, any size — validates against real Svelte 5 docs + autofixer. |
| `test-writer` | explicit-only | Tests as the primary deliverable, or TDD-first failing tests. |
| `reviewer` | judgment | Post-change diff review before "done"/commit; ranked findings, read-only. Skipped for trivial diffs. |
| `debugger` | judgment | Known failure with a non-obvious cause: reproduce → hypothesize → verify → fix. Obvious one-line errors stay inline. |

`worker` spawns `scout`/`reviewer`/`test-writer`/`svelte-worker`; `debugger` spawns `scout`/`reviewer`. Nested runs appear indented (`↳`) under their parent with their cost rolled into every total.

### Routing tiers (`advertise`)

- **`always`** — hard trigger. If the task touches the agent's file/toolchain signal, it fires regardless of size.
- **`judgment`** — soft trigger. Fires only when the breadth/event tripwire in its description applies; small lookups and edits stay inline.
- **`never`** — explicit-only. Advertised as available, used only when you ask for that artifact/workflow.

`/agents auto off` narrows advertising to hard-trigger agents plus the ones you've toggled active; `/agents auto on` (default) advertises the full roster.

### Mechanical backstops

Descriptions are judgment; two signals are enforced mechanically — and both are **roster-gated**, firing only if the target agent actually exists in your roster:

- A direct `edit`/`write` to a `.svelte`/`.svelte.ts`/`.svelte.js` file is blocked with a "route via svelte-worker" reason.
- A failed test/build command gets a "consider the debugger" nudge appended to its result.

---

## Cost: the feedback loop

Delegation only pays when the spawn costs less than doing the work in your main context. The extension shows you both halves:

- **Live**: the tool result streams per-agent elapsed / tool count / `↑input ↓output` / `$cost` / `%context` rows while agents run, plus a `$ total` (nested spawns included). The footer carries a cumulative `⊕ $ subagents` segment for the session.
- **History**: every finished run is appended to `runs.jsonl` (gitignored). **`/agents stats`** renders the all-sessions aggregate — per agent: runs, failures, total and average cost, average duration, average return size — sorted by total cost.

Read the stats table like a bill. An agent whose average run costs more than the few greps it replaced, or that runs constantly with returns you never use, has a mis-tuned trigger — tighten its description and re-run the eval.

---

## The `/agents` dashboard

A keyboard-driven control panel. Agents are shown grouped, with an `Ungrouped` bucket; `[x]/[ ]` shows what's active.

| Key | Action |
|-----|--------|
| `↑↓` | Move |
| `space` | Toggle active (agent) / bulk-toggle a group's members |
| `c` | Add/remove the agent from the current **sequence** (numbered ①②③) |
| `e` | Edit (Agent Editor for an agent; name + members for a group) |
| `o` | Open the agent's `.md` file in your OS editor |
| `n` | New agent (guided wizard, with AI-drafted description/prompt via `Tab`) |
| `g` | New group |
| `d` | Delete (agent → removes the file; group → keeps the agents) |
| `,` | Keybind settings (every key remappable; saved to `state.json`) |
| `⏎ ⏎` | Confirm — commit toggles + arm the sequence |
| `esc esc` | Cancel — discard staged toggle changes |

**Two-press confirm:** the first `⏎`/`esc` recolors the panel border green/red; the second commits. Toggle changes are *staged* until you confirm, so `esc esc` truly reverts.

---

## The `subagent` tool (model-facing)

The main model calls this to delegate. Three modes:

- **Single** — `{ agent, task }`
- **Parallel** — `{ tasks: [{agent, task}, …] }` (concurrent, up to 6)
- **Sequence** — `{ chain: [{agent, task}, …] }` — sequential; `{previous}` in a task substitutes the prior step's output. Optional `retry: { maxRetries, retrySteps }` loops (e.g. reviewer → fixer) until the last step succeeds.

Returns are capped at 16KB with an explicit "ask a narrower question" truncation notice — a child that dumps code back into your context defeats the isolation you paid for.

## Sequences

In `/agents`, press `c` on agents in order (①②③), `⏎⏎` to confirm. Your **next typed message** runs through the pipeline — each step's output flows to the next via `{previous}` — then the sequence clears. Runs non-blocking; kill with `/agents -k`.

---

## The routing eval

Descriptions and guidance are tuned against a 13-case eval (`routing-eval.ts`): prompts tagged with the agents that *should* and *must not* spawn, run through real `pi -p` sessions.

```sh
node --experimental-strip-types routing-eval.ts --fast   # 6-case smoke tier, after any description edit
node --experimental-strip-types routing-eval.ts          # full suite, before merging
```

Timeouts are flagged (spawn assertions remain valid); infra crashes are retried once automatically. Treat the eval as non-negotiable when touching any `description` or `guidance.ts` — routing regressions are silent otherwise.

---

## Slash commands

| Command | Effect |
|---------|--------|
| `/agents` | Open the dashboard |
| `/agents stats` | Per-agent cost history table (all sessions) |
| `/agents -k` | Kill all running subagents (alias: `/stop-agents`) |
| `/agents auto [on\|off]` | Toggle full-roster auto-delegation (on by default) |
| `/<agent-name> <task>` | Run that agent directly; live `⟳ name · elapsed · tools · $cost` while it works |

---

## Growth playbook

How this system scales across projects (frontend, backend, new languages) without bloating. Three layers, cheapest first:

1. **Project `AGENTS.md`** — the 90% tool. Entering a new stack, write a short conventions file in that repo ("FastAPI backend; test with `pytest`; migrations in `alembic/`; never edit generated files"). The `conventions: true` doers inherit it there and only there. One global roster, per-project behavior.
2. **Project-local agents (`.pi/agents/`)** — specialists that travel with a repo. A frontend repo carries its component agent; a backend repo carries its migrations agent. The global roster never grows as projects accumulate, and shared repos bring their own specialists.
3. **The global roster** — universal roles only (find/plan/build/test/review/debug). Keep it under ~10 advertised agents; every advertised agent costs prompt tokens each turn and blurs routing for its neighbors.

**When a library earns a new agent:** only when the model is *confidently wrong in a way a tool can check* — a validator, docs CLI, or MCP the agent can actually run (that's why `svelte-worker` exists). Otherwise two lines in `AGENTS.md` beat a new agent. Never add agents as a way of learning a domain; the six shapes already cover it.

**Standing habits:**
- `/agents stats` every week or two. Many runs + inline-scale average cost = over-firing (tighten the description's scale gate). Zero runs in a month = demote to `advertise: never` or delete.
- One eval case per new agent — one prompt where it must fire, one where it must not — then `--fast`. Every trigger change gets checked in *both* directions (over- and under-firing).
- Delegation quality = task-statement quality. A child can't see your conversation; write tasks like a note to a competent stranger ("rename X to Y in file Z and update call sites").

## State & files

- Agent definitions: `~/.pi/agent/agents/*.md` (dashboard-editable). Project agents in `.pi/agents/` and `.claude/agents/` (tool names translated) are discovered when the project is trusted.
- Toggles, groups, keybinds: `state.json` (per-machine, gitignored).
- Run history: `runs.jsonl` (per-machine, gitignored).

## Notes & limits

- Auto-delegation is the model's judgment guided by descriptions and tiers, not a hard trigger — except the roster-gated backstops, which are mechanical.
- A run launched from the model's own tool call blocks that turn (normal pi tool behavior); dashboard/sequence runs are non-blocking and `-k`-cancelable.
- New agents and renames need `/reload` before their `/name` slash command exists.

See `AGENTS.md` in this folder for implementation/architecture notes.
