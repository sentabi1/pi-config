import type { AgentConfig } from "./agents.ts";

/** Normalize an agent's name and description into a stable single-line bullet for
 * the subagents block. Collapses any internal newlines, tabs, and runs of whitespace
 * so the output never wraps across multiple lines even when the agent's description
 * has been authored with line breaks. */
export function formatAgentBullet(agent: AgentConfig): string {
	const name = agent.name.trim().replace(/\s+/g, " ");
	const desc = agent.description.replace(/\s+/g, " ").trim();
	return `- ${name}: ${desc}`;
}

/** Build the system-prompt block that advertises the available subagents so the
 * main model auto-delegates. Agent-agnostic by design: the routing intelligence
 * lives in each agent's `description` (rebuilt from disk every turn), so this text
 * never names a specific agent and never goes stale when agents are added/removed.
 * Returns "" when there are none. */
export function buildActiveAgentsBlock(active: AgentConfig[]): string {
	if (active.length === 0) return "";
	const always = active.filter((a) => a.advertise === "always").map(formatAgentBullet);
	const judgment = active.filter((a) => a.advertise === "judgment").map(formatAgentBullet);
	const explicit = active.filter((a) => a.advertise === "never").map(formatAgentBullet);
	const addGroup = (out: string[], title: string, lines: string[]) => {
		if (lines.length === 0) return;
		out.push(title, ...lines);
	};
	const groups: string[] = [];
	addGroup(groups, "Hard triggers - use whenever the listed signal is present:", always);
	addGroup(groups, "Judgment options - use only when the breadth/event tripwire applies:", judgment);
	addGroup(groups, "Explicit-only - use only when the user asks for this artifact/workflow:", explicit);
	return [
		"",
		"# Available subagents",
		"You have specialized subagents listed below, callable via the `subagent` tool. Delegating runs one in a separate, fresh, uncached session, so it only pays off when the routing rule below says it does.",
		"Capability triggers are hard rules: if a task touches a file type, framework, or toolchain that an advertised specialist claims explicitly, delegate that part even when the edit is tiny.",
		"Breadth triggers are judgment calls: use a recon agent only when the work spans many unknown files or would flood your context with reads you will throw away. If you can name the file or symbol to inspect, do the lookup yourself.",
		"Event triggers are discipline backstops: a known failure, crash, or non-zero test/build exit means use the debugging specialist before investigating inline — the only exception is an error that alone names its own trivial one-line fix; about to declare code done or commit means use the review specialist unless the diff is trivial.",
		"Deliberate agents fire only when the user asks for that artifact or workflow, such as tests as the primary deliverable or a written plan for approval.",
		"Implementation: make small, nameable edits yourself; delegate to the implementation specialist when the change spans several files or steps and its edit/build churn would crowd your context. Do not substitute reviewer for code-writing work.",
		"When more than one description seems relevant, prefer the earliest needed phase: investigate, plan, implement, test, review, then fix. Return contracts matter: ask children for concise findings with file:line evidence, not code dumps.",
		...groups,
		"",
	].join("\n");
}
