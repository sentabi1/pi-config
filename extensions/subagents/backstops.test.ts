import assert from "node:assert/strict";
import {
	appendDebuggerNudge,
	isSveltePath,
	isTestOrBuildCommand,
	svelteBackstopReason,
	toolInputPath,
} from "./backstops.ts";

assert.equal(isSveltePath("src/App.svelte"), true);
assert.equal(isSveltePath("src/state.svelte.ts"), true);
assert.equal(isSveltePath("src/state.svelte.js"), true);
assert.equal(isSveltePath("src/not-svelte.ts"), false);
assert.equal(toolInputPath({ path: "src/App.svelte" }), "src/App.svelte");
assert.equal(toolInputPath({ file_path: "src/App.svelte.ts" }), "src/App.svelte.ts");

assert.match(svelteBackstopReason("src/App.svelte"), /svelte-worker subagent/);

assert.equal(isTestOrBuildCommand("npm test"), true);
assert.equal(isTestOrBuildCommand("pnpm run build"), true);
assert.equal(isTestOrBuildCommand("npx tsc --noEmit"), true);
assert.equal(isTestOrBuildCommand("echo test"), false);

assert.deepEqual(
	appendDebuggerNudge([{ type: "text", text: "Command exited with code 1" }], "npm test"),
	[
		{
			type: "text",
			text: "Command exited with code 1\n\nSubagents nudge: `npm test` failed. Treat this as a known failure event and consider routing root-cause work through the debugger subagent.",
		},
	],
);

console.log("backstops unit tests passed");
