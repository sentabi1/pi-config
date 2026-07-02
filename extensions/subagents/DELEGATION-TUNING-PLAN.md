# Delegation tuning plan — when should a subagent actually fire?

Status: implemented (phases 0–3 shipped: eval harness, description/guidance rewrites, advertise tiers, model agnosticism, roster-gated backstops) plus follow-ups beyond this plan: the cost feedback loop (`runs.jsonl` + `/agents stats`), scale gates on worker/debugger, and eval hardening (`--fast` tier, timeout flagging, infra-crash retry). Kept as the design rationale; current behavior is documented in README.md/AGENTS.md.

## The problem

Two failures that pull in **opposite** directions:

1. **Over-delegation.** `scout` gets spawned for a search the main agent could do in two
   greps. The child runs in a fresh, **uncached** session, re-reads context the main agent
   already had warm, and the round-trip is slower and pricier than just doing it.
2. **Under-delegation.** `svelte-worker` doesn't fire when editing a `.svelte` file, so the
   main agent writes Svelte 5 from memory and gets runes subtly wrong — the exact case the
   specialist exists for.

Both are governed by **one knob**: the guidance block in `guidance.ts:8-18`, which leans
conservative. One knob can't fix both — turn it up to catch svelte-worker and scout
over-fires worse; turn it down to stop scout and svelte-worker goes silent. They need
**different rules**.

## The reframe: stop routing on predicted duration

The decision was implicitly "how long will this take?" — which the model **cannot predict**,
and that's what makes routing flaky. Duration is the wrong variable. Route on three things
the model *can* assess up front:

- **Capability** — "is this a domain I'm unreliable at without tools/docs the agent has?"
  (Svelte runes → yes.) A **hard rule**, independent of size — a one-line rune edit still
  goes to svelte-worker.
- **Breadth** — "would doing this myself flood my context with reads I'll throw away?"
  The **soft cost tradeoff** scout/reviewer/debugger live on.
- **Familiarity** — "do I already know where the answer is?" If yes, never spawn recon.

The right answer to "but maybe the model *does* know how long a task takes?" is: no, and it
shouldn't try. It knows the things that actually drive the decision (capability, breadth,
familiarity); time is a bad proxy for all three.

## The four agent classes (the core model)

| Class | Trigger | How it fires | Agents |
|---|---|---|---|
| **Capability** | file signal | **hard / unconditional**, any size | `svelte-worker` |
| **Discipline** | event signal | on a detectable event | `debugger`, `reviewer` |
| **Scale** | breadth judgment | only when work is broad / unfamiliar | `scout` |
| **Deliberate** | explicit ask | never auto-fired | `test-writer` |

`worker` and `debugger` also act as **orchestrators** that delegate *into* these.
`planner` is deliberately **omitted** — see verdict below.

### Signal map (the generalization of the svelte fix)

The svelte backstop works because `.svelte` is a **detectable signal**. Most agents lack a
file signal but some have an **event** signal — that's the right analog:

- **Capability + file signal** → `svelte-worker` (`.svelte`/`.svelte.ts`/`.svelte.js`). Hard.
- **Discipline + event signal:**
  - `debugger` ← a test/build command **just exited non-zero** (cleanest backstop after svelte).
  - `reviewer` ← **about to commit / declare done.**
- **Judgment, no signal** → `scout` (breadth only). No honest mechanical hook.
- **Deliberate** → `test-writer` (explicit ask / TDD-first only). Auto-firing it after every
  change would reproduce the scout problem.

## Per-agent verdicts

### reviewer vs debugger — not the same, but the same *class*

Different **entry condition**, not different subject matter:

| | Starts from | Question | Output |
|---|---|---|---|
| **reviewer** | a diff, *no known failure* | "what *might* be wrong?" | ranked findings |
| **debugger** | a *known symptom* (failing test/crash) | "why is *this* broken?" | a fix |

Clean trigger: **failing thing in front of you → debugger; just a change to vet → reviewer.**
Their methods genuinely differ (reproduce→hypothesize→test vs diff-scan). **Keep both
separate** — merging mushes both descriptions and makes routing worse. Neither is a
capability agent: the main agent *can* review and debug. They earn delegation only via
**fresh eyes** (reviewer — author bias) and **context isolation + discipline** (debugger).
Both are soft reasons → only delegate on a **substantial** diff/failure; small ones, do inline.

