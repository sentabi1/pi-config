import assert from "node:assert/strict";
import { buildActiveAgentsBlock, formatAgentBullet } from "./guidance.ts";
import type { AgentConfig } from "./agents.ts";

const base: AgentConfig = {
	name: "scout",
	description: "Use for broad recon.",
	advertise: "judgment",
	readonly: true,
	color: "cyan",
	fork: false,
	spawn: [],
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/scout.md",
};

assert.equal(
	formatAgentBullet({
		...base,
		name: "  scout\tagent  ",
		description: "Use for\n\tbroad   recon.  ",
	}),
	"- scout agent: Use for broad recon.",
);

assert.equal(buildActiveAgentsBlock([]), "");

const block = buildActiveAgentsBlock([
	{
		...base,
		name: "  scout\tagent  ",
		description: "Use for\n\tbroad   recon.  ",
	},
]);

assert.match(block, /\n# Available subagents\n/);
assert.match(block, /Capability triggers are hard rules/);
assert.match(block, /If you can name the file or symbol to inspect, do the lookup yourself/);
assert.match(block, /Known failure, crash, or non-zero test\/build exit/);
assert.match(block, /about to declare code done or commit/);
assert.match(block, /Implementation belongs to the worker specialist/);
assert.match(block, /fresh, uncached session/);
assert.match(block, /Judgment options - use only when the breadth\/event tripwire applies:/);
assert.deepEqual(
	block.split("\n").filter((line) => line.startsWith("- ")),
	["- scout agent: Use for broad recon."],
);

console.log("guidance unit tests passed");
