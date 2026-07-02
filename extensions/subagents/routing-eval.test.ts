import assert from "node:assert/strict";
import {
	ROUTING_EVAL_CASES,
	compareSpawned,
	parseSpawnedAgents,
} from "./routing-eval.ts";

assert.equal(ROUTING_EVAL_CASES.length, 12);
assert.ok(ROUTING_EVAL_CASES.every((c) => c.id && c.prompt && c.expect.length + c.reject.length > 0));

assert.deepEqual(parseSpawnedAgents(`thinking...\nsubagent scout\nresult\nsubagent reviewer\n`), []);

assert.deepEqual(
	parseSpawnedAgents(`tool: subagent {"agent":"svelte-worker","task":"edit"}\nsubagent-output debugger\n`),
	["svelte-worker"],
);

assert.deepEqual(parseSpawnedAgents(`SUBAGENT_EVAL_SPAWN scout\nSUBAGENT_EVAL_SPAWN reviewer\n`), ["scout", "reviewer"]);
assert.deepEqual(parseSpawnedAgents(`You should use reviewer subagent for this.`), []);

assert.deepEqual(compareSpawned(["scout"], { expect: ["scout"], reject: ["reviewer"] }), {
	pass: true,
	missing: [],
	forbidden: [],
});

assert.deepEqual(compareSpawned(["scout", "reviewer"], { expect: ["svelte-worker"], reject: ["scout"] }), {
	pass: false,
	missing: ["svelte-worker"],
	forbidden: ["scout"],
});

console.log("routing eval unit tests passed");
