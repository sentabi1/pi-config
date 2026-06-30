import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";

function yamlString(v: string): string {
	// Quote if it contains characters that would break a bare YAML scalar.
	if (v === "" || /[:#\[\]{}",&*!|>%@`]/.test(v) || /^\s|\s$/.test(v) || /^[-?]/.test(v)) {
		return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return v;
}

export type WritableAgent = Pick<
	AgentConfig,
	"name" | "description" | "model" | "thinking" | "tools" | "readonly" | "color" | "fork" | "spawn" | "systemPrompt"
>;

export function serializeAgent(a: WritableAgent): string {
	const lines: string[] = ["---"];
	lines.push(`name: ${yamlString(a.name)}`);
	lines.push(`description: ${yamlString(a.description)}`);
	if (a.model) lines.push(`model: ${yamlString(a.model)}`);
	if (a.thinking) lines.push(`thinking: ${yamlString(a.thinking)}`);
	if (a.tools && a.tools.length > 0) lines.push(`tools: [${a.tools.map(yamlString).join(", ")}]`);
	if (a.readonly) lines.push("readonly: true");
	lines.push(`color: ${yamlString(a.color)}`);
	if (a.fork) lines.push("fork: true");
	if (a.spawn && a.spawn.length > 0) lines.push(`spawn: [${a.spawn.map(yamlString).join(", ")}]`);
	lines.push("---", "", a.systemPrompt.trim(), "");
	return lines.join("\n");
}

export function writeAgentFile(a: WritableAgent, dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const safe = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const file = path.join(dir, `${safe}.md`);
	fs.writeFileSync(file, serializeAgent(a), "utf-8");
	return file;
}

export function deleteAgentFile(filePath: string): void {
	if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
