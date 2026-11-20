# Changelog

## [Unreleased]

### Changed

- Setup and the tool picker show "Needs sign-in" when a tool needs you to sign in.
- Review packets list BUILD routes in settlement order, including briefs a validation hook skips after BUILD runs, and explain routing refusals.
- The transcript shows each plan’s goal, brief count, criteria count and file links together. Older runs show one link for each planning document.
- Menu shortcuts stay visible while you type. Command lists align names and descriptions. Overlays keep their full height as you filter. Command suggestions and confirmation panels span the full width of the input. Page Up and Page Down reveal the rest of a long confirmation.
- Messages are centered above the input. They now look the same on Home, on the run screen, in Settings, in Setup and in the tool picker: a small box in the colour of the message, with ✗ for a failure and ⚠ for a refusal or a step you need to take. A long message drops the box for coloured edges before it is cut.
- A long path in a message keeps its first folder and its file name instead of breaking in the middle of a folder name.
- "Tool check failed" and "Tools not checked" now show as that message above the input on Home, at every terminal size. While the first check runs, Home shows only "Checking your tools…" in a small box.
- On a small terminal Home shows a one-row `splitbrief` heading where the logo does not fit, and the Recent sessions list uses it when that shows more sessions.

### Fixed

- Short recovery panels keep the question in view as you scroll through the actions. Page Up and Page Down let you read a question that spans several screens.
- The command palette finds abbreviations across words in command descriptions and hides custom actions that name unknown commands.
- If you skip the last brief and every brief was skipped, the run ends without a final review. The Skip brief row warns you before you choose it.
- Recovery shows the field that needs attention, names the checkout when a tool writes outside it, and keeps the original reason when you skip a brief.
- The run screen shows which work stopped and which briefs belong to an earlier plan. Command suggestions cover the action panel, and a run with no changed files offers **Close run**.
- A blocked start keeps your draft and attachments on Home. Press Enter to retry with the current draft or Ctrl+D to read the diagnostic. A blocked Continue keeps the conversation visible.
- Narrow halt menus keep action names and make room for the reason. The stop menu shows the full pause action at 60 columns.
- Completion counts hidden entries and highlights every visible line of the selected entry. Each Help shortcut starts on its own row.
- Setup keeps crew presets reachable on small terminals and lets you choose a remembered crew after a failed refresh. Continue checks the selected seats.
- The runner picker keeps tool names and sign-in status readable at narrow widths. A refused config edit names the field to remove.
- Clear Context length, Prompt budget or Test command in Settings and press Enter to restore `auto`.
- Review packets count validation results for the briefs in the current plan.
- Review packets keep the BUILD route when you skip a brief that already ran.
- The closed run summary shows the findings that blocked review. Queued messages show whether they reached a seat, and the brief count appears during Build.
- If Skip brief finds a moved project, the run screen shows where the run started and offers End run.
- Paused runs show the Enter key to continue. The consult status tells you when the planner starts answering.
- Delivered messages keep a label, and narrow summary folds put blocking findings ahead of files and notes.
- Terminal editors get the terminal when you edit a plan or show a diff. Graphical editors keep the workflow visible and show what happens when you close the file or quit the app.
- The transcript and plain output use the same fix-check results. Closed runs show a short summary for older reviewer check failures.
- Questions about dropped checks show each check's command or file. Settings and readiness both call the checks before final review End-of-run checks.
- Home keeps room for PLAN, BUILD and REVIEW above recent sessions. Narrow run screens use short tool names and wrap the crew when needed. Closed summaries keep the recorded crew visible.
- Plan approval keeps the plan text visible when a command is refused. Refused commands and duplicate fallback choices show a warning.
- Home keeps tool-check failures visible while you browse recent sessions. Draft errors appear above the input, with a link to the file when its path is shortened.
- Older review findings keep the reason SPLITBRIEF could not verify a failure at the run base.
- Short closed summaries keep the Session row when the header already names the tools. Compact crew lines use consistent tool names.
- The run screen gives old draft removal a short notice and keeps the details in the transcript. Long file notices keep more of the message.

### Removed

- Removes the usage screen and cost copying. JSON output and hook events omit token counts and cost fields.
- Custom command setup moves to your project configuration. The seat picker and CLI help omit those options.
- Temperature, API call Timeout and Compaction format move from Settings to your project configuration.
- SPLITBRIEF no longer sends a repository map to planners. API planners receive project instructions, attachments, and the contents of files named in the request.

## [0.2.0]

The first release on npm: `npm install -g splitbrief`. It runs on macOS, Linux and inside WSL, with Node.js 22 or 24.

### Added

- One tool plans and reviews, another one builds. The planner reads your repo and writes Task Briefs, the implementer builds them one at a time in a fresh context, and the reviewer reads the diff. Each of these three seats can be Claude Code, Codex, OpenCode, Kilo Code, Cursor, Command Code, Antigravity, any OpenAI-compatible API or a command of your own. If you don't want a review, set REVIEW to None.
- Every run starts with one planning session. The planner can ask up to two rounds of questions, each with a default, and then hands back a plan. You approve it, ask for changes or edit `plan.json` before anything gets built. `splitbrief spec` stops after the plan.
- Run several workflows in one project. Each run starts planning in its own worktree or staged copy. Apply merges the reviewed result into your checkout and saves a backup. Set `workflow.isolation: none` to let a run work directly in your checkout.
- The plan names the checks your project already runs, like `npm test`, `mvn test` or `make check`, and SPLITBRIEF runs them. A test that was already failing before the run is reported as pre-existing and isn't blamed on the new code. The run ends with a short summary, and `ctrl+a` opens the full record.
- When a brief fails, the planner looks at it and retries with guidance, rewrites the brief, splits it or asks you. Pick Decide for me and the run won't ask you anything until it ends. You can also type to the working seat at any time, and it reads your message at its next break.
- Runs are saved as they go. Stop one from the `esc` menu, close the terminal, and continue later with `splitbrief continue`, `/resume` or Enter, or from a script with `--plain` or `--json`. Use `splitbrief resume <session-id>` in another terminal to watch a run without taking control. A seat that hits its usage limit moves to the fallback you set in Settings, or waits for the reset when the tool names one.
- The same pipeline ships as agent skills (`npx skills add b4r7x/splitbrief`), so Claude Code, Codex, Cursor, Copilot and the other tools can run it from inside a session.

### Removed

- The workflow modes (`quick`, `standard`, `speckit` and `instant`) and the escalation ladder. One way to plan turned out to be enough, and a failed brief now goes straight to the planner instead of climbing rungs to get there.
- Cost predictions, budget gates and savings figures, because a guess is not a bill. When prices are known, the run shows what it spent.
- Sticky approvals and `--yolo`. Only the plan and a write to a protected path ask now, so there is little left to skip.
- Detached runs, the RPC and MCP servers, the `explain`, `handoff`, `export` and `stats` commands, the `aider` tool and the `agent-sdk` runner. They were more code than use. Aider still runs as a `shell` runner.
