import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aggregateRunStats, appendRunLog, entryFromRecord, formatRunStats, readRunLog, type RunLogEntry } from "./runlog.ts";
import type { RunRecord } from "./registry.ts";

const entry = (over: Partial<RunLogEntry>): RunLogEntry => ({
	ts: "2026-07-02T00:00:00.000Z",
	agent: "scout",
	mode: "single",
	status: "done",
	durationMs: 30_000,
	cost: 0.01,
	input: 1000,
	output: 400,
	tools: 5,
	task: "find things",
	...over,
});

// entryFromRecord: usage + childCost roll into cost; task is one line, capped.
const rec: RunRecord = {
	id: 1,
	agentName: "worker",
	color: "green",
	task: `implement\nthe ${"x".repeat(100)}`,
	status: "done",
	usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 2, toolCalls: 3 } as RunRecord["usage"],
	contextPercent: 10,
	startedAt: 1000,
	endedAt: 61_000,
	mode: "single",
	childCost: 0.02,
};
const e = entryFromRecord(rec);
assert.equal(e.agent, "worker");
assert.equal(e.durationMs, 60_000);
assert.ok(Math.abs(e.cost - 0.07) < 1e-9);
assert.ok(!e.task.includes("\n"));
assert.equal(e.task.length, 80);

// append/read round-trip, skipping corrupt lines; missing file = [].
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runlog-test-")), "runs.jsonl");
assert.deepEqual(readRunLog(tmp), []);
appendRunLog(tmp, entry({}));
appendRunLog(tmp, entry({ agent: "worker", cost: 0.1, status: "error" }));
fs.appendFileSync(tmp, "not json\n{\"broken\":\n");
appendRunLog(tmp, entry({ agent: "worker", cost: 0.2, durationMs: 90_000, output: 800 }));
const read = readRunLog(tmp);
assert.equal(read.length, 3);

// aggregate: grouped per agent, sorted by total cost desc, failure count kept.
const stats = aggregateRunStats(read);
assert.deepEqual(stats.map((s) => s.agent), ["worker", "scout"]);
const worker = stats[0];
assert.equal(worker.runs, 2);
assert.equal(worker.failed, 1);
assert.ok(Math.abs(worker.totalCost - 0.3) < 1e-9);
assert.ok(Math.abs(worker.avgCost - 0.15) < 1e-9);
assert.equal(worker.avgDurationMs, 60_000);
assert.equal(worker.avgOutput, 600);

// format: header + one row per agent + totals footer; empty log has a friendly line.
const lines = formatRunStats(stats);
assert.equal(lines.length, 4);
assert.match(lines[0], /agent\s+runs\s+fail/);
assert.match(lines[1], /^worker\s/);
assert.match(lines[3], /3 runs · \$0\.3100 total/);
assert.deepEqual(formatRunStats([]), ["No subagent runs logged yet."]);

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log("runlog unit tests passed");
