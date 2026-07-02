import assert from "node:assert/strict";
import type { AgentConfig } from "./agents.ts";
import { emptyUsage } from "./engine.ts";
import { RunRegistry } from "./registry.ts";

const agent = { name: "scout", color: "cyan" } as AgentConfig;
const registry = new RunRegistry();

// onFinish fires once per finished run, after final usage is applied.
const finished: Array<{ agent: string; cost: number; childCost: number }> = [];
registry.onFinish((rec) => finished.push({ agent: rec.agentName, cost: rec.usage.cost, childCost: rec.childCost }));

const rec = registry.create({ agent, task: "look around", mode: "single" });
assert.equal(rec.childCost, 0);
registry.setChildCost(rec, 0.02);
registry.finish(rec, { ok: true, finalText: "done", usage: { ...emptyUsage(), cost: 0.05 }, contextPercent: null });
assert.deepEqual(finished, [{ agent: "scout", cost: 0.05, childCost: 0.02 }]);

// totalCost includes nested spawn children.
assert.ok(Math.abs(registry.totalCost() - 0.07) < 1e-9);

const rec2 = registry.create({ agent, task: "again", mode: "single" });
registry.finish(rec2, { ok: false, finalText: "", usage: { ...emptyUsage(), cost: 0.01 }, contextPercent: null, error: "boom" });
assert.equal(finished.length, 2);
assert.equal(rec2.status, "error");
assert.ok(Math.abs(registry.totalCost() - 0.08) < 1e-9);

console.log("registry unit tests passed");
