# SPLITBRIEF as agent skills

The four pipeline skills run one planning session, Markdown briefs, deterministic checks, planner consults and evidence-bound review.
The loading session is the planner. It spawns one headless implementer CLI per task.
The reviewer reads the candidate without editing it; this session reviews when no reviewer seat is configured.
The skills require no SPLITBRIEF CLI.
The CLI also owns sessions, the TUI, isolation, snapshots and token accounting.
The skills execute in the working tree.

## Install

    npx skills add b4r7x/splitbrief

Non-interactive, one skill into several agents:

    npx skills add b4r7x/splitbrief -s splitbrief -a claude-code -a cursor -a opencode -a codex -a github-copilot -a antigravity -a command-code -a kilo -y

skills.sh installs into each agent's own skills directory (`.claude/skills`, `.agents/skills`, `.commandcode/skills`, `.kilo/skills`, `.kilocode/skills`, …). Add `-g` for a user-wide install. The picker lists the skills under one `Splitbrief` group row (from `.claude-plugin/marketplace.json`).

Claude Code can also take the repo as a plugin marketplace, which installs the four skills at once and updates them together:

    /plugin marketplace add b4r7x/splitbrief
    /plugin install splitbrief@splitbrief

### Installers and `scripts/`

The waiter (`wait-attempt.sh`) and the stop-hook gate (`splitbrief-gate.sh`) ship inside the skill directories, so an installer that copied only `SKILL.md` and `references/` would leave the run protocol without its blocking primitive. Every installer below preserves `scripts/` with its executable bit.

| Installer | Command | Result | Fallback |
|---|---|---|---|
| skills.sh | `npx skills add b4r7x/splitbrief -s splitbrief-run -a claude-code -y`, or a local clone path in place of `b4r7x/splitbrief` | `.claude/skills/splitbrief-run/scripts/wait-attempt.sh`, mode `755` | not needed |
| Claude Code plugin | `/plugin install splitbrief@splitbrief` | `scripts/` under every script-carrying skill in the plugin cache, mode `755` | not needed |
| Manual copy | `cp -R skills/splitbrief-run ~/.claude/skills/` | the directory as it stands in the repo | not needed |

## The skills

- `splitbrief`: plan this here, let another tool build it, then review and fix it.
- `splitbrief-brief`: plan only and write briefs; stop before implementation.
- `splitbrief-run`: build an existing plan or brief set, continue a stopped run, fix a failed review, or run one task.
- `splitbrief-review`: review someone else's build against its intent; leave source files unchanged.

`splitbrief-run` continues through review and bounded fixes by default.
It announces that scope and prints the selected stages before dispatch.
A run directory resumes its saved stage, including review or fixes, while preserving attempts, bounds, decisions, and completed tasks.
It reconciles active processes before spawning. `--status` inspects the saved run without dispatch.
`error: <review.md>` reads the saved review fix part and appends fix tasks with new ids.
On continuation, use the fix part from `review.json` first.
If absent, read `fixTasks`, `rejected`, `verify` and `ask` from an older run's saved `triage.json`.
Use those fields as that review's fix part; carry rejected ids and reasons into the next review packet.
The session writes no new `triage.json`. Reading the saved fix part spends no planner call.
The reviewer runs the review again only when neither file holds a fix part.
The session then validates the fixes and reviews again.
An older run whose next stage is `triage` follows the same rule. It makes no second planner call.
A single brief file selects one task. Unmet dependencies pause execution; completion applies to that selection only.
A prose plan becomes the typed contract before dispatch, with its stated outcome preserved.
A review request alone never authorizes source changes or execution of its appended fixes.

The family routing table lives only in [family-map.md](../skills/splitbrief/references/family-map.md).

## Grammar

    <skill> [impl=<tool>[:<model>][@<effort>]] [review=<tool>[:<model>][@<effort>]] [cadence=end|task] [--ask [--yes]] [--status] <input>

Choose one of the four entry names for `<skill>`. `--status` applies to `splitbrief-run`.

- Tools: `claude`, `codex`, `opencode`, `copilot`, `kilo`, `cursor`, `cmd`, `agy`.
- Split a seat on the first `:` and the last `@`.
- `impl=opencode:opencode-go/kimi-k3@high` selects tool `opencode`, model `opencode-go/kimi-k3` and effort `high`.
- `review=` selects a seat. `cadence=` selects timing. Keep the keys separate.
- Resolve a reviewer from the request, saved run, or CLI seats; otherwise the session holds the review seat.
- Resolve an absent implementer from `.splitbrief/config.yaml` CLI seats; otherwise ask once from the detected tools.
- Accept natural phrasing. Print the normalized crew, cadence, and selected stages before dispatch.

Examples:

    splitbrief impl=cmd:deepseek/deepseek-v4-flash@high "add a health endpoint"
    splitbrief --ask impl=opencode:opencode-go/kimi-k3 review=codex:gpt-6.1-sol cadence=task notes/feature.md
    splitbrief-brief "extract the retry helper and update its callers and tests"
    splitbrief-run impl=codex@high cadence=end .splitbrief/runs/<stamp>-retry-helper/
    splitbrief-run impl=cmd notes/existing-plan.md
    splitbrief-run impl=codex error: .splitbrief/runs/<stamp>-retry-helper/review.md
    splitbrief-run impl=codex .splitbrief/runs/<stamp>-retry-helper/briefs/T001.md
    splitbrief-run --status .splitbrief/runs/<stamp>-retry-helper/
    splitbrief-review review=claude:opus intent: .splitbrief/runs/<stamp>-retry-helper/ scope: branch

