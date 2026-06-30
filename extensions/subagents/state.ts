import * as fs from "node:fs";
import * as path from "node:path";

const STATE_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "state.json");

export interface AgentGroup {
	name: string;
	members: string[];
}

/** Persistent state: active toggles, agent groups, and keybind overrides.
 * Stored in state.json. */
export class SubagentState {
	private active = new Set<string>();
	private groups: AgentGroup[] = [];
	private keybinds: Record<string, string> = {};
	/** When true, ALL discovered agents are advertised to the main model every turn
	 * (proactive auto-delegation), regardless of per-agent toggles. */
	private advertiseAll = true;
	private listeners = new Set<() => void>();
	private file: string;

	constructor(file: string = STATE_PATH) {
		this.file = file;
		try {
			const data = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (Array.isArray(data.active)) for (const n of data.active) this.active.add(String(n));
			if (Array.isArray(data.groups)) {
				this.groups = data.groups
					.filter((g: any) => g && typeof g.name === "string")
					.map((g: any) => ({ name: g.name, members: Array.isArray(g.members) ? g.members.map(String) : [] }));
			}
			if (data.keybinds && typeof data.keybinds === "object") {
				for (const [k, v] of Object.entries(data.keybinds)) if (typeof v === "string") this.keybinds[k] = v;
			}
			if (typeof data.advertiseAll === "boolean") this.advertiseAll = data.advertiseAll;
		} catch {
			/* no state yet */
		}
	}

	// --- auto-delegation mode ---
	getAdvertiseAll(): boolean {
		return this.advertiseAll;
	}
	setAdvertiseAll(on: boolean): void {
		this.advertiseAll = on;
		this.save();
		this.notify();
	}

	// --- active toggles ---
	isActive(name: string): boolean {
		return this.active.has(name);
	}
	activeNames(): string[] {
		return [...this.active];
	}
	setActive(name: string, on: boolean): void {
		if (on) this.active.add(name);
		else this.active.delete(name);
		this.save();
		this.notify();
	}
	toggle(name: string): boolean {
		const next = !this.active.has(name);
		this.setActive(name, next);
		return next;
	}

	// --- groups ---
	getGroups(): AgentGroup[] {
		return this.groups.map((g) => ({ name: g.name, members: [...g.members] }));
	}
	addGroup(name: string, members: string[] = []): void {
		const n = name.trim();
		if (!n || this.groups.some((g) => g.name === n)) return;
		this.groups.push({ name: n, members: [...members] });
		this.save();
		this.notify();
	}
	deleteGroup(name: string): void {
		this.groups = this.groups.filter((g) => g.name !== name);
		this.save();
		this.notify();
	}
	setGroupMembers(name: string, members: string[]): void {
		const g = this.groups.find((x) => x.name === name);
		if (g) {
			g.members = [...members];
			this.save();
			this.notify();
		}
	}
	/** Update active-set + group memberships when an agent is renamed. */
	renameAgentReferences(oldName: string, newName: string): void {
		if (this.active.has(oldName)) {
			this.active.delete(oldName);
			this.active.add(newName);
		}
		for (const g of this.groups) g.members = g.members.map((m) => (m === oldName ? newName : m));
		this.save();
		this.notify();
	}

	renameGroup(oldName: string, newName: string): void {
		const n = newName.trim();
		const g = this.groups.find((x) => x.name === oldName);
		if (g && n && !this.groups.some((x) => x.name === n)) {
			g.name = n;
			this.save();
			this.notify();
		}
	}

	// --- keybinds ---
	getKeybinds(): Record<string, string> {
		return { ...this.keybinds };
	}
	setKeybind(action: string, keyId: string): void {
		this.keybinds[action] = keyId;
		this.save();
		this.notify();
	}
	resetKeybinds(): void {
		this.keybinds = {};
		this.save();
		this.notify();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private notify(): void {
		for (const cb of this.listeners) cb();
	}
	private save(): void {
		try {
			fs.writeFileSync(
				this.file,
				JSON.stringify({ active: [...this.active], groups: this.groups, keybinds: this.keybinds, advertiseAll: this.advertiseAll }, null, 2),
				"utf-8",
			);
		} catch {
			/* best-effort */
		}
	}
}
