import type { AgentConfig } from "./agents.ts";

/** Build the system-prompt block that advertises the available subagents so the
 * main model auto-delegates. Agent-agnostic by design: the routing intelligence
 * lives in each agent's `description` (rebuilt from disk every turn), so this text
 * never names a specific agent and never goes stale when agents are added/removed.
 * Returns "" when there are none. */
export function buildActiveAgentsBlock(active: AgentConfig[]): string {
	if (active.length === 0) return "";
	const lines = active.map((a) => `- ${a.name}: ${a.description}`);
	return [
		"",
		"# Available subagents",
		"You have specialized subagents listed below, callable via the `subagent` tool. Delegating runs one in a SEPARATE, fresh session that does NOT share your prompt cache — so every delegation pays full token price for its context and is only worth it when the work is substantial: a multi-step investigation spanning many files, independent tasks you can run in parallel, or work whose intermediate reads would otherwise bloat your own context. For anything you can answer or do directly in a few tool calls with context you already have, DO IT YOURSELF — delegating a small task costs more and takes longer, not less. When the work IS big enough, match it to the single best-fitting description (they state what each is, and is NOT, for; if two fit, pick the earliest phase: investigate → plan → implement → test → review → fix). When in doubt, do it yourself.",
		...lines,
		"",
	].join("\n");
}
