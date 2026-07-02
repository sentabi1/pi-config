import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface RoutingEvalCase {
	id: string;
	prompt: string;
	expect: string[];
	reject: string[];
	notes: string;
}

export interface RoutingEvalResult {
	id: string;
	pass: boolean;
	spawned: string[];
	missing: string[];
	forbidden: string[];
	exitCode: number | null;
	durationMs: number;
	notes: string;
}

const AGENT_NAMES = ["scout", "reviewer", "debugger", "svelte-worker", "test-writer", "planner", "worker"];

export const ROUTING_EVAL_CASES: RoutingEvalCase[] = [
	{
		id: "known-file-no-scout",
		prompt: "In extensions/subagents/guidance.ts, where is buildActiveAgentsBlock defined? Answer directly from that known file.",
		expect: [],
		reject: ["scout"],
		notes: "Familiarity tripwire: if the file is named, recon should stay inline.",
	},
	{
		id: "obvious-symbol-no-scout",
		prompt: "Where is the subagent tool registered in this extension? Use a quick direct search yourself; do not delegate unless many files are needed.",
		expect: [],
		reject: ["scout"],
		notes: "Over-delegation guard for a simple grep-scale lookup.",
	},
	{
		id: "broad-flow-scout",
		prompt: "Trace the lifecycle of a dashboard-started multi-agent sequence through the extension, from user interaction to child session execution and final output. Return the file:line path.",
		expect: ["scout"],
		reject: [],
		notes: "Breadth tripwire: cross-file unfamiliar tracing should delegate recon.",
	},
	{
		id: "broad-state-scout",
		prompt: "Map every place persistent subagent state is read, changed, and rendered in the dashboard. Return a concise architecture map.",
		expect: ["scout"],
		reject: [],
		notes: "Breadth tripwire for many-file state reconnaissance.",
	},
	{
		id: "svelte-edit-hard-trigger",
		prompt: "Make a trivial one-line text change in src/App.svelte. Route the Svelte edit through the right specialist even though it is tiny.",
		expect: ["svelte-worker"],
		reject: ["worker"],
		notes: "Capability trigger: Svelte file signal should fire regardless of size.",
	},
	{
		id: "svelte-rune-hard-trigger",
		prompt: "Update lib/counter.svelte.ts to use the correct Svelte 5 rune pattern for derived state.",
		expect: ["svelte-worker"],
		reject: ["worker"],
		notes: "Capability trigger for .svelte.ts modules.",
	},
	{
		id: "known-failure-debugger",
		prompt: "`npm test` just exited non-zero with TypeError: state.getGroups is not a function. There is a known failing symptom and no diff to review; root-cause the failure.",
		expect: ["debugger"],
		reject: ["reviewer"],
		notes: "Discipline event: known failing symptom belongs to debugger, not reviewer.",
	},
	{
		id: "review-before-commit",
		prompt: "Before committing the current subagents extension changes, review the diff for correctness and information-design regressions.",
		expect: ["reviewer"],
		reject: ["debugger"],
		notes: "Discipline event: clean diff vetting belongs to reviewer.",
	},
	{
		id: "trivial-diff-inline-review",
		prompt: "I changed one comment in README.md. Decide whether a specialist review is needed before saying done.",
		expect: [],
		reject: ["reviewer"],
		notes: "Review tripwire: trivial diffs should be reviewed inline.",
	},
	{
		id: "tests-primary-deliverable",
		prompt: "Write focused tests for keymap.ts dataToKeyId and keyIdMatches; tests are the primary deliverable.",
		expect: ["test-writer"],
		reject: ["worker"],
		notes: "Deliberate test-writing task.",
	},
	{
		id: "planning-artifact-only",
		prompt: "Produce a written implementation plan for adding per-agent advertise tiers. Do not edit files.",
		expect: ["planner"],
		reject: ["worker"],
		notes: "Planner is allowed when the plan artifact is the deliverable.",
	},
	{
		id: "implementation-worker",
		prompt: "Implement the already-planned change to add a small helper in guidance.ts and verify it.",
		expect: ["worker"],
		reject: ["planner"],
		notes: "Implementation after a plan belongs to worker, not planner.",
	},
];

export function parseSpawnedAgents(output: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const add = (name: string) => {
		if (!AGENT_NAMES.includes(name) || seen.has(name)) return;
		seen.add(name);
		found.push(name);
	};

	for (const match of output.matchAll(/"agent"\s*:\s*"([^"]+)"/g)) add(match[1]);
	for (const match of output.matchAll(/^SUBAGENT_EVAL_SPAWN\s+([a-z0-9-]+)$/gim)) add(match[1].toLowerCase());
	return found;
}

export function compareSpawned(spawned: string[], rule: Pick<RoutingEvalCase, "expect" | "reject">): Pick<RoutingEvalResult, "pass" | "missing" | "forbidden"> {
	const spawnedSet = new Set(spawned);
	const missing = rule.expect.filter((name) => !spawnedSet.has(name));
	const forbidden = rule.reject.filter((name) => spawnedSet.has(name));
	return { pass: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

function runOne(c: RoutingEvalCase, cwd: string): RoutingEvalResult {
	const started = Date.now();
	const proc = spawnSync("pi", ["-p", "-e", path.join(cwd, "index.ts"), "--no-extensions", "--no-session", c.prompt], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, SUBAGENT_ROUTING_EVAL: "1" },
		timeout: 180_000,
	});
	const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
	const spawned = parseSpawnedAgents(output);
	const compared = compareSpawned(spawned, c);
	return {
		id: c.id,
		...compared,
		spawned,
		exitCode: proc.status,
		durationMs: Date.now() - started,
		notes: c.notes,
	};
}

function main(): void {
	const cwd = path.dirname(fileURLToPath(import.meta.url));
	const args = new Set(process.argv.slice(2));
	const baselinePath = path.join(cwd, "routing-eval-baseline.json");
	const outputArg = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : "";
	const outputPath = outputArg ? path.resolve(cwd, outputArg) : "";
	const selected = process.argv.includes("--case")
		? new Set([process.argv[process.argv.indexOf("--case") + 1]])
		: null;
	const cases = selected ? ROUTING_EVAL_CASES.filter((c) => selected.has(c.id)) : ROUTING_EVAL_CASES;

	if (args.has("--list")) {
		for (const c of ROUTING_EVAL_CASES) console.log(`${c.id}: expect=[${c.expect.join(",") || "-"}] reject=[${c.reject.join(",") || "-"}]`);
		return;
	}

	const results: RoutingEvalResult[] = [];
	for (const c of cases) {
		const r = runOne(c, cwd);
		results.push(r);
		const status = r.pass ? "PASS" : "FAIL";
		console.log(`${status} ${r.id} spawned=[${r.spawned.join(",") || "-"}] missing=[${r.missing.join(",") || "-"}] forbidden=[${r.forbidden.join(",") || "-"}]`);
	}
	const report = {
		generatedAt: new Date().toISOString(),
		command: "pi -p -e index.ts --no-extensions --no-session <prompt>",
		results,
		summary: {
			total: results.length,
			passed: results.filter((r) => r.pass).length,
			failed: results.filter((r) => !r.pass).length,
		},
	};

	if (args.has("--write-baseline")) fs.writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
	if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

	console.log(`summary: ${report.summary.passed}/${report.summary.total} passed`);
	if (!args.has("--write-baseline") && report.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
