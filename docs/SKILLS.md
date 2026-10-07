# SPLITBRIEF as agent skills

The four pipeline skills run one planning session, Markdown briefs, deterministic checks, planner consults and evidence-bound review.
The loading session is the planner. It spawns one headless implementer CLI per task.
The reviewer reads the candidate without editing it; this session reviews when no reviewer seat is configured.
The skills require no SPLITBRIEF CLI.
The CLI also owns sessions, the TUI, isolation, snapshots and token accounting.
The skills execute in the working tree. A fifth skill, `splitbrief-babysit`, supervises the built CLI.

## Install

    npx skills add b4r7x/splitbrief

Non-interactive, one skill into several agents:

    npx skills add b4r7x/splitbrief -s splitbrief -a claude-code -a cursor -a opencode -a codex -a github-copilot -a antigravity -a command-code -a kilo -y

skills.sh installs into each agent's own skills directory (`.claude/skills`, `.agents/skills`, `.commandcode/skills`, `.kilo/skills`, `.kilocode/skills`, …). Add `-g` for a user-wide install. The picker lists the five skills under one `Splitbrief` group row (from `.claude-plugin/marketplace.json`).

Claude Code can also take the repo as a plugin marketplace, which installs all five at once and updates them together:

    /plugin marketplace add b4r7x/splitbrief
    /plugin install splitbrief@splitbrief

### Installers and `scripts/`

The waiter (`wait-attempt.sh`) and the stop-hook gate (`splitbrief-gate.sh`) ship inside the skill directories, so an installer that copied only `SKILL.md` and `references/` would leave the run protocol without its blocking primitive. Every installer that can be exercised today preserves `scripts/` with its executable bit; the commands, trees and versions behind this table are recorded in `.nuke/2026-09-13-094954-spec-loop-granularity-monitoring-parity/evidence/installers.md`.

| Installer | Command | Result | Fallback |
|---|---|---|---|
| skills.sh (local clone) | `npx skills add <path-to-clone> -s splitbrief-run -a claude-code -y` | `.claude/skills/splitbrief-run/scripts/wait-attempt.sh`, mode `755` | not needed |
| skills.sh (published repo) | `npx skills add b4r7x/splitbrief -s splitbrief-run -a claude-code -y` | unverified: the published `b4r7x/splitbrief` carries no `skills/` yet, so the clone succeeds and the CLI prints `No skills found` | the inline `until … done` waiter in `references/run-protocol.md` |
| Claude Code plugin | `/plugin install splitbrief@splitbrief` | `scripts/` under every script-carrying skill in the plugin cache, mode `755` | not needed |
| Manual copy | `cp -R skills/splitbrief-run ~/.claude/skills/` | the directory as it stands in the repo | not needed |

The canonical `skills/splitbrief/references/run-protocol.md` holds the generated wait protocol, including the inline fallback.
Sync copies that reference and the explicitly listed scripts into each skill that runs a tool.

## The skills

- `splitbrief`: plan this here, let another tool build it, then review and fix it.
- `splitbrief-brief`: plan only and write briefs; stop before implementation.
- `splitbrief-run`: build an existing plan or brief set, continue a stopped run, fix a failed review, or run one task.
- `splitbrief-review`: review someone else's build against its intent; leave source files unchanged.

`splitbrief-run` now continues through review and bounded fixes by default.
It announces that scope and prints the selected stages before dispatch.
A run directory resumes its saved stage, including review or fixes, while preserving attempts, bounds, decisions, and completed tasks.
It reconciles active processes before spawning. `--status` inspects the saved run without dispatch.
`error: <review.md>` starts planner triage, appends fix tasks with new ids, then validates and reviews again.
A single brief file selects one task. Unmet dependencies pause execution; completion applies to that selection only.
A prose plan becomes the typed contract before dispatch, with its stated outcome preserved.
A review request alone never authorizes source changes or execution of its appended fixes.

The family routing table lives only in [family-map.md](../skills/splitbrief/references/family-map.md).
The separate `splitbrief-babysit` skill supervises the built CLI.

### Supervised dogfooding

`skills/splitbrief-babysit/` is self-contained when copied or installed alone. It needs no other skill, private `.nuke/` files, `jq`, or fixed agent model. It uses the repository's Node.js runtime. When tmux is on PATH, it always launches the run in a named tmux session and gives the owner `tmux attach -r -t <session>` to watch it live; without tmux, it uses the host's interactive terminal. The configured coding tools remain prerequisites for the CLI run.