### test-writer — deliberate only

Weakest auto-justification in the roster. Not capability (worker writes tests fine), no clean
event signal, heavy overlap (worker keeps its own change passing; debugger writes a failing
repro test as step 1). One genuine niche: **tests are the primary deliverable**, or
**TDD-first** (write the failing test before implementation). **Don't give it an auto-fire
signal — explicit invocation only.**

### planner — cut, or demote to artifact-only

Most cuttable. Fails harder than reviewer/debugger:
- **Needs the most context, but a child has the least.** Planning requires understanding the
  whole change surface; a fresh uncached child must rediscover it. `planner.md` admits this
  against itself ("UNCACHED high-thinking session, so reading is expensive… ~10 tool calls").
  The main agent, warm-cached with context loaded, is the *better* planner.
- **Imposes a handoff the others don't.** A plan must be *internalized and followed* by the
  executor; scout/reviewer findings are just *reference*. Delegating planning means the main
  agent gets back a plan it must re-read to act on — a round-trip that adds work and loses context.

Recommendation: **drop planner, or demote it to "produce a plan artifact for human approval"
only** — which **plan mode + the `writing-plans` skill already cover.** Never as a reflexive
"plan before implementing" step; that's the main agent thinking inline with high thinking.

## Process additions (the levers beyond the trigger)

The trigger is only one of four levers. The others were missing:

### 1. `advertiseAll` can't express per-class policy — fix the knob's shape

`index.ts:82` has one binary: advertise *all* agents or only toggled-active ones. There's no
way to say "always advertise svelte-worker, never auto-advertise test-writer." **The
framework is un-implementable as-is.** Need either a per-agent frontmatter field
(`advertise: always | judgment | never`) **or** render the guidance block in **tiers** (hard
triggers vs judgment options vs explicit-only) instead of one flat list. This unblocks
everything else.

### 2. The return contract — cost's other half

We costed the *spawn* but not the *return*. A child that returns a wall of quoted code
re-pollutes main context, destroying the reason you isolated the work. **Delegation only pays
off if what comes back is smaller than what you'd have read yourself.** Make it explicit per
agent: scout → `file:line` + terse findings (no code dumps); reviewer → ranked findings;
worker → one-line summary of what changed. (Scout already has the "paying per token" line —
promote it roster-wide; see audit.)

### 3. Tripwires, not adjectives

Replace "substantial / broad / non-trivial / unfamiliar" with falsifiable tests the model can
anchor on:
- *Can you name the file before searching? → don't spawn scout.*
- *Diff ≤ N files? → review inline.*
- *Failing test in front of you? → debugger; if not, it's not a debugger task.*

### 4. One source of truth for routing precedence

