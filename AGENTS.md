when asking about instructions, check /Users/jordan/.pi/agent/extensions first


# Workflow Instructions

## Completion Notifications

After finishing a task (or a significant subtask), explicitly summarize what was done and confirm all changes are complete. Use a clear format like:

> **Done:** [summary of what was accomplished]
> Files changed: [list of files]

## Extension Commits

- After making any change to a file under `extensions/` and verifying the work (subagent reviewer passes), **commit the changes locally** with a descriptive message summarizing what was changed and why.
- **Do not push** automatically. Only push when the user explicitly requests it.
- Commit message format: `extensions: <short description>` (e.g. `extensions: add auto-session-topic planning doc`).