The bundled `scripts/watch-run.mjs` polls the session log once per second and preserves its byte cursor between calls. Errors, failed validation, retries, warnings, and recovery events wake the supervisor. The supervisor stops the run; the watcher does not enforce an engine-level barrier. A tool defect that blocks the run, including a false tripwire alarm, ends the run: End run, fix, verify with the gates, rebuild, let the owner commit, then start a new run. A cosmetic defect goes to the debt list and the run goes on. A weak seat output is corrected in the composer, not in code. Model mistakes and correctly reported provider limits retain normal CLI recovery.

The watcher source follows the existing script library convention in `skills/splitbrief-run/scripts/`; `skills:sync` copies it into the installed babysit skill. No source-library path is needed at runtime. The four pipeline skills still use generated contract blocks; the babysit procedure is handwritten and its frontmatter and script mirror are checked by `skills:check`.

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
Before the final review, run the full suite and every registered check on the current candidate. A task-cadence review runs no full suite.
Allow 2 fix cycles globally. At end cadence, this permits up to 3 reviews; task cadence adds reviews and shares the cap.
The CLI runs the end/task cadence, the decisions ledger, typed review with a derived pass, planner triage and planner-first review questions.
The skills follow that agreed design now. Render checks are unavailable in the skills.

## Engine command mapping

| Engine command | User intent |
|---|---|
| `spec` | `splitbrief-brief`, planning only. |
| `start` | `splitbrief`, the full pipeline. |
| `resume` | `splitbrief-run` continuation from the saved stage. |
| `status` | Inspection, equivalent in intent to `splitbrief-run --status`. |

These mappings describe requests, not state compatibility.
Standalone skill records cannot serve as engine session state for `resume`.

## Contract sources

| Skill step | Engine contract or path |
|---|---|
| One planning session, defaults and typed plan | `src/core/schemas/plan.ts`; `src/engine/orchestrator/planning/session.ts` and `plan-session.ts` |
| Plan admission and Markdown renderings | `src/engine/spec/plan-checks.ts`, `plan-tasks.ts`, `prompts/task-format-example.ts` |
| One behaviour with its tests and callers | TaskSpec intent/criteria; `src/core/pipeline-spec/brief.ts` |
| Ordinary files as guidance; protected confirmation | `src/core/pipeline-spec/scope.ts`; DESIGN §5 hard rules |
| One local retry and planner consult | `src/core/pipeline-spec/retries.ts`; `src/core/schemas/consult.ts`; `src/engine/orchestrator/consult/` |
| Stale refresh and persistent lineage bounds | `src/engine/orchestrator/task/stale-inputs.ts`; `src/core/pipeline-spec/bounds.ts` |
| Proposed decisions and confirmed Plan context | ImplementerReport decisions and `plan.decisions`; TRACE §4 |
| End/task cadence and completed-task coverage | `workflow.review` (`src/core/schemas/config.ts`); TRACE §4 |
| Typed review, derived pass and appended fixes | `src/core/schemas/review.ts`, `src/core/review/verdict.ts`; planner triage; DESIGN §§4, 7 |
| Validation stages, narrowing and capture | `src/core/pipeline-spec/gates.ts`; `src/core/validation/stage-command.ts` and `stacks/` |
| Registered checks and the cadence gates | Plan and TaskSpec checks; `src/engine/orchestrator/task/brief-gate.ts`, `src/engine/orchestrator/run/pre-review-checks.ts` |
| Spawn recipes, halts and deadlines | `src/engine/runners/cli-tools/`; `src/core/pipeline-spec/halts.ts`, `timeouts.ts` |
| Plain CLI output | `src/engine/events/sinks/stdout-text.ts` |

Recovery actions, persistent bounds, and finding triage live in [recovery.md](../skills/splitbrief/references/recovery.md).
Confirmed deviations reach later briefs, consults, and reviews through the decisions ledger in planning.md.
Recorded validation decides task completion. The implementer report remains advisory.
The review contract derives pass from complete task and criterion coverage with no blocking findings.

## Reference library and ownership

Author shared references only in `skills/splitbrief/references/`. The library contains exactly these nine files.
Each entry file explicitly lists its dependencies; sync copies those files into that skill's own `references/` directory.
The entry files compose shared procedures and add only their entry-specific input or write boundary.

