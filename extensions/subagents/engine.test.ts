import assert from "node:assert/strict";
import { resolveAgentModel } from "./engine.ts";
import type { AgentConfig } from "./agents.ts";

const models = [
	{ provider: "mock", id: "tiny-fast" },
	{ provider: "mock", id: "big-strong" },
	{ provider: "other", id: "parent" },
];
const registry = {
	getAll: () => models,
	find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
} as any;
const parent = models[2] as any;
const agent = (overrides: Partial<AgentConfig>): AgentConfig =>
	({
		name: "agent",
		description: "desc",
		readonly: false,
		color: "cyan",
		fork: false,
		spawn: [],
		systemPrompt: "",
		source: "user",
		filePath: "/tmp/agent.md",
		...overrides,
	}) as AgentConfig;

process.env.SUBAGENT_MODEL_TIER_FAST = "mock/tiny-fast";
process.env.SUBAGENT_MODEL_TIER_STRONG = "mock/big-strong";

assert.equal(resolveAgentModel(registry, agent({ model: "mock/big-strong", tier: "fast" }), parent)?.id, "big-strong");
assert.equal(resolveAgentModel(registry, agent({ tier: "fast" }), parent)?.id, "tiny-fast");
assert.equal(resolveAgentModel(registry, agent({}), parent)?.id, "parent");

delete process.env.SUBAGENT_MODEL_TIER_FAST;
delete process.env.SUBAGENT_MODEL_TIER_STRONG;

console.log("engine unit tests passed");
