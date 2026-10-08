# Implementer prompt

The implementer receives a self-contained Markdown brief and fresh code context.
It sees Plan context, not this session's conversation. Give it the report contract at the end.

## 1. Preamble

This block reuses the engine's workspace rules and the current report schema, with the agreed decisions extension.

<!-- generated: implementer-preamble -->
    SYSTEM: Write TypeScript code directly in the working directory.
    - Stay inside <project dir>: read, search, write and run shell commands only there, and never look for other copies of the project
    - Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks
    - Dependencies are already installed; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun)
    - Suggested files are guidance. Edit another ordinary project file when needed; name it with a reason in touchedNotSuggested.
    - Protected writes always need user confirmation: dependency manifests and lockfiles, CI configuration, env and key files, `.git`, `.splitbrief`.
    - Only an explicit user approval confirms a path and operation. A task request alone grants no confirmation.
    Use ESM imports with .js extensions. Follow the project's instruction files.
    Read the suggested files and the attached context before editing.
    Treat steps as guidance. Keep the accepted criteria and explicit exclusions.
    The orchestrator runs the checks after you hand back, and its verdict is the authority. Run no test, typecheck, lint, format, screenshot, render or other check command, not even the tests you write or a command the brief names.
    In these skills, render checks are unavailable. Do not claim render evidence.
    The report is advisory. Recorded checks decide whether the task passes.
    End with one JSON object and nothing after it. Use decisions: [] when you propose no deviation.
    {"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null,"decisions":[{"what":"<proposed deviation>","why":"<reason>"}]}
    If blocked, end with {"status":"blocked","question":"<question>","filesNeeded":["<file>"]} instead. The session consults at once.
    A decision proposes a deviation. The planner confirms how; the user decides changes to what.
<!-- /generated -->

Use the project's language and import convention. Apply the protected-operation rules in references/gates.md.

## 2. Body

Print the project name, task id and title, action, and suggested file list.
Send the Markdown brief directly. Keep its frontmatter and exact headings.
Refresh code for suggestedFiles and contextFiles from the task's current workspace.
For direct writers, omit Current Code; the tool reads its suggested files itself.
Use this section order:

<!-- generated: body-order -->
1. `### Description`
2. `### Signature`
3. `### Type Definitions`
4. `### Pattern`
5. `### Read-only context (do not modify) — <path>`
6. `### Implementation Steps`
7. `### Tests`
8. `### Scope`
9. `### Escalation`
10. `### Evidence`
11. `### Constraints`

`### Current Code` is never sent to a direct writer: the tool reads the file itself. A `### Read-only context (do not modify) — <path>` section carries the current code of each context file, one per file.
<!-- /generated -->

Inside Description, add read-only Plan context per references/brief-format.md.
Include the summary, confirmed decisions with task ids, and this task's criterion text.
Keep all TaskSpec fields in their mapped places. Use no extra frontmatter keys.
Keep the final report contract after Constraints. Send raw context sections even if the parser drops them.

## 3. Closing line

<!-- generated: closing-line -->
- one file: `Edit <file> directly in the working directory. The orchestrator runs the checks after you hand back, so run no test, typecheck, lint or other check command. End your reply with the one JSON report object the rules describe: status done with the files you changed, or status blocked with your question and the files you need.`
- more than one file: `Edit <file>, <second file> directly in the working directory. The orchestrator runs the checks after you hand back, so run no test, typecheck, lint or other check command. End your reply with the one JSON report object the rules describe: status done with the files you changed, or status blocked with your question and the files you need.`
<!-- /generated -->

## Completion report

Read the final object as an advisory report, using the contract in the preamble.
A missing or invalid report never fails a task by itself.
A `done` report with no changed file can mean the requested work already exists; recorded checks decide.
Record command, exit, terminal result, report, changed files, and outcome in `evidence.md`.
Record changed paths and unplanned ordinary-file reasons in `touched-files.md`.
The anchor file need not change. A successful process still needs session validation and registered checks.
Proposed decisions reach the ledger in references/planning.md before the next task dispatch.
