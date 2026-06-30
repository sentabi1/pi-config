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
		"You have specialized subagents listed below. For each user request, check whether it matches an agent's description; if one fits, delegate to it via the `subagent` tool instead of doing the work yourself. Delegate proactively — the user does not need to name the agent. Match the request to the single best-fitting description (their descriptions state what each is, and is NOT, for); if two seem to fit, pick the one whose phase comes first (investigate → plan → implement → test → review → fix). If none fit, just do the work yourself.",
		...lines,
		"",
	].join("\n");
}
