import type { AgentConfig } from "./agents.ts";
import { type DispatchDeps, dispatchChain } from "./tool.ts";

/** An ephemeral, in-memory chain "armed" from the dashboard. The next typed
 * message is routed through it, then it disarms. Not persisted. */
export class ArmedChain {
	private names: string[] = [];
	private listeners = new Set<() => void>();

	set(names: string[]): void {
		this.names = [...names];
		this.notify();
	}
	get(): string[] {
		return [...this.names];
	}
	clear(): void {
		if (this.names.length) {
			this.names = [];
			this.notify();
		}
	}
	isArmed(): boolean {
		return this.names.length > 0;
	}
	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private notify(): void {
		for (const cb of this.listeners) cb();
	}
}

/** Returns "handled" if the message was routed into the armed chain (async,
 * non-blocking), else "continue". */
export function routeArmedChain(
	text: string,
	armed: ArmedChain,
	deps: DispatchDeps,
	resolve: (name: string) => AgentConfig | undefined,
	notify: (msg: string, type?: "info" | "warning" | "error") => void,
): "handled" | "continue" {
	if (!armed.isArmed()) return "continue";
	const names = armed.get();
	const agents = names.map(resolve);
	if (agents.some((a) => !a)) {
		notify(`Sequence has an unknown agent (${names.join(" → ")}); cleared.`, "warning");
		armed.clear();
		return "continue";
	}
	armed.clear();
	notify(`Running sequence: ${names.join(" → ")}…`, "info");
	const steps = (agents as AgentConfig[]).map((a, i) => ({
		agent: a,
		task: i === 0 ? text : `${text}\n\nPrevious step output:\n{previous}`,
	}));
	// Fire-and-forget: non-blocking. Errors surfaced via notify, result into transcript.
	void dispatchChain(deps, steps).then((r) => {
		notify(r.ok ? `Sequence done: ${names.join(" → ")}` : `Sequence failed: ${r.error ?? "see panel"}`, r.ok ? "info" : "error");
		deps.showOutput?.(`sequence (${names.join(" → ")})`, r);
	});
	return "handled";
}