| Reference | Owns |
|---|---|
| `family-map.md` | Entry selection, arguments, and engine command mapping. |
| `planning.md` | Planning session, typed plan, input conversion, and decisions ledger. |
| `brief-format.md` | Markdown brief contract and BRIEF_HOME_OF_FIELD placement. |
| `run-protocol.md` | Dispatch, waiting, saved progress, continuation, and review cadence. |
| `recovery.md` | Retry, consult, bounds, and finding triage; generated consult-table and fix-cycle. |
| `gates.md` | Validation resolution, baselines, registered checks, and change evidence. |
| `implementer-prompt.md` | Prompt construction and advisory completion report. |
| `review-format.md` | Review packet, typed answer, exact coverage, and derived pass. |
| `tool-recipes.md` | Tool probes, invocation recipes, terminal records, and seat diagnoses. |

The script library stays at `skills/splitbrief-run/scripts/`.
Sync copies explicitly named scripts with their executable bits.
A copied skill folder contains every reference and script it names, including references required by its local library.
`scripts/sync-skills.test.ts` verifies each pipeline skill copied alone.

## Evidence trail

    .splitbrief/current-run → the newest run directory
    .splitbrief/runs/<YYYY-MM-DD>-<HHmmss>-<slug>/
      plan.json · plan.md · tasks.md · plan-inputs.json
      progress.md · evidence.md · baseline-sha.txt · baseline/
      briefs/index.md · briefs/T001.md …
      T001/attempt-N.prompt.md · attempt-N.log · attempt-N.pid · attempt-N.done
      consults.jsonl · touched-files.md · validation.md
      review-packet.md · review/attempt-N.log · review.json · review.md · triage.json

Save the baseline bytes as well as hashes; hashes alone cannot reconstruct the diff.
Keep done rows, counters, consults, confirmed decisions and the original baseline on resume and fixes.
Record commands, exits, terminal results, checks and touched-file reasons in the evidence trail.
Print whether `.splitbrief/` is ignored. The session writes run artifacts; the implementer never edits that protected directory.

## Maintaining the skills

Generated blocks read engine contracts and constants. Handwritten skill steps follow the agreed DESIGN and TRACE.
Mark unshipped engine behaviour explicitly. Never render a retired rule merely because its constant still exists.
`npm run skills:sync` updates blocks and mirrors. `npm run skills:check` verifies them.

Use `<!-- generated: <id> -->` and `<!-- /generated -->` in Markdown.
Use `# generated: <id>` and `# /generated` in shell scripts.
`scripts/skill-blocks.ts` owns renderers; GENERATED_BLOCK_IDS names the active blocks.

| Source | Blocks |
|---|---|
| TaskSpec field map and workspace/report contracts | brief-template, implementer-preamble, body-order, closing-line |
| ConsultAnswerSchema, retries and BOUNDS | consult-table, consult-contract |
| BOUNDS seat retries and reset waiting | seat-recovery |
| Pipeline validation and stack registry | gate-rules, gates, brief-grouping, suggested-files, baseline-rule |
| Agreed review design and REVIEW_CYCLE_CAP | review-packet, verdict-rules, fix-cycle |
| Engine halts and deadlines | halt-signatures, halt-signatures-sh, timeouts, wait-protocol |
| CLI adapters | recipe:<tool> |

Unused renderers have been removed. `consult-table` renders only into canonical `recovery.md`; `wait-protocol` renders only into `run-protocol.md`.
The consult table derives its actions from ConsultAnswerSchema and its bounds from BOUNDS.
`seat-recovery` renders the transient retry count and reset-wait bound into `tool-recipes.md` from BOUNDS.

Change either side, run `npm run skills:sync`, and the skills follow; `npm run skills:check` (part of `release-check`) fails when a generated block, a mirror, or a frontmatter rule is out of date.

`skills/splitbrief/references/` is the only place the hand-written parts of a shared reference are edited, and `skills/splitbrief-run/scripts/` is the only place a script is edited. `skills:sync` mirrors the subset each optional skill mentions into its own `references/`, and copies each `scripts/<name>` a `SKILL.md` mentions byte-identically into that skill's own `scripts/`; a stale, missing, or no-longer-mentioned mirror fails `skills:check`. Source and mirrors are both committed — skills.sh reads the repo as is. The SPLITBRIEF CLI itself never injects the four pipeline skills or `splitbrief-babysit` into any seat's prompt (they describe the loop it is already running, and the babysit skill supervises the CLI itself); the contract reaches the planner from the pipeline spec instead. The repo's dev skills are unaffected.
