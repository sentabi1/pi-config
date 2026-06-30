# Subagents

Delegate work to specialized AI subagents that run with their own **isolated context**, in-process (no subprocesses), with a live `/agents` control dashboard, persistent auto-spawn toggles, agent groups, ordered "sequences", and live cost/usage right in the tool output.

---

## What it does

A subagent is a child agent session with its own system prompt, model, and tool set. You delegate a focused task to it; it works in isolation and returns only a summary — keeping noisy intermediate steps off your main thread. Subagents can run one at a time, several in parallel, or chained so each one's output feeds the next.

There are three ways to invoke them:

1. **The model delegates automatically** — toggle an agent "active" and the main model spawns it when your request matches what that agent is for.
2. **You invoke one explicitly** — `/<agent-name> <task>`, or by saying *"use the reviewer subagent to …"*.
3. **You compose a sequence** in the dashboard and your next message runs through it.

---

## Quick start

1. The extension auto-loads from `~/.pi/agent/extensions/subagents/`. Agents live in `~/.pi/agent/agents/*.md`.
2. Open the dashboard: **`/agents`**.
3. Create an agent (`n`), or use an existing one.
4. Run it: `/<name> do the thing`, or toggle it active (`space` → `⏎⏎`) and just talk.

---

## Agents

Each agent is a markdown file with YAML frontmatter; the body is its system prompt.

```markdown
---
name: scout
description: Use PROACTIVELY for fast read-only codebase recon. Always use for
  "where/how is X implemented", locating files, or summarizing an area.
model: deepseek-v4-flash      # omit to inherit the parent's model
thinking: low                 # minimal | low | medium | high | xhigh
readonly: true                # shorthand: only read, grep, find, ls
tools: [read, grep, find, ls] # explicit allow-list (overrides readonly default)
color: cyan
fork: false                   # true = inherit your AGENTS.md conventions (only)
spawn: []                     # agents this one may itself delegate to
---

You are Scout, a fast read-only reconnaissance agent. …
```

The **`description` is what drives auto-spawn** — write it as *when to delegate to this agent* ("use proactively when…", "always use for…"). A sharp description fires reliably; a vague one is flaky.