### Inputs and brief contract

`<input>` can be task text or a request file for planning, or a saved plan, run directory, brief set, or single brief for execution.
`splitbrief-run` also accepts `error: <review.md>` for repair and `--status <run dir>` for inspection.
Standalone review takes `intent:` and `scope:` as described in its entry file.

The Markdown contract and BRIEF_HOME_OF_FIELD placement live in [brief-format.md](../skills/splitbrief/references/brief-format.md).
The typed plan and conversion procedure live in [planning.md](../skills/splitbrief/references/planning.md).
The implementer receives the self-contained raw Markdown brief. The planner retains typed fields in `plan.json`.
CLI `tasks.md` requires its adjacent `plan.json`; it omits criteria, protected operations, and numeric batches.

## Flags and the review cadence

`impl=` selects the implementer. `review=<seat>` selects a read-only reviewer independently of `cadence=`.
`cadence=end|task` defaults to `end`.
`--ask` opens one optional approval after the plan and briefs are rendered, or before standalone review.
Default execution prints the plan and selected stages, then runs.
`--status` is inspection through `splitbrief-run`; it runs no implementer, reviewer, or validation command.
`--yes` requires `--ask` and permits ordinary gate-tooling repairs after approval. It never confirms protected writes implicitly.
Approval options never bypass protected-action confirmation.
An explicit plan approval confirms only the listed protected paths and operations. Without approval, protected writes still ask.

| Cadence | Review moments | Scope |
|---|---|---|
| end, default | after all tasks and after each fix cycle | all current tasks and accepted criteria |
| task | additionally after each completed task | completed tasks and criteria due so far; pending criteria stay pending |

There is no batch review cadence and no batch-boundary suite.
Before final review, run every registered check on the current candidate. Then the reviewer makes the plan call: it reads the project and chooses the reviewer checks that verify the change, at most 6, with a reason each. It names each related test it does not run, or the reason it chose none. Run the reviewer checks in order under the reviewer command policy, and refuse a reviewer check whose package script, task file, build wrapper or interpreter script this run changed or the run base does not hold. Stop at the first reviewer check with new failures. A task-cadence review chooses only the tests related to the task's changed files. Re-run a red reviewer check at the run base with the same command text. Report matching failures as pre-existing. A timeout, or a red with no failure keys, is never pre-existing: report it as not verified at the run base. Send every new or not verified red to the reviewer as a pending input. A failed plan call (a transport error or a protocol error) halts the review the same way a failed verdict call does; it is never a pass. With `validation.end_checks: false`, no reviewer check runs; plan and task checks still run.
Fix cycles run until the review passes, at end and at task cadence. A review answer that fixes nothing, or a fix cycle that leaves the same blockers, halts as needs you.
The skills run the same review as the CLI: the end/task cadence, the decisions ledger, one typed review answer with verdict and fix work, and reviewer questions about product changes.
Render checks run only in the CLI.

The reviewer returns tasks, criteria, findings, fixTasks, rejected, verify and ask in one answer matching `ReviewAnswerSchema`.
The session saves the whole answer in `review.json`. There is no separate planner call for fix work.
The next review packet carries rejected finding ids and reasons.
Still-red fix tasks consult the reviewer. Plan tasks consult the planner.
Reviewer consults and review answers spend no planner decision.

Seat calls have no default deadline. Only an explicit `timeout` or `idleKillMs` limits a subprocess call.
The session warns after output silence reaches `idleWarnMs`, default `300000` ms. The warning never kills the call.
The waiter accepts `--deadline <seconds>` for an explicit limit. Without it, the waiter never kills the call.
Two consecutive timeouts on one brief with an explicit limit still halt the run.

## Engine command mapping

| Engine command | User intent |
|---|---|
| `spec` | `splitbrief-brief`, planning only. |
| `start` | `splitbrief`, the full pipeline. |
| `resume` | `splitbrief-run` continuation from the saved stage. |
| `status` | Inspection, equivalent in intent to `splitbrief-run --status`. |

These mappings describe requests, not state compatibility.
Standalone skill records cannot serve as engine session state for `resume`.

## Recovery and review

Recovery actions, persistent bounds, and review fix work live in [recovery.md](../skills/splitbrief/references/recovery.md).
Confirmed deviations reach later briefs, consults, and reviews through the decisions ledger in planning.md.
Recorded validation decides task completion. The implementer report remains advisory.
The review contract derives pass from complete task and criterion coverage with no blocking findings.

## Evidence trail

    .splitbrief/current-run → the newest run directory
    .splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/
      plan.json · plan.md · tasks.md · plan-inputs.json
      progress.md · evidence.md · baseline-sha.txt · baseline/
      briefs/index.md · briefs/T001.md …
      T001/attempt-N.prompt.md · attempt-N.log · attempt-N.pid · attempt-N.done
      consults.jsonl · touched-files.md · validation.md
      review-packet.md · review/attempt-N.log · review.json · review.md

Save the baseline bytes as well as hashes; hashes alone cannot reconstruct the diff.
Keep done rows, counters, consults, confirmed decisions and the original baseline on resume and fixes.
Record commands, exits, terminal results, checks and touched-file reasons in the evidence trail.
Print whether `.splitbrief/` is ignored. The session writes run artifacts; the implementer never edits that protected directory.
