import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── Snippets ────────────────────────────────────────────────────────────

const BASIC = `# Project

This is a [pi](https://pi.dev) coding session.

## Guidelines

- Ask before running destructive commands.
- Keep code clean and well-documented.
`;

const SVELTE_SECTION = `
## Svelte

You have access to the Svelte MCP server via the \`mcp\` proxy tool. Use it for
Svelte 5 and SvelteKit documentation and code validation.

### Workflow

1. \`mcp({ server: "svelte" })\` — list available tools
2. \`mcp({ tool: "svelte_list_sections", args: '{}' })\` — discover relevant docs
3. \`mcp({ tool: "svelte_get_documentation", args: '{"section": ["$state", "transitions"]}' })\` — fetch docs
4. **Always run** \`mcp({ tool: "svelte_svelte_autofixer", args: '{"code": "...", "desired_svelte_version": 5}' })\` before returning Svelte code
5. Ask the user before generating a playground link
`;

// ── Helpers ─────────────────────────────────────────────────────────────

const SNIPPETS: Record<string, string> = {
  svelte: SVELTE_SECTION,
};

function helpText(): string {
  const keys = Object.keys(SNIPPETS);
  return [
    `Usage: /init [flag]`,
    ``,
    `  /init              Create a basic AGENTS.md if none exists`,
    `  /init -svelte      ${keys.includes("svelte") ? "Add or append Svelte section" : "Unavailable"}`,
    ``,
    `Available flags: ${keys.length ? keys.map((k) => `-${k}`).join(", ") : "none"}`,
  ].join("\n");
}

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Create or append to AGENTS.md with a framework/workflow section",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const agentsPath = join(cwd, "AGENTS.md");
      const flag = (args ?? "").trim().toLowerCase();

      // --help
      if (flag === "--help" || flag === "-h") {
        ctx.ui.notify("See output below for usage", "info");
        return helpText();
      }

      // No flag: create basic AGENTS.md
      if (!flag) {
        if (existsSync(agentsPath)) {
          ctx.ui.notify("AGENTS.md already exists", "warning");
          return;
        }
        await writeFile(agentsPath, BASIC, "utf-8");
        ctx.ui.notify("Created AGENTS.md", "info");
        return;
      }

      // Parse -flag
      if (!flag.startsWith("-")) {
        ctx.ui.notify(`Unknown: "${flag}". Use -svelte or no flag`, "error");
        return;
      }

      const key = flag.slice(1); // "svelte"
      const snippet = SNIPPETS[key];

      if (!snippet) {
        const available = Object.keys(SNIPPETS).map((k) => `-${k}`).join(", ");
        ctx.ui.notify(
          `Unknown section "${key}". Available: ${available}`,
          "error",
        );
        return;
      }

      // Create or append
      if (!existsSync(agentsPath)) {
        await writeFile(agentsPath, snippet.trimStart() + "\n", "utf-8");
        ctx.ui.notify(`Created AGENTS.md with ${key} section`, "info");
      } else {
        const current = await readFile(agentsPath, "utf-8");
        // Avoid duplicates: check if the section marker already exists
        const marker = `## ${key.charAt(0).toUpperCase() + key.slice(1)}`;
        if (current.includes(marker)) {
          ctx.ui.notify(
            `"${marker}" section already exists in AGENTS.md`,
            "warning",
          );
          return;
        }
        await appendFile(agentsPath, snippet, "utf-8");
        ctx.ui.notify(`Appended ${key} section to AGENTS.md`, "info");
      }
    },
  });
}