**Context is isolated by default** — a child sees only its own system prompt + the task, not your conversation. Set `fork: true` to also feed it your **`AGENTS.md` conventions** (and nothing else — see [fork](#fork-inheriting-your-agentsmd) below).

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
| `n` | New agent (guided wizard) |
| `g` | New group |
| `d` | Delete (agent → removes the file; group → keeps the agents) |
| `,` | Keybind settings |
| `⏎ ⏎` | Confirm — commit toggles + arm the sequence |
| `esc esc` | Cancel — discard staged toggle changes |

**Two-press confirm:** the first `⏎`/`esc` recolors the panel border green/red (`✓ Saved!` / `✗ Canceled!`); the second commits. Any other key disarms it. Toggle changes are *staged* until you confirm, so `esc esc` truly reverts.

### Agent Editor (`e` on an agent)
Edit **name** (renames the file + updates references), model (only models you have auth for), thinking level, read-only, color (swatch picker), tools (checklist), description, and the full system prompt — `↑↓` to move, `←→` to edit a field, `⏎` save, `esc` cancel.

### New-agent wizard (`n`)
Guided steps: **name → description → system prompt → color**. On the description and prompt steps, press `Tab` for **"Want a suggestion?"** — an AI draft you can then edit (cancel the AI mid-think with `esc`). Multi-line and paste supported.

### Groups (`g`)
Bundle agents for a workflow (e.g. a `frontend` group). Toggling a group header activates/deactivates all its members at once. An agent can belong to multiple groups. Group structure saves immediately; member *activation* follows the two-press confirm.

### Keybind settings (`,`)
Every dashboard key is remappable. `↑↓` pick an action, `⏎` then press the new key, `r` resets all to defaults. Saved to `state.json`. (The settings screen's own navigation is fixed so a bad rebind can't lock you out.)

---

## The `subagent` tool (model-facing)

The main model calls this to delegate. Three modes:

- **Single** — `{ agent, task }`
- **Parallel** — `{ tasks: [{agent, task}, …] }` (concurrent, up to 6)
- **Chain** — `{ chain: [{agent, task}, …] }` — sequential; use `{previous}` in a task to substitute the prior step's output

The tool result block shows **live per-agent rows** — status icon, `mm:ss` elapsed (ticking every second), tool count, `↑input ↓output`, `$cost`, `% context`, and the task it was given (`▸ …`) — plus a `$… total` in the header and any spawned children indented beneath (`↳`). It updates as they run and scrolls normally with your transcript. Collapsed by default; `ctrl+o` expands the full output.

---

## Auto-spawn (proactive delegation)

**On by default:** every discovered agent is advertised to the main model each turn, so it delegates when your request fits a description — without you naming the agent. Run `/agents auto off` to fall back to advertising only the agents you've toggled active in `/agents` (and `/agents auto on` to re-enable). Either way it's the main model *choosing* to delegate based on the description, so keep descriptions specific.

While subagents run, live status appears in the **tool result block** (per-agent elapsed/tools/cost) for tool-dispatched runs, and as a `⟳ name · elapsed · …` **working line** for `/<name>` runs. There's no separate status-bar widget — everything lives inline in the transcript so scroll is never disturbed.

---

## Sequences (Option A)

In `/agents`, press `c` on agents in order (they number ①②③), `⏎⏎` to confirm. Your **next typed message** runs through the pipeline — each step's output flows into the next via `{previous}` — then the sequence clears. Runs non-blocking; the result is dropped into your transcript.

---

## The ideal workflow

The six bundled agents (`~/.pi/agent/agents/`) are built to cover a full change end to end. The intended loop, from cold start to shipped:

1. **Recon — `scout` (flash, read-only).** "Where/how is X?" Delegate it instead of reading a dozen files yourself; it returns `file:line` findings and keeps that noise off your main context. This is the cheap-model win — recon is the one genuinely mechanical job.
2. **Plan — `planner` (pro, read-only).** Hand it the goal; it reads the code and returns an ordered, file-anchored implementation plan. Planning is reasoning-heavy, so it runs on the strong model.
3. **Implement — `worker` (pro).** Give it a plan step. It edits the files, and **delegates back to `scout`** when it needs to locate something and to **`reviewer`** to self-check before reporting done (see *Spawn*, below).
4. **Test — `test-writer` (pro).** Writes and runs focused tests for what changed; reproduces bugs as failing tests.
5. **Review — `reviewer` (pro, read-only).** Reviews the diff for real correctness bugs and gives a ship / ship-with-fixes / don't-ship verdict.
6. **When stuck — `debugger` (pro).** Root-causes a failure systematically before fixing, and **spawns `scout`** to trace call paths.

**Model split:** all six currently run on `deepseek-v4-flash`. The principle if you want to tune cost/quality: keep recon (`scout`) on the cheap/fast model, and give the *reasoning* roles (plan, review, debug) more headroom (`deepseek-v4-pro` or higher thinking) — the biggest savings come from keeping your **main** context lean by delegating heavy reading to `scout`, not from downgrading the agents that make decisions.

**Three ways to drive it:** (1) just talk — auto-delegation is on by default, so the main model delegates by description without you naming an agent (toggle with `/agents auto off`); (2) name one explicitly with `/<agent>` or *"use the reviewer subagent to…"*; (3) build a `scout → planner → worker → reviewer` **sequence** in `/agents` and run a request straight through it.

### Spawn (agents that delegate)

An agent's `spawn:` list names the agents it may itself delegate to. When set, the child session is handed a scoped `subagent` tool limited to exactly those names (depth-capped to prevent runaway nesting). `worker` spawns `scout`/`reviewer`/`test-writer`; `debugger` spawns `scout`/`reviewer`. Nested runs show up indented under their parent (`↳`) in the tool result, with their own cost rolled into the total. To keep delegation from becoming a reflex, the spawning agents are told to delegate **only when it pays** (a multi-search lookup), and to just read inline for a quick one.

### fork — inheriting your AGENTS.md

By default a child is fully isolated (its own prompt + the task). `fork: true` additionally feeds it your **`AGENTS.md` conventions** — and *only* those:

- It loads your global `~/.pi/agent/AGENTS.md` plus every `AGENTS.md` from the filesystem root down to the project, nearest-wins.
- It deliberately does **not** load `CLAUDE.md`, pi's wider context stack, or your conversation transcript. (Internally the child runs with context-file discovery off and the `AGENTS.md` text injected directly, so nothing else can leak in.)
- It costs tokens every run (those conventions ride along each time), so reserve it for agents that *act on* your code.

In this build: **`worker`, `test-writer`, `debugger` → `fork: true`** (they edit code and need your conventions); **`scout`, `planner`, `reviewer` → `fork: false`** (recon stays fast and cheap). `AGENTS.md` is your per-project / per-language layer — edit it per codebase and the forked agents pick it up.

## Slash commands

| Command | Effect |
|---------|--------|
| `/agents` | Open the dashboard |
| `/agents -k` | Kill all running subagents (alias: `/stop-agents`) |
| `/agents auto [on\|off]` | Toggle proactive auto-delegation (all agents offered to the model each turn). On by default. |
| `/<agent-name> <task>` | Run that agent directly; live `⟳ name · elapsed · tools · $cost` while it works, result in the transcript |

---

## State & files

- Agent definitions: `~/.pi/agent/agents/*.md` (editable in the dashboard or your own editor).
- Toggles, groups, and keybind overrides: `~/.pi/agent/extensions/subagents/state.json`.
- Also discovers project agents in `.pi/agents/` and `.claude/agents/` (Claude tool names translated) when the project is trusted.

---

## Notes & limits

- **Models:** uses whatever providers you have configured (this machine: `deepseek-v4-flash`, `deepseek-v4-pro`).
- **Auto-spawn** is the model's judgment call, not a hard trigger — a precise `description` makes it reliable.
- **`fork`** feeds the child your **`AGENTS.md` conventions only** — *not* `CLAUDE.md`, not pi's wider context stack, and *not* your live conversation transcript. See the [fork](#fork-inheriting-your-agentsmd) section. In this build `fork: true` is set on `worker`, `test-writer`, and `debugger` (the agents that act on code); `scout`/`planner`/`reviewer` stay lean.
- A run launched from the model's own tool call blocks that turn (normal pi tool behavior); dashboard/sequence runs are non-blocking and `-k`-cancelable.
- New agents and renames need `/reload` before their `/name` slash command exists.

See `AGENTS.md` in this folder for implementation/architecture notes.
