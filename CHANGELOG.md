# Changelog

## [0.2.0]

The first release on npm: `npm install -g splitbrief`. It runs on macOS, Linux and inside WSL, with Node.js 22 or 24.

### Added

- One tool plans and reviews, another one builds. The planner reads your repo and writes Task Briefs, the implementer builds them one at a time in a fresh context, and the reviewer reads the diff. Each of these three seats can be Claude Code, Codex, OpenCode, Kilo Code, Cursor, Command Code, Antigravity, any OpenAI-compatible API or a command of your own. If you don't want a review, set REVIEW to None.
- Every run starts with one planning session. The planner can ask up to two rounds of questions, each with a default, and then hands back a plan. You approve it, ask for changes or edit `plan.json` before anything gets built. `splitbrief spec` stops after the plan.
- The build happens in a worktree or a staged copy, not in your checkout. Once the review passes, Apply brings the result in with a backup and merges whatever you edited in the meantime. If you'd rather have the implementer work in your checkout, set `workflow.isolation: none`.
- The plan names the checks your project already runs, like `npm test`, `mvn test` or `make check`, and SPLITBRIEF runs them. A test that was already failing before the run is reported as pre-existing and isn't blamed on the new code. The run ends with a short summary, and `ctrl+a` opens the full record.
- When a brief fails, the planner looks at it and retries with guidance, rewrites the brief, splits it or asks you. Pick Decide for me and the run won't ask you anything until it ends. You can also type to the working seat at any time, and it reads your message at its next break.
- Runs are saved as they go. Stop one from the `esc` menu, close the terminal, and continue later with `splitbrief continue`, `/resume` or Enter, or from a script with `--plain` or `--json`. A seat that hits its usage limit moves to the fallback you set in Settings, or waits for the reset when the tool names one.
- The same pipeline ships as agent skills (`npx skills add b4r7x/splitbrief`), so Claude Code, Codex, Cursor, Copilot and the other tools can run it from inside a session.

### Removed

- The workflow modes (`quick`, `standard`, `speckit` and `instant`) and the escalation ladder. One way to plan turned out to be enough, and a failed brief now goes straight to the planner instead of climbing rungs to get there.
- Cost predictions, budget gates and savings figures, because a guess is not a bill. When prices are known, the run shows what it spent.
- Sticky approvals and `--yolo`. Only the plan and a write to a protected path ask now, so there is little left to skip.
- Detached runs, the RPC and MCP servers, the `explain`, `handoff`, `export` and `stats` commands, the `aider` tool and the `agent-sdk` runner. They were more code than use. Aider still runs as a `shell` runner.