The whole problem started with `ALWAYS` (in scout's description) beating the "do it yourself"
guidance. That conflict recurs across four layers: description, guidance block, agent body,
AGENTS.md. **State the precedence order explicitly** so it isn't reintroduced, and pair it
with a **description template** (trigger signal → scale gate → NOT-for → return format) so
every new agent is written to the same contract.

### 5. Close the loop — the data already exists

The registry tracks cost per run (`registry.ts:97`). Right now you tune blind. Periodically
eyeball `/agents` history: *did this spawn cost more than it saved?* That's the feedback
signal for whether the tripwires are set right.

### Smaller

- **Nesting compounds.** `worker` → `scout`/`reviewer`/`test-writer`/`svelte-worker`, each
  uncached, each able to spawn again. Over-delegation is geometric, not linear.
  `MAX_SPAWN_DEPTH` caps depth, not breadth — add "don't spawn from a spawn for small work."
- **Trust.** The main agent tends to act on a child's return unverified. Fine for recon; for
  a `worker` edit it should re-check. State when to trust vs verify.

## Agent-definition element audit

The recurring finding: **your best patterns already exist but are applied unevenly.** The
cleanup is mostly *promoting four in-house patterns to roster-wide standards*, not inventing new ones.

### Frontmatter

- **`model` welds the roster to one provider** — every agent hardcodes `deepseek-v4-flash`.
  Make model selection **provider-agnostic** (works on deepseek, claude, codex, any registry).
  The infra already supports it: `engine.ts:161` does `resolveModel(registry, agent.model) ??
  args.parentModel`, so an agent with no resolvable `model` **already inherits the session
  model.** Separate the two things `model:` conflates:
  - **Reasoning effort = `thinking: low|medium|high`** — already agnostic (pi maps it to each
    provider's reasoning knob). Keep as-is; it's the portable reasoning lever.
  - **Model selection** — stop naming concrete ids. Default: **omit `model:` → inherit the
    session model** (delete the hardcoded ids; this is already the fallback). When an agent
    needs a *different capability* than the session default, declare an **abstract tier**
    (`tier: fast | strong`), resolved to a concrete model via **one per-environment mapping**
    (explicit, or auto-derived from the registry by cost/capability) that plugs into the
    existing `resolveModel` chain. Switching providers = change one mapping (or nothing);
    agent defs never mention a provider.
- **`fork` is inconsistent and undocumented.** Doers fork (`worker`/`debugger`/`test-writer`/
  `svelte-worker`); readonly recon doesn't (`scout`/`planner`/`reviewer`). Probably right
  (recon starts clean + cheap) but **state the rule**: *fork = inherits project context files;
  recon skips it to stay uncached, doers take it to match conventions.*
- **`readonly` is the best pattern — lean in.** It enforces the contract *mechanically*, not by
  prompt. Where a constraint can be a flag, make it a flag.
- **`thinking`** mostly right. Quibble: `svelte-worker` is `medium` but its hard part is doc
  lookup + validation (tools), not reasoning — could be `low`.

### Body redundancy to cut

- **The "fresh, UNCACHED session" paragraph is copy-pasted into five agents**, each reworded —
  it will drift. *But* it serves a different audience than `guidance.ts` (that tells the **main**
  agent whether to delegate; this tells the **child** how much to read). Don't delete —
  **extract one canonical sentence** used verbatim.
- **Tool-constraint prose duplicates the `readonly` flag** (scout states it twice). Belt-and-
  suspenders; recognize the flag is the enforcer.

### Vagueness to make explicit — and the in-house cure

The adjective disease is everywhere ("non-trivial / well-scoped / substantial / unfamiliar").
**`worker.md` already solved it** — its quality-gate tiers (*trivial → no gate; logic → review;
tested logic → tests*) are concrete and falsifiable. **Rewrite every other agent's trigger to
that level.**

**Contradiction to fix:** `reviewer`'s description says "Use PROACTIVELY immediately after
writing or editing code" (every edit) — but `worker`'s gating says "trivial change → no review
gate." Worker is correct; **rewrite reviewer's description to exclude trivial diffs** or it
over-fires like scout.

### Missing elements to add

- **Brevity / return-size cap on *every* agent.** Only scout has the "paying per token" line —
  it's the return contract (#2 above); put it in all seven.
- **Stop-vs-guess boundary everywhere.** `worker` nails it ("don't invent scope; stop and report
  rather than guessing"). Only worker has it — debugger/svelte-worker/test-writer need it too.
- **Svelte review ownership is ambiguous.** `svelte-worker`'s description claims it when a task
  "*reviews* a .svelte file," but `reviewer` is the review agent. Pick one: svelte-worker owns
  *validation* (autofixer/docs), reviewer owns *correctness review* of any diff — or svelte-worker
  owns Svelte review end-to-end. State it.

### The four patterns to promote roster-wide

1. `readonly` flag — mechanical enforcement over prose.
2. worker's **gate tiers** — explicit thresholds over adjectives.
3. scout's **token-cost line** — the return contract.
4. worker's **stop-vs-guess rule** — safety boundary.

## Verification

- **scout no longer over-fires:** ask "where is X" for an obvious location → main agent greps
  directly, no scout run in `/agents`.
- **svelte-worker always fires:** trivial one-line `.svelte` edit → svelte-worker spawns (or the
  hook reminder fires) every time.
- **scale still works:** trace a cross-cutting flow over many files → scout fires.
- **discipline events:** make a test exit non-zero → debugger nudge; approach a commit → reviewer nudge.
- Use `pi -p -e …/index.ts "<prompt>"` (print mode runs routing) for repeatable checks; cross-check
  cost against `/agents` history.

## Decisions (resolved)

1. **Advertise model → per-agent frontmatter field.** Add `advertise: always | judgment | never`
   to each agent; `guidance.ts` reads it and renders agents in tiers. Policy lives next to the
   agent (declarative, dashboard-editable, scales mechanically). Not a tiered block in code.
2. **Planner → keep, artifact-only.** Fires only when a written plan for human approval IS the
   deliverable; never as a reflexive pre-implementation step. Reversible; revisit with usage data.
3. **Model → provider-agnostic.** Agents never name a concrete model. `thinking` carries
   reasoning effort (already agnostic); optional `tier: fast | strong` carries capability,
   resolved by one per-environment mapping; default (no tier) inherits the session model.
   See the frontmatter audit above. Supersedes the earlier provider-locked "use -pro" idea.
4. **Backstops → prompting + hooks, sequenced.** Ship the prompting/description changes first and
   measure; then add the `PreToolUse` hook on `.svelte` edits and the hook on non-zero test exits.
   Sequencing lets you attribute which lever moved the needle.

## Implementation plan (ordered)

Grouped by risk profile: prose first (fast, reversible), then code, then hooks. Run the eval
(Phase 0) before and after each phase to catch silent routing regressions.

### Phase 0 — routing eval harness (do first; it gates everything)
- Build a small eval: ~12 prompts, each tagged with the agent that *should* fire (and the ones
  that should NOT). Run via `pi -p -e …/index.ts "<prompt>"`, parse which agents spawned from
  `/agents` history / run records, assert against the tag.
- This is the pass/fail you re-run after every phase. Without it, routing regressions are silent.
- **Verify:** harness runs green against current behavior as a baseline (some cases will fail —
  that's the bug surface this plan fixes; record the baseline).

### Phase 1 — descriptions + guidance (prose, reversible)
1. Rewrite `guidance.ts:8-18`: replace the single "do it yourself" rule with the
   capability(hard) / breadth(soft) two-axis rule; render agents grouped by `advertise` tier.
2. Per-agent description rewrites, killing the adjective disease with worker-style tripwires:
   - `scout`: drop "ALWAYS use for where/how"; add "if you can name the file, don't spawn me."
   - `reviewer`: remove "immediately after every edit"; exclude trivial diffs (match worker's gating).
   - `debugger` vs `reviewer`: encode the entry-condition split (known failure → debugger).
   - `svelte-worker`: "MUST, any size, tied to `.svelte`/`.svelte.ts`/`.svelte.js`"; resolve the
     svelte-review-ownership overlap with reviewer explicitly.
   - `test-writer`: "explicit ask / TDD-first only."
   - `planner`: "artifact-for-approval only."
3. Promote the four in-house patterns roster-wide: brevity/return-size line on every agent;
   stop-vs-guess rule on every doer; extract the one canonical "UNCACHED session" sentence.
- **Verify:** eval improves over baseline on the over/under-fire cases; no new regressions.

### Phase 2 — frontmatter + model agnosticism (config/code)
1. Add `advertise: always|judgment|never` to all seven; wire `guidance.ts` + the dashboard to it.
2. Remove hardcoded `model:` ids; default to session-model inheritance. Add optional
   `tier: fast|strong` + the per-environment tier→model mapping + resolver hook into `resolveModel`.
3. Document the `fork` rule (recon skips, doers take) in AGENTS.md; sanity-check each agent's flag.
- **Verify:** roster runs unchanged on the current provider; switch the active model and confirm
  agents still resolve (agnosticism holds); eval still green.

### Phase 3 — mechanical backstops (hooks)
1. `PreToolUse` hook: `Edit`/`Write` on `*.svelte*` not already inside svelte-worker → inject
   "route via svelte-worker."
2. Hook on a bash test/build command exiting non-zero → inject "consider debugger."
- **Verify:** trivial `.svelte` edit triggers the nudge every time; a failing test triggers the
  debugger nudge; eval green. Compare cost in `/agents` history against the Phase 1 baseline.

### Cross-cutting (apply throughout)
- **Tripwires not adjectives** everywhere (Phase 1 carries most of this).
- **Routing precedence**: state the one source of truth (description > guidance > body > AGENTS.md
  conflicts resolved how) and add the description template to AGENTS.md.
- **Nesting guard**: "don't spawn from a spawn for small work" note in worker/debugger/svelte-worker.
- **Trust boundary**: when the main agent should re-verify a child's return vs trust it.

## Open (not blocking — revisit later)
- **Taxonomy completeness:** is there a 5th class for **external/IO** agents (network/service/MCP,
  different trust + cost profile), or is that just a flag on existing classes? Decide when the first
  such agent appears.
