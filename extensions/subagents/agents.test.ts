import assert from "node:assert/strict";
import { parseAgentFile } from "./agents.ts";
import { serializeAgent } from "./agent-writer.ts";

const parsed = parseAgentFile(
	`---
name: svelte-worker
description: Svelte edits
advertise: always
tier: strong
thinking: low
readonly: false
color: yellow
---

Body
`,
	"/tmp/svelte-worker.md",
	"user",
);

assert.ok(parsed);
assert.equal(parsed.advertise, "always");
assert.equal(parsed.tier, "strong");

const fallback = parseAgentFile(
	`---
name: scout
description: Broad recon
advertise: banana
tier: turbo
color: cyan
---

Body
`,
	"/tmp/scout.md",
	"user",
);

assert.ok(fallback);
assert.equal(fallback.advertise, "judgment");
assert.equal(fallback.tier, undefined);

const serialized = serializeAgent({
	name: "reviewer",
	description: "Review diffs",
	advertise: "judgment",
	tier: "fast",
	thinking: "medium",
	readonly: true,
	color: "orange",
	fork: false,
	spawn: [],
	systemPrompt: "Prompt",
});

assert.match(serialized, /^advertise: judgment$/m);
assert.match(serialized, /^tier: fast$/m);
assert.doesNotMatch(serialized, /^model:/m);

const defaultAdvertise = serializeAgent({
	name: "wizard-agent",
	description: "Created by wizard",
	thinking: "low",
	readonly: false,
	color: "cyan",
	fork: false,
	spawn: [],
	systemPrompt: "Prompt",
});

assert.match(defaultAdvertise, /^advertise: judgment$/m);

console.log("agents unit tests passed");
