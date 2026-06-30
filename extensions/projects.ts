import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi", "agent");
const FILE_PATH = join(PI_DIR, "PROJECTS.md");

function timestamp(): string {
  const now = new Date();
  const date = now.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("projects", {
    description:
      "Log a project: /projects <name> — /projects -view to list all",
    handler: async (args, ctx) => {
      const filePath = FILE_PATH;
      const input = (args ?? "").trim();

      if (!input) {
        return `Usage:\n  /projects <project name or note>  — append to PROJECTS.md\n  /projects -view                  — show all entries`;
      }

      // ── View mode ────────────────────────────────────────────────
      if (input === "-view") {
        if (!existsSync(filePath)) {
          ctx.ui.notify("No projects logged yet", "info");
          return;
        }
        const content = await readFile(filePath, "utf-8");
        if (!content.trim()) {
          ctx.ui.notify("No projects logged yet", "info");
          return;
        }
        return content.trim();
      }

      // ── Append mode ──────────────────────────────────────────────
      const line = `- ${input} _(logged ${timestamp()})_`;

      if (!existsSync(filePath)) {
        await writeFile(
          filePath,
          `# Projects\n\n${line}\n`,
          "utf-8",
        );
      } else {
        await appendFile(filePath, `\n${line}`, "utf-8");
      }

      ctx.ui.notify(`Logged to PROJECTS.md`, "info");
    },
  });
}
