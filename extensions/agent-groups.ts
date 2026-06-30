/**
 * Agent Groups Extension
 *
 * Groups tools into named sets that can be toggled on/off together.
 * Move tools between groups interactively with keyboard shortcuts.
 *
 * Commands:
 *   /group-create <name>      — Create a new empty group
 *   /group-rename <old> <new> — Rename an existing group
 *   /group-delete <name>      — Delete a group (tools unaffected)
 *   /group-toggle <name>      — Toggle a group on/off
 *   /group-list               — List all groups with their tools
 *   /group-add <tool> <group> — Add a tool to a group
 *   /group-remove <tool> <grp>— Remove a tool from a group
 *
 * Keybindings:
 *   Ctrl+Shift+G — Interactive group creation (name + pick tools)
 *   Ctrl+Shift+M — Movement mode (select tool → pick destination group)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentGroup {
	name: string;
	toolNames: string[];
	enabled: boolean;
}

interface GroupsState {
	groups: AgentGroup[];
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function agentGroupsExtension(pi: ExtensionAPI): void {
	// ── State ──────────────────────────────────────────────────────────────
	let groups: AgentGroup[] = [];
	let movementModeActive = false;

	// ── Persistence ────────────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry<GroupsState>("agent-groups", {
			groups: groups.map((g) => ({
				name: g.name,
				toolNames: [...g.toolNames],
				enabled: g.enabled,
			})),
		});
	}

	// ── Tool State Sync ────────────────────────────────────────────────────

	/**
	 * Build a map: toolName → group names that contain it.
	 */
	function getToolGroupMap(): Map<string, string[]> {
		const map = new Map<string, string[]>();
		for (const group of groups) {
			for (const toolName of group.toolNames) {
				const existing = map.get(toolName) ?? [];
				existing.push(group.name);
				map.set(toolName, existing);
			}
		}
		return map;
	}

	/**
	 * Get all tool names that belong to at least one group.
	 */
	function getManagedToolNames(): string[] {
		const names = new Set<string>();
		for (const group of groups) {
			for (const toolName of group.toolNames) {
				names.add(toolName);
			}
		}
		return Array.from(names).sort();
	}

	/**
	 * Recompute which tools should be active based on enabled groups,
	 * then apply via pi.setActiveTools().
	 *
	 * A tool is active if ANY enabled group contains it.
	 * A tool NOT managed by any group retains its current active state.
	 */
	function syncToolState(): void {
		const managedTools = new Set<string>();
		const enabledTools = new Set<string>();

		for (const group of groups) {
			for (const toolName of group.toolNames) {
				managedTools.add(toolName);
				if (group.enabled) {
					enabledTools.add(toolName);
				}
			}
		}

		const currentActive = pi.getActiveTools();
		const result: string[] = [];

		for (const toolName of currentActive) {
			if (!managedTools.has(toolName) || enabledTools.has(toolName)) {
				result.push(toolName);
			}
		}

		// Also add any enabled tools not already in the active set
		for (const toolName of enabledTools) {
			if (!result.includes(toolName)) {
				result.push(toolName);
			}
		}

		pi.setActiveTools(result);
	}

	// ── Session Restore ────────────────────────────────────────────────────

	/**
	 * Rebuild state from the latest "agent-groups" custom entry in the
	 * current branch. Falls back to defaults if no saved state found.
	 */
	function restoreFromBranch(ctx: ExtensionContext): void {
		const branchEntries = ctx.sessionManager.getBranch();
		let savedState: GroupsState | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "agent-groups") {
				const data = entry.data as GroupsState | undefined;
				if (data?.groups) {
					savedState = data;
				}
			}
		}

		if (savedState) {
			groups = savedState.groups.map((g) => ({
				name: g.name,
				toolNames: [...g.toolNames],
				enabled: g.enabled,
			}));
			syncToolState();
		} else {
			groups = [];
			// Don't reset tools — let them stay as default
		}

		movementModeActive = false;
	}

	// ── Status Display ─────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (movementModeActive) {
			ctx.ui.setStatus(
				"agent-groups",
				ctx.ui.theme.fg("warning", "🔀 Move ON"),
			);
			return;
		}

		const total = groups.length;
		if (total === 0) {
			ctx.ui.setStatus("agent-groups", undefined);
			return;
		}

		const enabled = groups.filter((g) => g.enabled).length;
		ctx.ui.setStatus(
			"agent-groups",
			ctx.ui.theme.fg("accent", `📋 ${enabled}/${total}`),
		);
	}

	// ── Commands ───────────────────────────────────────────────────────────

	pi.registerCommand("group-create", {
		description: "Create a new empty agent group. Usage: /group-create <name>",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				ctx.ui.notify("Usage: /group-create <name>", "error");
				return;
			}
			if (groups.some((g) => g.name === name)) {
				ctx.ui.notify(`Group '${name}' already exists`, "warning");
				return;
			}
			groups.push({ name, toolNames: [], enabled: true });
			persistState();
			syncToolState();
			updateStatus(ctx);
			ctx.ui.notify(`Group '${name}' created`, "info");
		},
	});

	pi.registerCommand("group-rename", {
		description: "Rename a group. Usage: /group-rename <oldName> <newName>",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/);
			if (!parts || parts.length < 2) {
				ctx.ui.notify("Usage: /group-rename <oldName> <newName>", "error");
				return;
			}
			const oldName = parts[0];
			const newName = parts.slice(1).join(" ");
			const group = groups.find((g) => g.name === oldName);
			if (!group) {
				ctx.ui.notify(`Group '${oldName}' not found`, "error");
				return;
			}
			if (groups.some((g) => g.name === newName && g.name !== oldName)) {
				ctx.ui.notify(`Group '${newName}' already exists`, "warning");
				return;
			}
			group.name = newName;
			persistState();
			updateStatus(ctx);
			ctx.ui.notify(`Group renamed: '${oldName}' → '${newName}'`, "info");
		},
	});

	pi.registerCommand("group-delete", {
		description:
			"Delete a group (tools are NOT disabled, just ungrouped). Usage: /group-delete <name>",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				ctx.ui.notify("Usage: /group-delete <name>", "error");
				return;
			}
			const index = groups.findIndex((g) => g.name === name);
			if (index === -1) {
				ctx.ui.notify(`Group '${name}' not found`, "error");
				return;
			}
			groups.splice(index, 1);
			persistState();
			syncToolState();
			updateStatus(ctx);
			ctx.ui.notify(`Group '${name}' deleted`, "info");
		},
	});

	pi.registerCommand("group-toggle", {
		description: "Toggle a group on or off. Usage: /group-toggle <name>",
		handler: async (args, ctx) => {
			const name = args?.trim();
			if (!name) {
				ctx.ui.notify("Usage: /group-toggle <name>", "error");
				return;
			}
			const group = groups.find((g) => g.name === name);
			if (!group) {
				ctx.ui.notify(`Group '${name}' not found`, "error");
				return;
			}
			group.enabled = !group.enabled;
			persistState();
			syncToolState();
			updateStatus(ctx);
			ctx.ui.notify(
				`Group '${name}': ${group.enabled ? "ON" : "OFF"}`,
				group.enabled ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("group-list", {
		description: "List all groups with their tools and enabled state",
		handler: async (_args, ctx) => {
			if (groups.length === 0) {
				ctx.ui.notify(
					"No groups. Use /group-create <name> or Ctrl+Shift+G to create one.",
					"info",
				);
				return;
			}

			const lines: string[] = [];
			for (const group of groups) {
				const status = group.enabled ? "✓" : "○";
				const toolList =
					group.toolNames.length > 0
						? group.toolNames.join(", ")
						: "(empty)";
				lines.push(`${status} ${group.name}: ${toolList}`);
			}
			ctx.ui.notify(`Agent Groups:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("group-add", {
		description:
			"Add a tool to a group. Creates the group if it doesn't exist. Usage: /group-add <tool> <group>",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/);
			if (!parts || parts.length < 2) {
				ctx.ui.notify("Usage: /group-add <tool> <group>", "error");
				return;
			}
			const toolName = parts[0];
			const groupName = parts.slice(1).join(" ");

			// Validate tool exists
			const allTools = pi.getAllTools();
			if (!allTools.some((t) => t.name === toolName)) {
				ctx.ui.notify(
					`Tool '${toolName}' not found. Available: ${allTools.map((t) => t.name).join(", ")}`,
					"error",
				);
				return;
			}

			// Find or create group
			let group = groups.find((g) => g.name === groupName);
			if (!group) {
				groups.push({
					name: groupName,
					toolNames: [toolName],
					enabled: true,
				});
				persistState();
				syncToolState();
				updateStatus(ctx);
				ctx.ui.notify(
					`Group '${groupName}' created with tool '${toolName}'`,
					"info",
				);
				return;
			}

			if (group.toolNames.includes(toolName)) {
				ctx.ui.notify(
					`Tool '${toolName}' is already in group '${groupName}'`,
					"warning",
				);
				return;
			}

			group.toolNames.push(toolName);
			persistState();
			if (group.enabled) syncToolState();
			updateStatus(ctx);
			ctx.ui.notify(`Added '${toolName}' to '${groupName}'`, "info");
		},
	});

	pi.registerCommand("group-remove", {
		description:
			"Remove a tool from a group. Usage: /group-remove <tool> <group>",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/);
			if (!parts || parts.length < 2) {
				ctx.ui.notify("Usage: /group-remove <tool> <group>", "error");
				return;
			}
			const toolName = parts[0];
			const groupName = parts.slice(1).join(" ");

			const group = groups.find((g) => g.name === groupName);
			if (!group) {
				ctx.ui.notify(`Group '${groupName}' not found`, "error");
				return;
			}

			const idx = group.toolNames.indexOf(toolName);
			if (idx === -1) {
				ctx.ui.notify(
					`Tool '${toolName}' not found in group '${groupName}'`,
					"warning",
				);
				return;
			}

			group.toolNames.splice(idx, 1);
			persistState();
			syncToolState();
			updateStatus(ctx);
			ctx.ui.notify(
				`Removed '${toolName}' from '${groupName}'`,
				"info",
			);
		},
	});

	// ── Shortcuts ──────────────────────────────────────────────────────────

	/**
	 * Ctrl+Shift+G — Interactive group creation.
	 *
	 * Flow:
	 *   1. Prompts for a group name.
	 *   2. Shows a tool-selector to optionally add tools.
	 *   3. Creates the group and syncs state.
	 */
	pi.registerShortcut(Key.ctrlShift("g"), {
		description: "Create a new agent group with tools",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Group creation requires TUI mode", "error");
				return;
			}

			// Step 1: Name the group
			const groupName = await ctx.ui.input("Group name:", "my-group");
			if (!groupName?.trim()) {
				ctx.ui.notify("Group creation cancelled", "warning");
				return;
			}
			if (groups.some((g) => g.name === groupName.trim())) {
				ctx.ui.notify(
					`Group '${groupName.trim()}' already exists`,
					"error",
				);
				return;
			}

			const name = groupName.trim();

			// Step 2: Optionally add a tool
			const allTools = pi.getAllTools();
			const toolChoices = allTools.map((t) => t.name);
			toolChoices.unshift("(skip — empty group)");
			const selected = await ctx.ui.select(
				`Optionally select a tool for '${name}':`,
				toolChoices,
			);

			const toolNames: string[] = [];
			if (selected && selected !== "(skip — empty group)") {
				toolNames.push(selected);
			}

			groups.push({ name, toolNames, enabled: true });
			persistState();
			syncToolState();
			updateStatus(ctx);
			ctx.ui.notify(
				`Group '${name}' created with ${toolNames.length} tool(s)`,
				"info",
			);
		},
	});

	/**
	 * Ctrl+Shift+M — Movement mode.
	 *
	 * Flow:
	 *   1. Activates movement mode (visual indicator in status bar).
	 *   2. Shows a list of all tools that belong to at least one group.
	 *   3. User picks a tool.
	 *   4. Shows a list of destination groups.
	 *   5. User picks a group.
	 *   6. Tool is removed from ALL its current groups and added to the destination.
	 *   7. State is persisted and tool visibility recalculated.
	 */
	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Move a tool between groups",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Movement mode requires TUI mode", "error");
				return;
			}

			if (groups.length === 0) {
				ctx.ui.notify(
					"No groups exist. Create one first with /group-create or Ctrl+Shift+G",
					"warning",
				);
				return;
			}

			// Step 1: Collect all tools that belong to at least one group
			const managedToolNames = getManagedToolNames();
			if (managedToolNames.length === 0) {
				ctx.ui.notify(
					"No tools in any group. Add tools first with /group-add",
					"warning",
				);
				return;
			}

			// Step 2: Activate movement mode visually
			movementModeActive = true;
			updateStatus(ctx);
			ctx.ui.notify("🔀 Movement mode — select a tool to move", "info");

			// Step 3: Pick a tool
			const pickedTool = await ctx.ui.select(
				"🔀 Select a tool to move:",
				managedToolNames,
			);

			if (!pickedTool) {
				ctx.ui.notify("Movement cancelled", "info");
				movementModeActive = false;
				updateStatus(ctx);
				return;
			}

			// Step 4: Find which groups currently contain this tool
			const toolGroupMap = getToolGroupMap();
			const currentGroups = toolGroupMap.get(pickedTool) ?? [];
			const availableGroups = groups.map((g) => g.name);

			if (availableGroups.length === 0) {
				ctx.ui.notify("No destination groups available", "error");
				movementModeActive = false;
				updateStatus(ctx);
				return;
			}

			// Step 5: Pick destination group
			const destGroupName = await ctx.ui.select(
				`🔀 Move '${pickedTool}' to which group?`,
				availableGroups,
			);

			if (!destGroupName) {
				ctx.ui.notify("Movement cancelled", "info");
				movementModeActive = false;
				updateStatus(ctx);
				return;
			}

			// Step 6: Execute the move
			const destGroup = groups.find((g) => g.name === destGroupName);
			if (!destGroup) {
				ctx.ui.notify(`Group '${destGroupName}' not found`, "error");
				movementModeActive = false;
				updateStatus(ctx);
				return;
			}

			// Remove tool from all current groups
			for (const group of groups) {
				const idx = group.toolNames.indexOf(pickedTool);
				if (idx !== -1) {
					group.toolNames.splice(idx, 1);
				}
			}

			// Add to destination group
			if (!destGroup.toolNames.includes(pickedTool)) {
				destGroup.toolNames.push(pickedTool);
			}

			persistState();
			syncToolState();
			updateStatus(ctx);

			const fromDesc =
				currentGroups.length > 0
					? ` from [${currentGroups.join(", ")}]`
					: " (was ungrouped)";
			ctx.ui.notify(
				`🔀 Moved '${pickedTool}'${fromDesc} → '${destGroupName}'`,
				"info",
			);

			movementModeActive = false;
			updateStatus(ctx);
		},
	});

	// ── Event Handlers ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
		updateStatus(ctx);
	});
}
