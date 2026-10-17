# SPLITBRIEF Features

User-facing capability reference for SPLITBRIEF. For each feature: what it does, how to invoke it, when to reach for it, the relevant config, and the on-screen output where applicable. Deeper rationale lives in the linked specs and design docs.

> **Cross-references.** Workflow phases: [WORKFLOW.md](./WORKFLOW.md). Config schema: [CONFIGURATION.md](./CONFIGURATION.md). Slash commands: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md). Architecture inventory: [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what). Hooks: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

---

## Core orchestration

### One planning session, one plan card

**What it does.** Every run follows one path: one planning session writes a typed, checked plan; the plan card waits for your approval; the implementer builds the briefs; the review seat reviews the result. The header rail shows three stages — Plan, Build, Review. There are no workflow modes: `--mode`, `workflow.mode` and `/mode` were removed (the config key loads with one notice and is ignored).

**How to use.**

```bash
splitbrief start "add JWT middleware"
```

**Configuration.** `workflow.approve` (`plan` by default, or `none` to skip the plan card). See [CONFIGURATION.md §workflow](./CONFIGURATION.md#5-workflow) and [The planning session](#the-planning-session) below.

### Zero-ceremony entry (`splitbrief "feature"` shorthand)

**What it does.** `start` is the default command (`isDefault`). A bare `splitbrief "feature"` invocation is equivalent to `splitbrief start "feature"`. No subcommand required for the happy path.

**How to use.**

```bash
splitbrief "fix the typo in README"
splitbrief "add JWT middleware" @design-notes.md
```

### `@file` context injection

**What it does.** An `@file` input is the user's explicit choice. SPLITBRIEF reads it wherever it is. Text enters planner context on every planner call and stays in the run's `state.json`. Images become planner attachments.

The review seat also receives the attached text in every task review and the final review.

For CLI arguments, put the feature description first. A feature description cannot start with `@`. Example: `splitbrief "Implement @mentions in comments"`.

Use an absolute path, a path relative to the project root, or `~/…`. SPLITBRIEF expands only a leading `~/` and follows symlinks. The file must exist, be a regular file, be at most 10 MiB, and be readable. The transcript lists each file as `text · <path>` or `image · <path>` under the request. Paths inside the project are relative; outside paths are resolved and absolute. `--plain` prints one `attached files:` line. `--json` carries `attachedInputs` on the `user_message` event.

Any refused input stops `start` before the run begins, with exit code `2`. One error names every refused input, its reason, and the fix. An empty feature description before `@file` inputs also stops `start` with exit code `2`. SPLITBRIEF attaches nothing from that command line.

**Composer syntax.** An `@` at the start of text or after whitespace begins a reference. Use any file path inside or outside the project. An unquoted reference ends at unescaped whitespace. A quoted reference ends at its closing quote. Examples: `@/Users/me/notes/brief.md`, `@/Users/me/my\ notes.md`, `@docs/brief.md`, `@"a b.md"`, and `@'a b.md'`.

A token with `/`, or a token with matching opening and closing quotes, is an explicit path. Any file refusal stops the whole send. An unmatched quote stays part of an unquoted token.

A bare `@word` uses the same resolver. If no file exists, it stays text. If a file exists, it attaches. Other failures stop the send. Emails, embedded `@`, escaped `\@`, and a lone `@` stay text.

Text must use UTF-8 and contain no control bytes except whitespace. SPLITBRIEF refuses binary content with `not-text`. Images must use PNG, JPEG, GIF, WebP, or BMP.

Home sends attached text as planner context, like `start`. A mid-run message carries the file text to the seat that receives the message. Attached content is never parsed for more references. The transcript keeps the typed reference and shows `Attached files · n` under the message. Each file row reads `text · <path>` or `image · <path>`. Files inside the project use relative paths. Outside files show their full resolved paths. The transcript contains no file bodies.

A BUILD seat that takes images gets them as images. A vision API model receives `image_url` parts. Codex uses `--image`. Opencode and kilo use `--file`. Copilot uses `--attachment`. Claude-code receives image content blocks through stream-json input. Any other seat gets `[image:<id>] = <path>` lines and an Images transcript row stating that the seat takes no images.

A refused plain send keeps the whole draft, history, and pending images unchanged. Feedback names the reason and fix. `/steer` accepts the same `@` references. A refused `/steer` clears the draft and records the command in history; ↑ recalls it. The refusal sends no correction and leaves pending images unchanged.

**How to use.**

```bash
splitbrief "refactor auth" @context.md @screenshot.png
splitbrief start "add endpoint" @api-spec.yaml @existing-handler.ts
```

**When to use.** When the planner needs additional context (design docs, screenshots, existing code) that isn't captured by the repo-map or the feature description alone.

**A bare path.** A path without `@` stays prompt text. A composer line is a command only when its first word is `/` plus a name without another `/`. `/help` and `/crew plan` are commands. A line that starts with `/Users/me/notes.md` goes to the planner as text because the path has a second `/`. The plan seat uses its own tools and policy to read the path. In the TUI, a pasted or dropped image path becomes an image attachment (`[image #n]`).

SPLITBRIEF reads and attaches text files when you put `@` before the path. An `api` plan seat has no file tools and shows one warning before planning for existing absolute paths: `The plan seat reads no files, so it cannot open <p1>, <p2>. Put @ before a file path to attach its text.`

### Runner kinds (cli / api / shell / agent)

**What it does.** The planner, the implementer and the optional reviewer dispatch on a `kind` discriminant. Four kinds cover every backend SPLITBRIEF supports.

**How to use.** Set `kind:` plus the kind-specific fields under `planner:`, `implementer:` and `reviewer:` in `.splitbrief/config.yaml`.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity` |
| `api` | OpenAI-compatible HTTP endpoint | Ollama, LM Studio, llama.cpp, custom endpoint |
| `shell` | Arbitrary stdin → stdout subprocess; no shell/network sandbox | Custom scripts |
| `agent` | Subprocess that writes files directly; no shell/network sandbox | File-writing tools (no stdout extraction) |

**Auto-detection.** `splitbrief init` and `/refresh` probe installed CLI tools and reachable API endpoints; the seat pickers, reached from Settings ∋ Crew (`/crew plan`, `/crew build`), surface only what is available. A first setup with no remembered result shows the "Waking your crew…" boot manifest (seat rows plus live discovery-lane marks) and advances when discovery succeeds. On later TUI setup loads, SPLITBRIEF publishes the sanitized remembered result for the project — including remembered model rows — before discovery refreshes in the background; a result remembered under a different configuration context still hydrates, as presentation-only rows that never outrank a live lane. A failed refresh leaves those rows visible with a refresh-failure indication. The home screen shows a spinner with "Waking your crew…" during a cold first discovery and "Refreshing your tools…" during warm background refreshes, and the runner pickers mirror the same cold/warm states.

Remembered detection is presentation-only. It can populate a picker, but it cannot authorize a workflow, resume, or `spec` run, and it is not an offline execution mode. Every local run still performs fresh execution preparation against its exact effective configuration.

The home wake card names PLAN, BUILD and REVIEW with the same collapsed line as the workflow header.
An inherited review seat reads `REVIEW = PLAN` on home, in Setup and Settings, in the picker, and in the workflow.
The card drops the first-run note before it shortens a seat. OpenCode seats show the model name and the provider, such as `OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go`, and the collapsed line keeps the provider: `PLAN DeepSeek V4.1 Flash via opencode-go`.
Bundled tool labels keep the seat names the same before and after a model catalog arrives.

```yaml
planner:  { kind: cli, tool: claude-code }
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
  contextLength: 32768
```

Full schema: [CONFIGURATION.md §planner](./CONFIGURATION.md#2-planner) and [CONFIGURATION.md §implementer](./CONFIGURATION.md#3-implementer). Capability matrix per backend: [ARCHITECTURE.md §Capability matrix](./ARCHITECTURE.md).

### Run Readiness / Doctor

**What it does.** Before `splitbrief start` spends planner or implementer tokens, SPLITBRIEF checks config, the plan approval level, runner posture, context length, validation settings, git status, and active-session conflicts. Blockers stop the run; warnings can continue.

**How to use.**

```bash
splitbrief doctor
splitbrief doctor --json
splitbrief doctor --probe-seat build
splitbrief start "add profile settings"
splitbrief start --json "fix parser edge case"
```

The `splitbrief doctor` readiness report is read-only. It makes no model call and writes nothing: no config, sessions, worktrees or snapshots. It runs no validation subprocess. Its one network call is the runner availability probe: a model-list request to the `api` endpoint each configured runner already targets, so an unreachable planner or default implementer is a blocker here instead of a `fetch failed` after the planning phase has been paid for. A local workflow start prepares every runner context it may select and persists that attempt's compact `.splitbrief/sessions/<id>/readiness.json` before execution begins. That file keeps each warning and blocker with its details and fix, and each warning appears as a Warning row under the request in the run transcript: its summary, its details and `Fix: <fix>`, one per line, in the words `splitbrief doctor` prints. If fresh preparation is blocked, cached success cannot create a session or start a process. In headless mode the readiness report is emitted as the first structured JSON line.

`splitbrief doctor --probe-seat <plan|build|review>` is the one paid form. It sends one short prompt through that seat's CLI adapter, with the seat's own model and effort, in a temporary empty git repository. The call has a 60-second limit and a 64 KiB output limit. The command prints `Seat probe <seat>: <class>`: `passed`, or the failure class and the first error line. It appends one record to `.splitbrief/probes/<tool>-<date>.jsonl` and runs no readiness report. See [CLI-REFERENCE.md §Seat probe](./CLI-REFERENCE.md#seat-probe---probe-seat).

**Isolation recommendation.** Some stacks only work in the checkout: linked Node workspace packages, a Python editable install in a virtualenv under the project, `go.work`, or a Cargo workspace with `target/` in the checkout. When readiness finds one and `workflow.isolation` is not set in `.splitbrief/config.yaml`, it raises a blocker that recommends the checkout. Set `workflow.isolation: none` (recommended) or `workflow.isolation: worktree` to keep the worktree. Writing the key is the one-time confirmation. An explicit `worktree` or `staged-copy` keeps the finding as a warning; `none` omits that finding. In checkout mode, readiness warns about uncommitted changes and names `.splitbrief/sessions/<id>/reverted/` as the backup folder, with the run's own id once the run starts; `splitbrief doctor`, before any run, names the run's `reverted/` folder under `.splitbrief/sessions/`. An attempt revert restores only paths that attempt changed and leaves your other uncommitted files untouched.

**When to use.** Run `doctor` while setting up a repo, before CI automation, or when a start run is blocked by config/repo posture. Use the pre-start report to decide whether to continue through warnings such as dirty files, missing context length, or End-of-run checks turned off.

**Events/output.** Human output groups checks into config, runners, context, validation, repository, and cost. JSON output uses `{ type: "readiness_report", report: ... }`. Validation readiness is posture only: it reports whether End-of-run checks are on (`validation.configured`, `validation.end-checks-off`), the command a planner `test` check resolves, and a missing npm script, without running any command.

### Validation pipeline + checkpoints

**What it does.** The brief gate follows `workflow.review`. With `end`, an ordinary brief runs no check; it runs only the checks a caller names, such as a consult `verify`. With `task`, each task runs its own checks and its due checks, then its review. Before the final review every registered plan and task check runs. Then, with **End-of-run checks** on (`validation.end_checks`, the default), the reviewer makes the plan call. It reads the project, for example its scripts, `Makefile`, CI configuration and README. It chooses at most six reviewer checks that verify the change (`V1`, `V2`, …), each with a reason. It names each related test it does not run, with the reason, and when it chooses no reviewer check it gives the reason. With **Approve checks** set to `ask` (`validation.approve_checks`), one card shows the chosen commands first, and none runs until you choose **Run all** or **Skip all**. SPLITBRIEF runs the reviewer checks in the run workspace under the reviewer command policy. That policy runs any installed program of any language (`mvn test`, `bundle exec rspec`, `make check`, `dotnet test`). It refuses shell syntax, a program run by path (`bin/test`, `sub/gradlew`), inline code, `npx` without `--no-install`, a download-and-run launcher, a setup command, a program that does not verify a change, and a package script (in any `package.json` or `composer.json`), task file (`Makefile`, `justfile`, `Rakefile`, `rakelib/`), build wrapper or interpreter script this run changed or the run base does not hold. The project's root `./gradlew` and `./mvnw` run as `gradle` and `mvn` when this run changed none of their wrapper files. `deno task` tasks and `mix.exs` aliases are not compared ([CONFIGURATION.md §Reviewer checks](./CONFIGURATION.md#reviewer-checks)). Every refused command gets a named row. A red reviewer check re-runs at the run base with the same command text. A matching failure is pre-existing, appears in the Checks Log and creates no fix. A timeout, or a red with no failure keys, is never pre-existing: it is not verified at the run base, and the reviewer decides. The checks run the project's own code with your permissions; SPLITBRIEF drops secrets from their environment but does not isolate the file system or the network ([CONFIGURATION.md §What a check can reach](./CONFIGURATION.md#what-a-check-can-reach)). The first reviewer check with new failures stops the list; each later one is not run. Every new or not verified red reaches the reviewer's verdict call as a pending input. A failed plan call (a transport error or a protocol error) halts the review the same way a failed verdict call does; it is never a pass. The review answer supplies the fix tasks and spends one fix cycle when the fixes start.

Each fix task carries own failure keys and all original red keys per check id, with its command, file and output. Each brief gate runs the checks once under the same command policy.

After a successful BUILD call, SPLITBRIEF runs a correction pass for pending messages while the run continues. It runs the checks after that pass. If checks pass with pending messages, BUILD makes another call before SPLITBRIEF runs the checks again.

A red passes only when no carried failure remains and the re-run still shows a key the original red showed that is not the task's own. Otherwise, the command must pass.

A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. Keys with no file match exactly.

Other failures belong to other fix tasks or the next review. A check with no carried keys, or a re-run with no named failure, must pass. Fix checks never re-run at the run base. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass.

The final review repeats the reviewer checks after the fixes. A reviewer command a fix check ran leaves the pending list only after it passes or fails and the review records a verdict. The plan call must choose the pending commands first, with the same text. The plan holds at most 6 commands. The review section names each remaining command as not run; it stays pending. A task review (`workflow.review: task`) makes the same plan call, scoped to the tests related to the task's changed files. With End-of-run checks off, no reviewer check runs, plan and task checks still run, and one row says so.

**On-screen.** The transcript carries one row for the plan call: `Reviewer checks · chose 2 · declined 1`, or `Reviewer checks · chose none · <reason>`. Under it, each declined test gets an indented row `declined · <target> · <reason>`. Each reviewer check gets one row: `Reviewer check V1 · <command> · passed 12s`, `failed 3s`, `refused · <reason>` or `not run · V1 failed`. A base re-run reads `Base re-run V1 · <command> · passes at the run base`, `2 new, 1 pre-existing` in the error colour, or `pre-existing 13s · all 3 failures also fail before this run's changes` in the warning colour. Under the base row, dim rows name the failing tests of each side: `new · <test>` and `pre-existing · <test>`, one test for each row, the first three of each side and then `+2 more`. A long test name wraps under the first name and never cuts the verdict. When the two reds cannot be compared (a timeout, or a red with no failing test name and no diagnostic line), the base row counts those failures apart, in the warning colour: `1 not verified at the run base · 10m 0s · both runs timed out`. Each count and its word are joined with a non-breaking space (`\u00a0`) so terminal wrapping never splits them. The status phrases `not run` and `chose none` use the same space between their words, including the row for skipped reviewer checks. Such a failure is never pre-existing: it reaches the reviewer as a pending input.

Each judged fix check gets its own verdict row, including green re-runs. A red without proof reads `your N failures not shown · not proven fixed`. This includes carried plan and task checks. Plan and task checks get only a done row, with no duration. When its keys are gone, it reads `Fix check V1 · <command> · your 2 failures gone · 3 others left · 3.0s`. When a carried key remains, it reads `Fix check V1 · <command> · 1 of your 2 failures remains · 3.0s`. The row uses the same words in singular form for one failure. Counts join their nouns with U+00A0, so `2 failures`, `3 others` and `1 of` stay together when the row wraps. The phrase `not proven fixed` also stays whole.

A check without carried keys keeps `passed` or `failed`. With the setting off the row reads `End-of-run checks · off · no reviewer check ran`.

With `approve_checks: ask`, a card above the composer follows the plan call row: `Reviewer checks · chose 2 · none has run yet`, one line per command with its id, command and reason, then **Run all** (`run these commands in the run workspace; the review reads their output`) and **Skip all** (`run none; the review counts none of them as a pass`). `↑↓` selects, `⏎` confirms, and `Tab` moves focus to the composer; a bare letter selects nothing. When none of the commands runs, one warning row reads `Reviewer checks · not run V1, V2 · <reason>`: `Skip all was chosen on the card`, `the reviewer checks card closed without an answer`, or, in a headless run, `validation.approve_checks is ask and this run has no screen to ask on`. Settings shows **Approve checks** (`ask` · `auto`) in the Validation section, next to **End-of-run checks**.

The project formatter formats the brief's changed files after each hand-back. A formatter failure logs `validation_format_failed`. It does not fail the brief. A format pass that changes files logs `validation_formatted`. Success records evidence without staging or committing files.

**Stack coverage.** The registry is `src/core/validation/stacks/`; `detectStack` picks the first row whose marker file exists, in this order:

The reviewer chooses the reviewer checks from the project itself, and the reviewer command policy does not read this registry. The registry resolves the planner's `test` checks, and its tools form the allowlist of the plan command policy for plan `cmd` checks.

| Stack | Marker | test | Test files |
|---|---|---|---|
| `rust` | `Cargo.toml` | `cargo test` | `tests/*.rs` in the crate, `#[cfg(test)]` blocks in the changed file |
| `go` | `go.mod` | `go test ./...` | `*_test.go` |
| `python` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile` | `uv run pytest` with `uv.lock`, `poetry run pytest` with `poetry.lock`, else `pytest` | `test_*.py`, `*_test.py` |
| `typescript` | `tsconfig.json`, or `typescript` in `package.json` dependencies | `npm test` when `scripts.test` exists | `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `__tests__/*.ts` |
| `javascript` | `package.json` | `npm test` when `scripts.test` exists | `*.test.js`, `*.spec.js`, `*.test.mjs` |

**Resolution ladder.** A planner `test` check resolves its command through `config → manifest → discovered → stack default → none`: an explicit `validation.test_command`, then a `package.json` `test` script / `Makefile` or `justfile` `test` target / `[tool.pytest.ini_options]` section, then the command the planner discovered while reading the repo, then the stack default. When every rung is empty the check is `not-runnable` with the reason `no test command for an unrecognised stack`, never passed; a required one halts with `required-checks-unrunnable`. SPLITBRIEF never falls back to `npm test` on a project that is not a JavaScript or TypeScript one.

**How to use.** Leave `validation.end_checks` on, or set it to `false` (Settings: End-of-run checks) to run no reviewer check before a review. Set `validation.approve_checks: ask` (Settings: Approve checks) to see the reviewer checks before they run. Pin the stack with `validation.stack` when the markers are ambiguous, and override the `test` check command with `validation.test_command`. Optionally auto-create a branch with `workflow.git.createBranch: true` (writes to `splitbrief/<slug>`).

Review the changes and commit them manually.

Existing staged content, including partial staging, remains the user’s.

```yaml
validation: { end_checks: true, test_command: "npm test" }
workflow:
  git: { createBranch: false }
```

Events: `validate`, `git_branch_created`. Historical `git_commit` and `git_checkpoint` records remain replayable, but new runs never publish them.

### Retry + consult

**What it does.** A failing task gets one local retry with the exact error, and then a seat is consulted: one read-only typed call. A plan task consults the planner on the planner's own session. A fix task (`task.fix`) consults the review seat, because the reviewer judged the change and wrote the fix; with no `reviewer:` block the planner holds that seat. The answer is one of five actions: **`guidance`** (one more implementer attempt carrying the consulted seat's instructions in its error block, under `## Guidance from the planner:` or `## Guidance from the reviewer:`), **`rewrite-task`** (the brief is replaced at the same id, `revision` +1, and the current attempt's own edits are rolled back first), **`split-task`** (the brief becomes 2–4 subtasks at the next free ids, every pending dependent is re-pointed to them, and the parent stays in the lineage record with its evidence), **`verify`** (no implementer call: the brief gate and the named checks run, and a clean run completes the brief as `consulted`), and **`ask-user`** (the only question the ladder asks you). A `blocked` implementer report, or a brief whose recorded inputs moved, goes to the consult directly. The consulted seat never writes the implementation, and an answer that would drop a criterion becomes an `ask-user` question. Each answer is one transcript row that names the seat, `PLAN → T003: split into T011, T012 · <diagnosis>` or `REVIEW → T013: guidance · <diagnosis>`. When the answer is `ask-user`, the question opens in the question prompt and the operator's consult answer is published as a `user_message` event with `qa`, rendered by the existing Answered row block and joining that brief's section (a consult that runs before its brief starts joins that brief's section).

**How to use.** Nothing to configure. A lineage is bounded at 2 consults and 8 attempts, and the run at 10 planner calls (`src/core/pipeline-spec/bounds.ts`). A spent bound halts with the diagnosis of the failure that raised it (the planner's when a consult diagnosed that failure, else that failure's own output) and offers **continue** (with a note; grants +1 consult and +4 attempts, or +5 planner calls), **skip-current-task** and **end-run**.

**When to use.** Automatic. The retired `workflow.max_retries` and `escalation` block load with one notice each and change nothing; there is no intermediate model and no hint verdict to configure.

Outcome events include `task_retry`, `task_escalating`, `consult_answered`, `task_replaced`, `tasks_inserted`, `checks_run` and `consult_bound_spent`; the old `escalate`, `hint_failed` and `task_scope_widened` events stay replayable for older runs. A consult is recorded as planner usage and can be inspected through `/usage`.

### Final review by the review seat

Before review, every plan and task check gets its own `full_suite` row at `moment: plan`. A render alone carries `scenario`. Its row reads `Render workflow-x · running`, then `rendered · 14.2s` or `failed · 14.2s`. Other checks read `Plan check <id> · <command>`, then `passed` or `failed`. Unrunnable or refused checks show their reason. During Build, a brief's check that did not run gets the same row, for example `Plan check K2 · npm run lint · refused · runs the npm script lint, which package.json does not define`; it is neither a pass nor a failure, and the reviewer sees it as refused. During collection, the rail shows Review, the byline reads `Review · Render workflow-x 0:12`, and the build block reads `Review · Render workflow-x` with freshness `running 0:12`. Render command text stays out of these displays. Plan rows add no reviewer-check reds; required failures keep their existing check inputs.

**What it does.** After all tasks reach a terminal state, the review seat — the `reviewer` runner when one is configured, the planner when none is — reviews the entire diff against the Task Brief and any supporting spec. The deterministic drift report (see below) is rendered into the prompt under `## Deterministic Drift Report` so the reviewer sees both signals at once. When the seat accepts images, the review gets at most 4 PNGs of each render check, every `frame.png` first and then the other PNGs in path order; the prompt names the PNGs it does not attach. A render criterion stays unverified only when no image of its check reached the reviewer.

**How to use.** Always runs at end cadence; with `workflow.review: task`, one scoped review also runs after each task after its due checks pass; its reviewer checks run the tests related to the task's changed files. The seat answers one typed `ReviewAnswer` with the verdict and fix work (`src/core/schemas/review.ts`), SPLITBRIEF derives `pass`, `pass-with-notes` or `fail` and writes the record to `.splitbrief/sessions/<id>/review.json` (rendered as `review.md`). The same review answer supplies fix tasks with fresh ids. At most 2 automatic fix cycles run. At the cap, the run halts on `review-failed`. It offers **fix again with a note** or end. A red check or Apply input permits no **accept as is**. The one exception is a red reviewer check that is not verified at the run base: when the reviewer rejects it with a reason, it does not block the review. Other failed final reviews also offer **accept as is**. The run fires `workflow_complete` only when it reaches `complete`, then writes `summary.json`.

Each review publishes `review_started` and one `review_completed` through `runFinalReviewPhase`, for task and final scopes. The events record the review seat and task anchor when present. The completion records its verdict, available finding counts, and duration. A failed call records `no-verdict`; a stop records `stopped`; both omit findings. A `preReview` halt publishes neither event. Review events never fire a hook or publish `planner_status`.

`--plain` prints one `review:` line per completion, such as `review: task T001 pass (0 blocking)`. A final review line names `final`. `workflow_complete` prints only the run's `done:` line. See [the review event fields](./ENGINE.md#key-event-shapes).

**When to use.** No opt-out — final review is the closing safety check before the workflow is marked complete.

---

## Planning and specs

### Task Briefs (the planner-implementer contract)

**What it does.** The Task Brief is a self-contained executable contract for one slice — one verifiable change, whose files are listed under `files` and anchored by `file` — with nine semantic sections: Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence. A slice is often one file; the planner's budget is five files and roughly 150–200 changed lines. Persisted as `Task[]` in `state.json`; transported as `tasks.md`.

**How to use.** Briefs are compiled from the checked plan (`plan.json`) on every run. External tools consume the active brief by reading `.splitbrief/sessions/<id>/tasks.md` or the task list in `.splitbrief/sessions/<id>/state.json`. Brief hash metadata is recorded in evidence and drift artifacts when available; `state.json` task objects do not carry `briefHash`.

**Example (truncated `tasks.md`):**

```markdown
---
id: T001
title: Add JWT middleware
file: src/auth/middleware.ts
files:
  - src/auth/middleware.ts
  - tests/auth/middleware.test.ts
action: create
dependsOn: []
---
### Intent
...
### Validation
- tests/auth/middleware.test.ts passes
```

Full schema: [TASK-CONTRACT.md](./TASK-CONTRACT.md).

### The planning session

**What it does.** Every run plans in one session. The planner answers with one typed plan (`PlanAnswerSchema`, `src/core/schemas/plan.ts`) through the seat's native JSON-schema flag or a JSON fallback. Before the plan it may ask up to three questions per round, for at most two rounds; each question carries a default. SPLITBRIEF then checks the plan, and a plan that fails goes back to the planner once. There are no workflow modes, no mode advisor, and no spec, research or clarify steps.

**How to use.** `splitbrief start "<feature>"`, or `splitbrief spec "<feature>"` for the plan alone. Questions open in the bordered question panel: the default choice comes first, and `⏎` through the panel takes the defaults. Headless runs stop on a question with an `input_required` record; `splitbrief spec` without a terminal takes every default.

**Artifacts.** The session writes to `.splitbrief/sessions/<id>/`:

| File | What it is |
|---|---|
| `plan.json` | The checked plan: the one source the briefs compile from |
| `plan.md` | Rendering of `plan.json`: summary, protected operations, batches. The body of the plan card |
| `tasks.md` | Rendering of the compiled Task Briefs |
| `review.json`, `review.md`, `summary.json`, `evidence.json` | Written later in the run |

A run from an older release keeps the files it wrote (`research.md`, `spec.md`, `brief-quality.json`, …); they are read, never written again.

### Plan checks

**What it does.** `checkPlan` (`src/engine/spec/plan-checks.ts`) is a deterministic check of the typed plan: unique task and check ids, every criterion covered by a task and named by a check, every task carrying a check, dependencies that exist, point to an earlier or the same batch and have no cycle, no suggested or context file outside the project, and a context fit for every task (only an `overflow` blocks). The failures go back to the planner once with a warning that lists every failed check, one per line and without its code: `The plan failed <n> checks. It goes back to the planner once to fix them:` and then `- <message>` for each. A refused `cmd` check names its command and says to change it to a command that plan checks allow, or to a check of kind `test` that names a test file. The warning's `planCheck` keeps the code and message of the first blocking check. When the revised plan passes, the transcript says so: `SPLITBRIEF  The revised plan passes its checks.` A plan that fails again halts the run with the `plan-checks-failed` recovery, whose panel lists the messages without the check codes. A third round of questions halts with `plan-questions-exhausted`.

**How to use.** Always runs. There is no brief-quality pass and no brief-readiness report; briefs compiled from a checked plan go straight to the plan card. Full rule table: [TASK-CONTRACT.md](./TASK-CONTRACT.md#the-plan-contract).

### The plan card

**What it does.** The one approval before the build. The card shows `plan.md` and four rows: **Approve plan and start the build** (`y`), **Request changes** (`c`), **Edit plan.json** (`e`), **End run** (`q`). A correction goes to the planning session, which answers with a new plan; the card shows again. Approving the card confirms the plan's protected operations in advance (`plan.md` lists them as, for example, `- T002: write package.json` under `## Protected operations`), so that write does not ask again during the build; a line above the rows names them (`Approving also confirms: write package.json`) whatever part of `plan.md` is in view. The line names each operation once, even when two checks run one command. On a terminal too short for that list and a row of the plan, the line counts them instead (`Approving also confirms 2 protected operations`). Approving never overrides a failed check.

**How to use.** On by default. `workflow.approve: none` skips the card; a headless run approves it unattended, which confirms nothing in advance. See [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#the-plan-card).

### Editing plan.json

**What it does.** `Ctrl+E`, `e` and `edit` at the plan card all open the same file, the run's `plan.json`, in the in-app editor overlay. `Ctrl+S` checks the text before it writes it: the JSON, the plan schema and `checkPlan` (the engine checks the context fit after the save). A text that fails stays open with one red row, `Not saved: <first message> (+N more)`, and no check codes. A valid save closes the editor and settles the card with the edit: the engine compiles the edited plan, rewrites `plan.md` and `tasks.md`, and shows the card again. An edit the engine refuses restores `plan.json` and publishes `The edited plan was not applied: …`.

**How to use.** `Ctrl+O` inside the editor opens `plan.json` in the external editor instead (`VISUAL`, then non-terminal `EDITOR`, then detected GUI editors with wait flags, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`); saving there settles the card with the edit the same way. There is no per-brief field editor: a brief changes through `plan.json` or a correction.

---

## Spend

### Where usage appears

Token usage and monetary estimates are available only in explicitly opened usage details.

Open `/usage` from a live or saved workflow to inspect reported counters and available estimates. Missing counters remain unknown; partial totals keep their coverage label. The main workflow, build progress, sidebar and closed-run ledger do not display token counts or monetary estimates. There is no Show spend setting. `/copy cost` is an explicit export and does not add a counter to the main screen.

### Pricing catalog

**What it does.** Per-model pricing for any metered API runner, including a custom endpoint you configure yourself. Rates follow the model, not the provider preset: a `vendor/model` id is rated through that vendor's catalog row, a bare id is matched across the catalog. `local` replaces the dollar amount when the implementer is unpriced (for example local Ollama or an OpenCode/Claude-Code subscription).

**How to use.** Pricing is auto-resolved from the model id against the models.dev catalog, the runtime model cache, or the bundled fallback (see `src/engine/providers/pricing-resolver.ts`). Local, CLI and shell/agent runners are never priced.

### Planner heartbeat

**What it does.** During a planner call the composer byline shows proof of life: `Planning… m:ss`, counted from the moment the call opened. While the planner waits on you, the byline reads `Waiting for your answer · Plan`.

**How to use.** Always active. No configuration needed.

### Streaming partial output (extracted-code implementers)

**What it does.** For `extracted-code` implementers (`kind: api` and `kind: shell`), the last N lines of generated output stream in real-time via a ring buffer. Users see code materializing instead of staring at a spinner or elapsed-time counter. A `direct` implementer (a CLI tool or an agent) gets no preview: its narration appears in transcript rows; its closing report, bare or in a code fence, reads as one dim `Report  done · M decisions` row with no fence row. CLI messages with known boundaries start distinct rows.

**How to use.** Always active for `extracted-code` implementers that stream their output. No configuration needed.

**When to use.** Automatic during implementation when the implementer returns its code as text. The lines render under the brief's `working on <file>…` row.

---

## Safety and control

### Stopping a run

**What it does.** During a live workflow, `esc` opens compact **Stop options** above the composer. The transcript stays visible and keeps updating; the draft is preserved. Each row states its consequence:

| Row | Consequence |
|---|---|
| `Stop now` | stop execution; keep partial changes |
| `Pause after this brief` | finish `T<id>` including checks and review; do not start `T<next>` |
| `End run` | stop execution; close this run; keep changes |

The second row appears only while a brief is running, and reads `Keep running` once a pause is pending. When the run has no changes to keep, no row claims changes. That is the case before any brief has run, and after a stop that cut a brief before it wrote a file while no brief had finished. Then `Stop now` reads `stop execution; keep the run open`, `End run` reads `stop execution; close this run`, and the title line promises `Draft stays.` instead of `Changes and draft stay.`. After such a stop, the `End run` row of the stopped menu reads `close this run` instead of `close this run; keep changes`. `↑↓` selects, `Enter` executes, a second `esc` performs Stop now, and `Tab` dismisses without changing the run. No letter keys trigger an action.

**How to use.**

- `esc` — open the menu, including with a draft. `esc esc` stops resumably; another Esc returns home after cleanup and saving. Once parked, one Esc returns home.
- `ctrl+c` — stop active work; another press quits after cleanup and saving. At rest/home, press twice within two seconds to quit.
- `ctrl+q` or `/quit` — stop safely, save the session, then exit.
- `/resume` — continue a parked run; the stopped menu also offers Resume, End run and Back to sessions. `/stop` reopens the menu. An open run at rest accepts Enter to continue; typed instructions become its steer.
- `/end` closes the run through [the shared close path](./WORKFLOW.md#apply). End run on a ready workspace run means Discard.

**On-screen.** The byline reports stop progress; the legend shows keys while the stop menu is closed. It reads `Waiting for processes to exit` while owned processes remain, then `Finishing cleanup and saving`. A boundary pause reads `Finishing T<id>` and `Pause requested; no next brief will start`. With a pause armed while a reviewer check runs, the lead names that check instead: `Review · Reviewer check V1 · npm test 10:02`. A mid-brief park reads `Stopped at T<id> · Partial changes kept` when the brief had already changed files, and `Stopped at T<id>` when the stop came before its first change. A boundary stop reads `Stopped before T<id>` (or `Stopped before the review` when no brief remains). A stop outside a brief names its step, such as `Stopped at the plan`.

Stop clears running command stages and settles unfinished `full_suite` and older `validate` rows as `stopped` in the dim tone. Live events and replayed logs follow the same rule. Continuing starts a new command clock.

Stopping keeps workspace changes. Closing follows [the Apply close path](./WORKFLOW.md#apply). A ready run uses [the result menu](#run-result-menu); its closed outcome appears in [the run block](#run-screen-at-rest).

### Seat fallback

**What it does.** Each seat can name a CLI fallback. Settings › Fallback is directly below Crew and has one row for PLAN, BUILD and REVIEW. A row shows the fallback's seat identity, or `none · pause and ask`. An inherited REVIEW shows `= PLAN · …` and uses PLAN's fallback. A note names `not installed`, another readiness state, or `same as the seat`. Crew rows show no fallback line. Setup shows no fallback.

**How to use.** Press ⏎ on a Fallback row. The same tool/model picker opens with the title `<SEAT> fallback · tool, model, effort`. None is first and clears the fallback. The picker offers only CLI tools that the seat can host. It has the seat's model, effort and variant axes, with model-id axes in `fallback.model`, and no auth-method row. It refuses the seat's own identity with `<SEAT> runs <identity> now · choose another tool or model`. A typed custom model saves `fallback.model` only under `Custom fallback model · <SEAT>`.

When REVIEW follows PLAN, both picker screens show `REVIEW = PLAN · saving here gives REVIEW its own seat`. Saving, or clearing while PLAN has a fallback, copies PLAN's runner into a new `reviewer` block with the chosen fallback or none. PLAN stays unchanged. Presets keep each seat's fallback; a preset with no reviewer makes REVIEW follow PLAN, fallback and all.

**During a run.** The next halt reads the fallback of record, in any phase. An automatic switch makes the old CLI seat the new fallback. An old non-CLI seat leaves none. A manual switch keeps the fallback. A REVIEW switch creates its own block when it inherited PLAN and leaves PLAN unchanged. A resolved automatic switch shows `Recovery  <cause> → continued on fallback`, with expandable runner words, then `<SEAT>  <from identity> → <to identity> · automatic fallback`. OpenCode identities name the provider (`via opencode-go`). Manual switches show both endpoints without the automatic marker.

A switch does not write the session's `seats.json`. The next resume reconciles `seats.json` against the config. The engine checks each changed seat against the `seat_switched` events since the last `workflow_started` or `workflow_resumed`. If the latest switch for that seat records the current config, the engine emits no seat-change notice. A config change between runs still emits a notice.

Older logs emitted that notice before `workflow_resumed`. The transcript folds only one matching notice before the resume that follows the switch. It keeps notices for config changes before later resumes. See [Seat down](./APPROVAL-AND-RECOVERY.md#seat-down) for conditions and detail rows.

### Recovery stops

**What it does.** A recovery stop saves `pendingRecovery` in `state.json`, appends events to `session.jsonl`, and shows a decision prompt. Causes include spent bounds, blocked dependencies, runner failures, protected-write denials, Apply conflicts, partial writes and failed reviews. Planning can also halt on a failed call, excess questions, failed checks or an invalid typed answer. Each issue names its seat and fires `on_halt`. The prompt shows one of two halts and then the cause: `Needs you · <cause>` for a decision only the operator can make, or `Seat down · <cause>` when the seat cannot run (`haltOf`, `src/core/recovery/halt.ts`). [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery) owns the cause codes and action policy.

**Actions.** Available actions are filtered per issue:

| Action | Current behavior |
|---|---|
| `retry-same-worker` | Retries the recorded PLAN/REVIEW step without requiring a task; BUILD resets and reruns only the matching current task. |
| `continue` | Grants extra allowance on a spent consult or planner-call bound. |
| `skip-current-task` | Marks the task skipped, records evidence, and leaves dependents for normal blocked-dependency recovery. |
| `end-run` | Closes through [the shared close path](./WORKFLOW.md#apply), preserving unapplied workspace work first. Refuses an unfinished Apply: restore or retry Apply first. |
| `accept-as-is` | Records an Accept as is override at final review for every run. See [Accept as is](./APPROVAL-AND-RECOVERY.md#accept-as-is). |
| `restore-backup` | Restores a partial Apply. See [Partial Apply recovery](./APPROVAL-AND-RECOVERY.md#partial-apply-recovery). |
| `revise` | Queues the operator's correction for the next planner turn, then clears the halt. After a failed final review, it records the correction and sends the review's findings back through one more repair cycle. |
| `switch-seat` | A *Seat down* action, offered on `runner-usage-limit`, `runner-unauthenticated`, `implementer-recipe-invalid`, `implementer-left-isolation`, `runner-timeout-repeated`, `planner-call-failed` and `seat-protocol-error` when a fallback or another ready tool is offered. It moves the blocked seat and re-prepares the same session. A manual choice opens that seat's picker in the `seat` slot with the first candidate's model and effort drafted, and keeps the fallback. An automatic-switch intent applies the fallback with no picker and makes the old CLI seat its fallback, or leaves none for an old non-CLI seat. Closing the picker with no change leaves the halt open. |
| `retry-later` | A *Seat down* action, offered only when the halt names a reset. It sets the seat's wait to that reset and resolves the halt, so the run waits for the reset. |

Set the seat's fallback in Settings › Fallback, or write it in `.splitbrief/config.yaml` using [Configuration §fallback](./CONFIGURATION.md#fallback).

Older files can name retired actions; `RETIRED_RECOVERY_ACTIONS` reads `revise-spec` as `revise` and `route-bigger-worker` as `retry-same-worker`, and drops `pause-run` and `planner-split-rebase`. A halt you leave stays pending, and the run shows it again when you continue.

**Resume/headless.** `splitbrief resume` shows pending recovery before any planner or implementer call. Headless JSON runs emit `recovery_required` with reason, task/files, available actions, and recommendation, then exit non-zero; both headless renderings print the recommended action and the exact `splitbrief continue <session> --action …` line to stderr. `continue --action <skip|retry|restore|switch-seat:<tool>[:<model>][@<word>]>` answers a pending recovery without a TUI. These four actions need a pending recovery. `--action end-run` closes an open run, with or without a pending recovery, as End run does on the run screen. End run and Discard refuse an unfinished Apply: restore or retry Apply first. A run ready to apply closes `discarded` and keeps `run.patch`. `restore` takes `restore-backup` and answers only an `apply-partial` halt. `--on-seat-down halt|switch` on `start`, `resume` and `continue` decides whether a declared `fallback` moves a seat on a seat-down halt ([Seat down](./APPROVAL-AND-RECOVERY.md#seat-down)).

### Where the implementer works

**What it does.** `workflow.isolation` chooses where every build seat writes. `worktree` (the default) gives the run one linked git worktree. `staged-copy` gives it one project copy. Both deliver the result to your checkout at Apply. `none` ("your checkout") lets the implementer edit your checkout directly: validation and review run there, and a passing review closes the run with no Apply. In `none`, a git write during a call halts `checkout-changed`, an edit of yours between calls is a warning, and every revert first saves the replaced bytes under `.splitbrief/sessions/<id>/reverted/<stamp>/`.

**How to use.** Set the key in `.splitbrief/config.yaml`; `splitbrief init` does not write it. In Settings, highlight `Isolation` and press Space to cycle the choices. Details and trade-offs: [CONFIGURATION.md §5](./CONFIGURATION.md#implementer-isolation).

### Protected-path confirmation

**What it does.** A write to a protected path asks before it reaches the project, and no other write does. The protected paths are dependency manifests and lockfiles (`package_change`), CI configuration and env and key files (`sensitive_change`), and `.git` and `.splitbrief` (`destructive`). A brief's files are suggestions: an unplanned ordinary file is recorded as touched, not suggested, and does not ask. A confirmation holds for that path for the rest of the run, and approving a plan card that lists the write confirms it in advance. `--yolo` is removed. The retired `approval.enabled` key loads with one notice and is ignored. There are no sticky grants, no `.splitbrief/approvals.json`, no `/approval` command, no `splitbrief approval` command, and no tier overrides (`approval.tiers` loads with one notice and is ignored). There is no check for shell commands or network access; SPLITBRIEF does not sandbox either.

**How to use.** Nothing to configure. Answer the prompt with Confirm (and an optional reason) or deny it; a denial discards only the denied file. A headless run has no reply channel, so a protected write fails closed with `APPROVAL_REQUIRED`.

**Events.** `approval_prompted`, `approval_granted`, `approval_rejected`. Confirmations and rejections are also written to the evidence ledger with a reason string.

### Snapshots (advanced run safety)

**Run result.** A passing workspace review makes the run ready to apply. [The result menu](#run-result-menu) offers Apply, Show diff and Discard. [`/run`](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject) provides the command path and defines compatibility with older snapshot-ledger runs.

**Excluded paths.** `.git/`, `.splitbrief/`, `node_modules/`, `.trees/` are non-negotiably excluded (`ALWAYS_EXCLUDED` invariant in `engine/snapshots/files.ts`). Including them would cause exponential snapshot growth. The run's own isolation worktree lives outside the project tree entirely (`$XDG_STATE_HOME/splitbrief/trees/...`, default `~/.local/state/...`), so the snapshot walker never sees it.

### Drift detection (final review)

**What it does.** Before final review, the orchestrator computes a deterministic drift report. The orchestrator compares the Task Brief with the actual git diff and the captured brief diffs. Findings include out-of-scope file edits, missing target files, orphan diffs, and changes from failed tasks.

**How to use.** The orchestrator always runs drift detection. It saves the report as `.splitbrief/sessions/<id>/drift-report.json`. It includes the report in the final review prompt under `## Deterministic Drift Report`. The `drift_report` event carries `passed`, `errorCount`, `warningCount`, and `findings`.

The transcript paints `Drift` in `text` tone and each separator in `textDim`. A passing report with no errors or warnings adds `clean` in `success` tone. Warning counts use `warning`; error counts and `failed` use `error`. A warnings-only report reads `Drift · N warnings`. A failed report adds `failed` and each non-zero error or warning count.

The transcript lists error and warning findings under the headline, errors first, indented two columns. It shows at most three findings. When more findings exist, it shows a `+N more findings · click` row. A mouse click on the drift rows shows all error and warning findings. Another click hides the findings beyond the first three. The transcript never shows information findings.

An older event without findings shows only the headline. A closed run's `Run` block also shows a `Scope` row with `clean`, `1 error · 1 warning`, or `not checked`.

**When to use.** No setup needed; the report is the deterministic input to the planner reviewer's qualitative judgment. SPLITBRIEF has no cross-task drift chains and no drift score. The configuration loader ignores the retired `workflow.driftChainThreshold` key and emits one notice.

### Checks log

**What it does.** Per-task validation, retry, consult, pre-review and final-review log. Each task entry carries a `checks` array, one entry per check run: the registered `test`, `cmd` and `render` checks and the reviewer checks, each with its id, command, exit code, a bounded output tail, its artifact paths and their sha256, the workspace snapshot it ran against, and its time. The log replaces the prose evidence matching — an older `evidence.json` still loads, with its retired `expectedEvidence`/`observedEvidence` fields optional and ignored. Once the run records work on a brief, its entry carries the hash of its own brief (`briefHash`), so post-hoc audits can detect brief mutations. Run output, such as check results, does not change that hash. The review packet prints a `## Checks Log` section with each entry and each path the run read outside the workspace (`isolation_outside_read`), or `No checks recorded.`

**How to use.** Always runs. Persisted at `.splitbrief/sessions/<id>/evidence.json` (mode 0o600). A closed run reads it twice over: it seeds the `Briefs` section with every planned brief, and its validated count closes the Run block's `Review` row (`3/3 briefs validated`). A fix task appended after the ledger existed is added to it, so the count includes it.

---

## TUI features

### Slash commands palette

**What it does.** Runtime commands use slash names (`/help`, `/usage`, etc.), but the same registry backs composer `/` input and the command palette. Type `/` to open the inline picker. It lists the commands whose names start with the typed word, and `⏎` runs the highlighted row. A typed line runs only on an exact command name, ignoring case; there are no aliases. An unknown name runs nothing: the error suggests a close name (`Did you mean /usage?`). The command palette ranks commands by fuzzy match. Every one of the 23 commands carries exactly one of five categories — Navigate, Crew, Workflow, View, Input & output. The palette and the help overlay group their rows by category and show the category headers when the panel has room for at least 12 rows. Commands that take an argument prefill `/<name> ` in the composer instead of running bare, so no row errors on Enter.

**Navigate**

| Command | Purpose |
|---|---|
| `/help` | Show help overlay (Ctrl+/) |
| `/palette` | Open command palette (Ctrl+K) — typeable, hidden from the palette's own list |
| `/skills` | Skills for every seat (any screen; Ctrl+S on home) |
| `/sessions` | Browse past sessions |
| `/settings` | Crew, fallback, validation, workflow (Ctrl+,) |
| `/home` | Return to home screen |
| `/quit` | Exit application (Ctrl+Q) |

**Crew**

| Command | Purpose |
|---|---|
| `/crew [plan\|build\|review]` | Who fills each seat — bare `/crew` opens Settings with the cursor on `plan`; `/crew <seat>` opens that seat's picker overlay directly |
| `/refresh` | Re-detect available tools |

**Workflow**

| Command | Purpose |
|---|---|
| `/queue [show\|clear]` | Show or clear the message queue |
| `/run <accept\|reject>` | Accept or reject what this run wrote (rejection needs `/run reject confirm`) |
| `/resume` | Continue a paused or stopped run |
| `/steer <correction>` | Stop now and continue with your correction, including `@file` references. Refusal clears the draft and records history; ↑ recalls it. |
| `/end` | Close the run, saving unapplied changes |
| `/stop` | Open the inline session-options menu (Stop now, Pause after this brief, End run) |

**View**

| Command | Purpose |
|---|---|
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the conversation |
| `/activity` | Expand or collapse the latest activity batch |
| `/diff` | Expand or collapse the latest diff (Ctrl+D) |
| `/sidebar` | Show or hide the workflow sidebar |
| `/tasks` | Show the brief list — opens the sidebar and leaves it open (at or below 120 columns there is no sidebar, so the command answers with the list itself) |
| `/usage` | Open token and monetary details for the run |

**Input & output**

| Command | Purpose |
|---|---|
| `/copy [message\|brief\|path\|command\|cost]` | Copy to clipboard |
| `/image <path> \| list \| remove <index-or-id>` | Attach, list or remove images for the next planner call |

**Capability-aware `/image`.** The command is offered only when the PLAN seat can actually receive images:

| PLAN seat | Images |
|---|---|
| `cli` Claude Code | yes, on stdin |
| `cli` Codex, OpenCode, Copilot, Kilo Code | yes, by a file flag |
| `cli` Cursor, Command Code, Antigravity | no |
| `api` | only when detection reports the model as vision-capable |
| `shell`, `agent` | no |

On a seat without vision the row is hidden and typing the command answers `PLAN seat cannot see images — pick a vision model with /crew plan`, instead of dropping the attachment silently at call time.

`/mode`, `/revise-spec`, `/revise-plan` and `/approval` were removed; typing one prints `<name> was removed: <pointer>` (`REMOVED_COMMANDS`). A change to the plan is requested on the plan card.

Full reference: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

### Command palette overlay (Ctrl+K)

**What it does.** Fuzzy search across slash commands, live tasks, recent sessions, and user-defined custom actions. Recently used items rank higher within each query (in-memory MRU).

**How to use.** `Ctrl+K` opens it from any screen. Arrow keys + Enter to select; Esc to dismiss.

**Configuration.** Add custom entries:

```yaml
palette:
  customActions:
    - id: usage
      label: "Show token usage"
      command: /usage
```

### Help overlay (`Ctrl+/`)

**What it does.** Shows the slash commands you can run now, grouped by category, then the key bindings for the current screen. Help uses the same filter as the command palette: it leaves out hidden commands, commands for another screen and commands that cannot run in the current state. Press `Ctrl+/` from any screen.

### Sessions picker

**What it does.** Browses saved runs from `.splitbrief/sessions/`. Open via `/sessions` or from the home screen. Each row shows a status icon, the feature, the relative time of its latest stop or end, else its start time, and the run's state in words (`sessionStatusWord`, `src/core/sessions/display.ts`): `running`, `waiting for you`, `stopped`, `ready to apply`, or the closed outcome `applied`, `discarded`, `ended` or `complete`.

Applied and complete runs use `●` (`*` on the ASCII tier). Ready, waiting and stopped runs use `◌`. Discarded and ended runs use `×`. Running runs use `◉`.

Sessions are execution records scoped to one workflow each. The plan card is scoped to the current session's plan: its summary, decisions, criteria, tasks with their checks and batches, and the protected writes it lists.

### Settings overlay

**What it does.** One overlay for Crew, Fallback, validation and workflow defaults. Open via `/settings` (Ctrl+,). Writes back to `.splitbrief/config.yaml`. Crew is first, then Fallback. See [Seat fallback](#seat-fallback) for its rows and picker.

**The help block.** The bottom of the panel explains the highlighted row and nothing else. A labelled rule heads it — `Plan approval ────` to the right edge, the same rule a closed run's ledger uses for its sections — carrying the row's own label, or the seat word on a crew row. The block is bottom-anchored and five rows tall: the rule never touches the last row of the list, and under it sit at most three rows of help, so the legend stays put and nothing below it ever shifts as the cursor moves. A bounded number keeps its range on the line that names it (`Max retry attempts per task · 0–10`); an enum adds a row listing its options (`plan · none` on Plan approval). There is no Mode row.

**Reading the list.** Values are as bright as the labels they belong to; only the section headers, the help and the key legend stay dim. The blank row between sections is spent only where the list has rows to spare: below an 18-row list budget the sections close up, which is what keeps a settings row on screen at 80x24 rather than a gap. An unset `Test command` reads `auto`, the stack's own runner, not a dash. The legend names the one key the highlighted row answers to: `space cycle` on an enum, `space toggle` on a boolean, `⏎ edit` on a string or number, `⏎ change seat` on a crew row, `⏎ change fallback` on a fallback row.

**The Isolation row.** The Workflow section offers `Isolation` for every build seat. Space cycles `worktree` → `staged copy` → `your checkout` → `worktree`. Settings saves the YAML values `worktree`, `staged-copy` and `none`. Its help lists the three display labels.

### Settings ∋ Crew

**What it does.** The crew section is one row per seat — `PLAN`, `BUILD`, `REVIEW` — each carrying the seat identity (`Claude Code CLI · Claude Sonnet 4`) and a right-aligned posture word. There is no rail and no connector glyph; the seat label, coloured and bold, is what groups the block. A REVIEW seat with no `reviewer:` block reads `REVIEW = PLAN`.

**Seat rows.** A crew row is read-only. Effort, fast and thinking are chosen in the seat's model picker, and the row mirrors the result as a suffix of the seat identity; `⏎` on a seat row is what opens that picker. The row has no fallback line. An inherited REVIEW seat reads `REVIEW = PLAN`. There is no escalation row or picker: the retired `escalation` block has no crew row, and the planner's consult runs on the PLAN seat.

**How to use.** `/crew` opens Settings on the crew section; `/crew plan`, `/crew build` and `/crew review` skip Settings and open that seat's picker. Ready-made crew presets are offered only on the first-run Setup screen, never here. At small viewports the block drops the lab verdict line when the rows outgrow the budget, and the posture column when the identity column would fall under its minimum width — so all three seat rows stay visible down to the 60x18 floor.

### Seat pickers

Start the local server yourself, configure its address, and use Retry to check the connection. Each PLAN, BUILD and REVIEW seat can use its own Ollama, LM Studio or llama.cpp endpoint and exact model. A server listing is not a promise that a model is loaded. Local authentication is optional; the connection editor retains endpoint-policy checks. CLI authentication stays host-configured unless the exact installed invocation has enforcement evidence, and the current matrix has none.

**What it does.** One two-column tool/model picker serves PLAN, BUILD and REVIEW in two slots. Enter on a Crew row opens the `seat` slot. Enter on a Fallback row opens the `fallback` slot, with only CLI tools the seat can host. See [Seat fallback](#seat-fallback) for the None row, custom models and inheritance notice.

**Model rows.** One authoritative lane per tool renders the model rows. models.dev is metadata-only enrichment (context window, pricing, release date, display name) and never creates a row for a tool that has an authoritative lane of its own. `codex`, `opencode`, `kilo-code`, `cursor`, `command-code` and `antigravity` (`agy models`) render their own `--list-models`-style native output as `Detected` rows. Rows remembered from an earlier run render as `Stale`. A successful read that omits cached rows also makes the catalog `Stale` while it retains those rows. New rows appear at once. A row disappears only after two consecutive successful reads omit its id. See the [CLI catalog cache rules](./SUBSYSTEMS.md#5-detection) and [CLI runner configuration](./CONFIGURATION.md#kind-cli). `claude-code` has no listing command, so it renders one row per shipped alias — `sonnet`, `opus`, `fable`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]`, `fable[1m]` — each labelled in Claude's own vocabulary (`Sonnet 5.5`, `Opus 5.5 Plan Mode`, `Fable 5.1 (1M)`); `default` is not one of them, it is the Auto row; the local `~/.claude.json` `additionalModelOptionsCache` folds in by a specific rule — an entry merges into the one alias row whose resolved catalog id plus that alias's own bracket suffix it equals, case-insensitively, and whose key is already among the shipped aliases, lending its `description` to that row as `detail`; otherwise it renders as its own row under the cache's own label or, failing that, its id; and an unknown id you type through is passed to the CLI unvalidated, because Claude Code does not validate it either. `copilot` lists its own models non-interactively, so the picker renders the quoted ids `copilot help config` prints under its `model` key (25 on 1.0.77), enriched from models.dev `github-copilot`, with the tools-column byline `not verified for your plan`; the bundled rows stand in only when that listing is unavailable. Confirmed rows keep the tool's own order and are not re-sorted by release date. Dedup is by a suffix-aware canonical id, so a `:free` catalog twin folds into its provider-qualified runtime row; a display name is never a dedup key, so two genuinely different ids are never collapsed for printing the same. Context windows are floored and never carry an empty decimal: a 1,048,576-token window reads `1M`, 1,100,000 reads `1.1M`, 262,144 reads `262K`. When the configured model is absent from the authoritative list the picker keeps a recovery row for it. The one explicit "Browse the full catalog" row is offered only where browsing actually widens the list — where the authoritative lane hid bundled rows, as for a local `api` provider with no inventory of its own — never beside a recovery row the escape cannot help; nothing speculative appears otherwise.

**Option families.** Detected models whose ids differ only by effort, speed or thinking fold into one row that expands into an axis row per axis. Suffix peeling is provider-aware, so a provider-routed (`provider/model`) id folds into its family per route instead of keeping a row of its own, and a family that also spans providers expands into one provider route row per route, each followed by that route's own axis rows — so every spelling of every route stays reachable. A genuinely branded id with no sibling to fold with (`opencode/grok-code-fast`) stays flat, spelled exactly as the tool listed it. Only custom models keep their own rows. `space` cycles the axis under the cursor in place, moving the draft onto that axis's route, and `⏎` confirms the drafted id: its own route's from a route or axis row, the family's from the parent.

**The effort axis.** A model whose own source publishes an effort ladder carries one more axis than its id spells: an `effort` row built from that ladder — the route's own where a route publishes one (OpenCode's listing records each model's `variants` — `opencode api GET /api/model` on 2.x, `opencode models --verbose` below 2.0.0), the row's otherwise (a documented flag ladder, models.dev `reasoning_options`). It is not id-encoded, so there is nothing to peel, and it replaces the id-composed `effort` rather than joining it: no route ever shows two rows labelled `effort`. A model that publishes no ladder gets no row, even where a sibling route of the same merged row offers one; a model with no routes at all — a `claude-code` alias — becomes expandable for it. A seat that cannot spend a level carries no ladder either, whatever its models publish: `cursor` and `antigravity` spell their effort inside the model id, and an api, shell or agent seat has no field for one. The row heads its route's block, ahead of that route's fast/thinking rows, cycles with the same `space`, reads `auto` until something is drafted, and confirming saves the drafted level into the field the seat's channel spells — `effort` on a flag-channel tool, `variant` on a variant-channel one — from the same ladder the row offered, so a level the row let you reach is a level the save keeps. Antigravity lists one model id per effort level (`gemini-3.8-flash-high`, `gemini-3.8-flash-low`): its `effort` row is the id-spelled axis, so stepping it moves the seat onto that level's id, and the saved model is the level that runs.

**Narrow widths.** A picker row never cuts a word. A model name keeps its whole leading words (`Gemini 3.8…`, never `Gemini 3.8 Fla…`), and a name another row also starts with keeps its whole trailing words instead (`…Fin (free)`). Two models listed under one name read as that name and the id that tells them apart (`DeepSeek V4.1 Flash · deepseek-v4.1-flash`). Cut, such a row keeps the name and cuts the id from its end (`DeepSeek V4.1 Flash · deepseek-v4.1…`); it gives up the leading words of the id instead only where the end cut reads like another row (`DeepSeek V4.1 Flash · …v4.1-flash`). The list gives up a cell such as `2 providers` before it gives up the name. Where the room cannot hold the name beside the id, the row keeps the end of the id (`…deepseek-v4.1-flash`), because the name is the same on both rows, and the line under the lists names the highlighted model. A cut never opens on a separator (`…deepseek-flash`, not `…· deepseek-flash`). Only twins no whole-word form can tell apart in the room are cut inside a word. A route row keeps its provider whole and gives up its sign-in word first (`signed in · api key` sheds `api key`, then goes); an axis row keeps its value whole and gives up the axis name first; a tool row drops its version before its name sheds a word. Before a word goes, the row spends its blank chevron and check cells, so its value may run past the column. A status word (`Unavailable`, `Auth required`) shows on every status row of the tool list or on none, because a list that states it on one row and not the next reads as though the others are ready.

**Custom model entry.** `+ Add custom model…` offers example ids from the highlighted tool's own listing, spelled as that tool takes them: Claude Code shows the full ids its aliases resolve to (`claude-sonnet-5-5`), Kilo and OpenCode `provider/model`, one example per provider. A tool whose listing has not landed names the command that lists its ids instead (`an id from kilo models --verbose`). A custom row whose display name equals a listed row's name reads its own id (`claude-opus-5-5`) with the `Custom` tag, and the listed alias row keeps the plain name, so the two stay two selections (`src/features/runners/model-row-plan.ts`).

**A refused save.** A save the config refuses leaves the picker open and takes its byline in the error colour until the error clears, because the overlay hides the composer that would otherwise carry it. The line names the field and the rule the new config broke (`Failed to save config: planner.outputFormat: …`), not only the file. A second `⏎` while a save is still in flight starts no second write, so one confirm stays one save. A save refused because another writer changed the config keeps the bytes that writer put on disk and says `Config changed on disk. Reload before saving again.`; the focused row retries after a failure.

### Build progress block

**What it does.** While the run is `implementing` or in the final review, a persistent block sits under the header rail at every width and says what the build is doing without a scroll:

```
3/7 briefs passed · attempt 2 of 8
OpenAI Codex CLI · implementing · last event 3s ago
```

The fraction counts briefs that **completed under their review cadence** — a started brief is not a settled one, and an escalated brief is never counted as settled. Attempts are stated as attempts (`attempt 2 of 8`), never as retries: the count and the maximum come from `lineageAttemptsOf(state, task)`. Every `implementer_generate_running` event records the next lineage attempt and its allowance (`lineageAttempt`, `attemptAllowance`), including consult and answer attempts. A brief continued after a granted allowance reads `attempt 7 of 12`. The transcript records a Retry row only for a real retry, using the same counter. The count shows only from attempt 2: a brief's first attempt is the normal case, so the counts line carries no attempt. No surface prints an ETA. The activity line names the seat and the operation. A build call reads `<runner> · working on T003`, using the call's task id, or `<runner> · working` without one. A consult names the seat that answers it: `PLAN · <runner> · answering the consult on T003`, or `REVIEW · <runner> · answering the consult on T013` for a fix task in any build phase. A blocked report and a stale refresh consult while the run implements. Only a fix task's consult runs a review-seat call under a task id. A review-seat call without a task id is the scheduled task review or the review-checks call, and reads `<runner> · reviewing`. Build summary and compaction calls read `<runner> · summary` and `<runner> · compaction`. Between calls, Build reads `Between calls` during implementation or task validation, and `Waiting for the consult answer` during escalation. While a plan check, a reviewer check, its base re-run or a fix brief's fix check runs, the activity line names the check and its command (`Review · Reviewer check V1 · npm test`, `Review · Base re-run V1 · npm test`, `Fix check V1 · npm test`). The freshness line then reads the command's own clock (`running 10:02`, or `running 0:35`, using `formatElapsedClock` just like the byline). The freshness line is the one place the block states silence, and it counts every second: `last event 8s ago`. Check, suite and base events count as runner events for freshness (`full_suite`, `checks_run`, `validate`, `review_checks`). Once the idle watchdog has warned that a seat on a call has sent nothing — five minutes by default (`RUNNER_IDLE_WARN_MS`, tunable per runner as `idleWarnMs`), never below the 60 s floor `UI_IDLE_WARN_MS` — the line names what the seat is doing through the silence. A tool the stream opened and has not closed reads `No output for 5:12 · running npm test`. `opencode` and `kilo-code` report a tool only when the tool ends, so they read `No output for 5:12 · tools report when done`. Any other runner reads `No output for 5:12`. The clock continues to count, and output clears it. The watchdog never ends the call: press Esc to stop it resumably. A running command is no seat's silence, so its own clock replaces `last event …`. The block is two rows at 120 columns and wider (counts, then activity and freshness on one row; `buildProgressRowCount` receives the chrome content width, so the threshold is 118 columns) and three rows below, in the build and in the final review alike (`buildProgressRowCount(contentWidth)` in `layout/chrome-rows.ts`). During the final review no brief runs, so the block shows no attempt. Without a matching steerable call, the composer invites `Message REVIEW · read at its verdict call…`. With one attached, it reads `Message REVIEW · read after this tool…`. With no call running in the final review, the activity line reads `Review · waiting for the verdict` and freshness reads `last event … ago`, or stays blank before the first event; a running reviewer check or base re-run reads `Review · Reviewer check V1 · <command>` or `Review · Base re-run V1 · <command>` on its own clock. A fix check runs in Build and reads `Fix check V1 · <command>`. Summary and compaction calls read `Review · Summary` and `Review · Compaction`, without the reviewer identity. An appended fix task counts as not passed until its attempt passes.

### Input footer

**What it does.** One byline under the composer carrying the run's live state.

**Format.** The lead is the live status — `⠙ Implementing… 1:12`, `⠙ Planning… 0:41` during the planning session (`Compiling briefs…` only on an older run's briefs call), `⠙ Review · Reviewer check V1 · npm test 10:02`, `⠙ Review · Base re-run V1 · npm test 0:41` or `⠙ Fix check V1 · npm test 0:40` while a reviewer check runs, or `⠙ Review · Render workflow-x 0:12` while a plan render runs, counted from the start of that command, `⠙ Review · waiting for the verdict 0:14` during the final review (naming the reviewer seat only while its call runs, such as `⠙ Review… Claude Code CLI 1:02`), `Waiting for your answer`, `⚠ No output for 5:00` (not while the build block is on screen, whose freshness line states the silence and leaves the byline its live status; where no block is painted — during planning, or while the stop menu takes its rows — the byline carries the count), a stop state such as `Stopped at T003 · Partial changes kept`, `Stopped before T003`, `Stopped before the review`, or the closing `Stopped by you` / `Build failed`. After it, in this order and dropped from the right as the width shrinks: a hint, the queued text, and the worktree name.

Queued text names the receiving seat. Examples are `1 queued for PLAN`, `1 queued for BUILD on T003`, and `1 queued for REVIEW`. A narrow byline uses `1 queued`.

The elapsed time is the step's own, formatted with the single `formatElapsedClock` (`m:ss`, or `h:mm:ss` once past an hour). During planning the step is the planner call that is open, counted from the moment that call opened; the first call after the run starts or resumes counts from that start, so the preparation before it stays on the clock. In the build and the final review the step is the stage. A resume starts the clock again, and the minutes the run spent waiting on you — a planner question, an approval gate — are subtracted, so answering a question does not make the next brief look slow.

Enter with text queues a message for the seat that reads it next: the seat of the active stage, or REVIEW while a task review runs inside the build (`workflow.review: task`), because the review reads every unread message at its verdict call. The current call continues. Without a matching steerable call, the composer names that seat and its delivery time:

| Stage | Placeholder |
|---|---|
| PLAN | `Message PLAN · read at its next call…` |
| BUILD | `Message BUILD on T003 · read when its call ends…` |
| BUILD, while the brief's checks run | `Message BUILD on T003 · read after its checks…` |
| REVIEW | `Message REVIEW · read at its verdict call…` |

See [Message queue](./ENGINE.md#message-queue) for each seat's delivery rules, corrections during checks, and retry behavior.

The `queueCopy` function supplies the placeholder, byline, transcript labels, and `/queue show` output. It also supplies feedback. For a message to BUILD on T003, the surfaces read:

| Surface | Text |
|---|---|
| Byline and `/queue show` | `1 queued for BUILD on T003` |
| Feedback | `Queued for BUILD on T003 · ctrl+⏎ sends now` |
| Transcript, pending | `Queued for BUILD on T003 · read when its call ends`, or `· read after its checks` while the brief's checks run |
| Transcript, delivered | `Delivered to BUILD on T003` |

When a steerable call of the receiving seat is attached, SPLITBRIEF offers the message to that running call. The seat reads it after its current tool. `steerable_call` events tell the UI which call can receive messages. One copy function supplies these texts:

| Surface | BUILD on T003 | PLAN | REVIEW |
|---|---|---|---|
| Placeholder | `Message BUILD on T003 · read after this tool…` | `Message PLAN · read after this tool…` | `Message REVIEW · read after this tool…` |
| Feedback after Enter | `Sent to BUILD on T003 · read after this tool · ctrl+⏎ interrupts` | `Sent to PLAN · read after this tool · ctrl+⏎ interrupts` | `Sent to REVIEW · read after this tool · ctrl+⏎ interrupts` |
| Transcript, pending | `Queued for BUILD on T003 · read after this tool` | `Queued for PLAN · read after this tool` | `Queued for REVIEW · read after this tool` |
| Transcript, delivered mid-call | `Delivered mid-call to BUILD on T003` | `Delivered mid-call to PLAN` | `Delivered mid-call to REVIEW` |

The byline stays `1 queued for BUILD on T003` until the first delivery event removes that message from the queued count. PLAN and REVIEW use the same byline pattern. Without a matching steerable call, the copy in the first table stays unchanged.

`message_queued` has optional `steerable: boolean`. It records whether the queue captured a matching call for this submission. The transcript uses this saved value to select the pending row's delivery timing.

`message_queued` and `queue_drained` supply the transcript's optional `seat` and `taskId`. A mid-call delivery adds `via: 'mid-call'` to `queue_drained`. Older events without these fields still render. `/queue show` reports the queued count. `/queue clear` removes only messages awaiting first delivery. See [Queued count](./ENGINE.md#queued-count) and [Delivery to a running call](./ENGINE.md#delivery-to-a-running-call) for state fields and delivery outcomes.

`ctrl+⏎` with text stops now and continues with the text and attachments, like `/steer <text>`. Suggestions and runtime commands keep their own Enter behavior. A terminal without extended keys reports this key as Enter, which queues the message. `/steer` works in every terminal.

**Steer, queue, interrupt.** The composer means a different thing in each state, and its placeholder says which:

- **Queue** — Enter with text queues a message for the active stage's seat. The tables above show its delivery copy. `/queue show` reports the queued count. `/queue clear` removes only messages awaiting first delivery.
- **Steer** — while the run is parked (`Stop now`, or an interrupted call), a blank Enter resumes a run parked in this process exactly as `/resume` does, and typed text steers it. A continuable run at rest resumes on a blank Enter. `/steer <correction>` is the explicit form: it stops the run now and continues it with the correction, holding the text through the stop race. It accepts `@file` references. A refused `/steer` clears the draft and records the command in history. ↑ recalls it.
- **Interrupt** — `ctrl+c` stops the run at once, `esc` opens the stop menu. Neither is reachable by typing.

**Mid-call steering.** Claude Code and opencode seats take your message mid-call, right after the current tool, when the call carries a steering port. The current tool continues without interruption. Other seats take your message after the call, in the correction pass. Codex never uses mid-call steering. See [Mid-call steering](./PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for supported versions and transports.

### Run result menu

A ready workspace run shows an inline result menu above the composer. The rows are **Apply · Show diff · Discard**. Use Up/Down to select and Enter to confirm. Tab switches focus between the menu and composer. Bare letters do not select actions; the composer takes slash commands.

**Show diff** writes the run patch and opens it in the editor that `VISUAL` or `EDITOR` names. When neither is set, it opens the patch in `PAGER`, or in `less` when `PAGER` is unset; press `q` to return to the run. **Apply** uses [`/run accept`](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject). **Discard** uses `/run reject confirm`. Their effects are in [Apply](./WORKFLOW.md#apply). The menu lives in `src/features/workflow/result/`.

The byline under the menu reads `Ready to apply · pick Apply, Show diff or Discard`. An Accept as is override changes the first row to **Apply as is**, and the byline to `Ready to apply as is · pick Apply as is, Show diff or Discard`. Its confirmation lists the open findings and offers **Apply as is** or **Back**. See [Accept as is](./APPROVAL-AND-RECOVERY.md#accept-as-is).

### Run screen at rest

**What it does.** The workflow screen is the run's home whether anything is running on it or not. Opening a run from `/sessions`, from the home list or from the palette replays its `session.jsonl` into the workflow stores and shows the run exactly where it stopped: the same header rail, the same transcript, the same footer. Nothing navigates to a second screen, and continuing the run flips it back to live in place. There is no summary screen.

**Format (header).** The rail has Plan, Build and Review stages; a checkout-mode run (`workflow.isolation: none`) has no Apply stage. A worktree or staged-copy run adds an Apply stage, pending while the run is ready, done when applied, cancelled when discarded, and marked when Apply halted. An ended run has no Apply stage. Cleared stages and the active stage show `●`, and only the active stage is bright and bold; unreached stages show dim `○`. A run that stopped at a halt or on an error shows `✗` on its stage. A final review that failed is its own stage: Review shows `✗` while the run waits on the halt and `×` once the run is ended, never `●`. Every other open run — stopped by you, interrupted, or waiting at a question or a gate — shows `×`. A ready-to-apply or closed complete run shows three `●`. A closed run names its recorded crew; an open run names the crew it will use. The header shows no clock: how long a run ran is stated once, in the closed block's `Ran` row.

**Format (composer and byline).** A ready run shows [the result menu](#run-result-menu). Its composer takes `/commands`; bare Enter does not continue it. An open run takes a correction or bare Enter to continue. The placeholder reads `Type a correction…`, or `Type your answer…` at a question, and stays while the composer has focus. Typed text becomes the next step's steer. The byline names the stop and its action:

- `Stopped at T003 · type a correction or ⏎ to continue` (stopped by you)
- `Waiting at the plan · ⏎ to reopen it` (an older run waiting at its spec or briefs gate reads `Waiting at the plan · ⏎ to continue`: it continues as one planning session)
- `Waiting for your answer · type a reply or ⏎ to continue`
- `Seat down · Usage limit on ollama · ⏎ to decide` (a *Needs you* halt reads `Needs you · <cause> · ⏎ to decide`)
- `Stopped by an error · Planning failed. · ⏎ to retry the step`
- `Stopped at T003 · ⏎ to continue` (the process went away)

A run nothing can pick up says why before where — `Saved state unreadable · start it again from home` — and takes `/commands` only. A run another process is driving reads `Running in another process`.

**Format (closed run).** Applied, discarded, ended and older completed runs take `/commands` only. The placeholder reads `/ for a command · ⏎ for home…`. Bare Enter goes home. The ledger appends to the transcript as a `Closed ─` rule, outcome sentence and these sections:

- One outcome sentence names Applied, Discarded or Ended. Older completed runs keep Complete or Needs attention. Applied and Complete use `●`. Discarded, Ended and Apply undone use `×`. Needs attention uses `⚠`. The fraction counts briefs that passed. Whole ` · ` tokens drop from the right when the line exceeds its width.
- `Briefs` — one row per brief in the saved current plan, including a plan ended at its approval gate before evidence was written. The rows use the transcript's grammar: `● T001 Add validator module  src/validate.ts (create) · passed · 84.2s`, `▲` escalated, `✗` failed, `–` skipped, `×` the brief the run stopped inside (`· stopped · 2 partial files`), `○` a brief that never started. Done rows keep `· <method> · <duration>` at every width. Their shared `fitDetailRun` drops retries before shortening the path by whole directory segments, keeping the first directory and filename (`src/…/form.ts`), then only `…/form.ts` or `form.ts`. Only a filename wider than its remaining room is cut by characters. Settled durations keep their duration format, such as `2m 0s` or `14.0s`. A brief's duration is its working time: a brief that was stopped, steered, parked or halted and then continued adds every stretch it ran, and the time between them is left out. Each brief has one row. Its target label comes from the current plan. The stopped brief keeps retries and duration from its ledger entry, including a failed attempt. Briefs outside the current plan use their recorded ledger target.
- `Earlier work` — present when ledger or spend entries cannot be joined safely to the current plan, as on an older run that rewound its plan. An old T001 remains distinct from a newly compiled T001. A run recorded before each entry carried its own brief's hash keeps whole-plan stamps, so its briefs read as earlier work. The outcome fraction counts only current briefs; the Files section and `/usage` keep the run's earlier work and spend.
- `Files` — the changed set, sorted, project-relative and middle-cut, with ` · partial` on a file the stopped brief left half-written. A run that closes inside a brief books the files that brief left in its workspace first (`persistStoppedBriefEvidence`, `src/engine/orchestrator/evidence/persistence.ts`), so the list names every file `run.patch` holds.
- `Run` — labelled facts, one home each: `Crew` (only when the header named fewer than three seats), `Review`, `Packet`, `Patch` (the project-relative `run.patch` path in the link colour, only when the close saved a patch of changed files), `Scope` (`clean`, or the counts such as `1 error · 1 warning`), `Briefs` (brief quality, only on an older run that wrote `brief-quality.json`), `Ran` (how long the run ran, such as `1m 51s`: time the run sat stopped, halted or at rest is left out, and time it waited on you while it ran counts; `not recorded` on a run recorded before this was kept), `Phases`, `Session`. A fact with no value carries one absence word — `not run`, `not checked`, `not estimated`, `not recorded` — never `—`, `n/a` or `$0.00`. The `Review` row names the review it reads: `final review not run`, also on a run whose task reviews ran. When a reviewer check of that review was red at the run base too, a row under `Review` names it — `V1 pre-existing · <command>` — and one indented row for each of its first three failing tests, then `+2 more`. These failures also fail before the run's changes and raise no finding. The run's cost and token counts are not ledger facts; `/usage` keeps those counters and the spend.

A closed run whose record was never written says so in one line rather than painting an empty ledger: `× Ended · no run record was written`.

Saved task status and matching evidence control stopped-brief attribution, including when an older summary names a reused task ID. Earlier work with no saved file list reads `files not recorded`. Overwritten ledger evidence cannot be recovered. Identical task IDs and brief hashes can leave different plan revisions indistinguishable; the display retains the available records without inventing history.

**Format (closed byline).** A worktree or staged-copy run closed after Apply reads `Undo the Apply with /run reject confirm`. Checkout runs close as complete, without Apply. Once the Apply is undone, the byline reads `Apply undone · nothing left to undo`. If the undo kept files you changed after Apply, it reads `Apply undone · your later edits were kept`. A discarded run that saved a patch reads `Bring the changes back with git apply on the Patch file`. The `Patch` row of the `Run` section names the file. An ended run reads `Ended · bring the changes back with git apply on the Patch file`, or `Ended · esc home` with no patch. End run hands the byline to the closed run at once. A completed run has an empty byline: `esc home` is already in the legend above the composer. A run that needs attention points to its findings, scope deviations or failed briefs. Closed bylines offer no acceptance or rejection of those runs. See [`/run`](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject).

**How to use.** `⏎` on a session row opens the run. `esc` leaves a run at rest for home — there is nothing to stop, so no stop sheet opens. When the transcript outgrows its height it scrolls a line at a time with `shift+↑↓` (plain arrows stay with the composer history and any menu above it) or a page with `pgup`/`pgdn`, the legend gains `shift+↑↓ scroll`, and the byline never scrolls away.

### Terminal colours

The TUI follows the terminal. At fullscreen startup, it reads the background through OSC 11, then `COLORFGBG`. It uses dark when neither is known. There is no theme setting. The project config is shared, and the colours belong to each person's terminal.

Every colour resolves per colour level to a readable value against that background. No text is faint.

Plain commands (`status`, `spec`, `review`, snapshot diffs, the crash line) do not probe. They use `COLORFGBG` when it is set. Otherwise, they use the terminal's own 16 colours.

---

## Hooks (user-declared shell commands)

### Lifecycle hook events

**What it does.** Lifecycle hook events fire user-declared shell commands. `pre_*` hooks block the next action; `post_*` and `on_*` are fire-and-forget.

**How to use.** Declare in `.splitbrief/config.yaml` under `hooks:`. Full list:

| Event | When |
|---|---|
| `pre_planning` | Before any planner phase starts |
| `pre_task` | Before each implementer task |
| `post_task` | After each successful task |
| `pre_validation` | Before a brief runs its checks |
| `post_validation` | After a brief's checks ran |
| `pre_escalation` | Before the planner's consult; a denial raises `retry-exhausted` |
| `on_error` | Any unrecoverable engine error |
| `on_halt` | A recovery issue is raised — carries `sessionId`, `taskId`, `reason`, `recommendedAction` and the `resumeCommand` step that carries the run on |
| `on_complete` | `workflow_complete` event |

```yaml
hooks:
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
```

**Trust.** Hook configs are sha256-hashed and prompted on first use; in CI pass `--allow-hooks`. Each hook run inherits user shell privileges. Full reference: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

---

## Headless mode

### `splitbrief start --json`

**What it does.** Skips Ink, emits a readiness report first, replaces the TUI sink with NDJSON-on-stdout, and stubs workflow host callbacks: the plan card is approved unattended (it confirms no protected operation in advance); planner questions persist as pending input, emit `input_required`, and exit non-zero, as does recovery. A write to a protected path fails closed with `APPROVAL_REQUIRED`. The normal `session.jsonl` log is still written for the run.

**How to use.**

```bash
splitbrief start --json --allow-hooks "add lint rule for empty catch" > events.ndjson
```

**When to use.** CI integration, scripted batch runs, or anywhere a TTY is unavailable.

**Behavior differences.**

- A protected write fails fast. Set `workflow.approve: none` to skip the plan card instead of approving it.
- All other behavior matches an interactive run.

The first line is `{ type: "readiness_report", report: ... }`. After that, `createStdoutJsonSink` in `src/engine/events/sinks/stdout-json.ts` emits one JSON record per line; each engine event arrives as `{ type: "event", data: ... }`.

---

## Operational extras

### `splitbrief status` and `splitbrief init`

**What it does.** `init` is the interactive setup that writes `.splitbrief/config.yaml` (or rewrites it with `--reconfigure`). `status` is read-only — prints the active session state without acquiring the lock.

```bash
splitbrief init [--reconfigure]
splitbrief status
splitbrief doctor [--json] [--probe-seat <plan|build|review>]
```

### `splitbrief resume` / `splitbrief continue`

**What it does.** Picks a run up where it stopped. A run is a durable record: an open run stays continuable, so the only refusals are a missing or unreadable `state.json`, no active pointer, a run whose process is still running or unresponsive, a **ready** run (it takes Apply or Discard), and a **closed** run. [WORKFLOW.md §Run status](./WORKFLOW.md#run-status) owns the status rules. It does not replay finished work — the run picks up at the step its saved state names (`resumeStep`).

```bash
splitbrief resume                                   # the most recent run
splitbrief continue 2026-05-01-add-auth             # a named run
splitbrief continue --action retry --json           # answer its halt, headlessly
splitbrief continue --action end-run                # close it instead
```

For backends without native session resume, the planner context is rebuilt from `session.jsonl` (`transcript/rebuild.ts`).

### Repo-map context for the planner

**What it does.** A token-budgeted PageRank-based summary of the codebase fed to every planner call inside a `<repo-map>` block. Cached at `.splitbrief/repomap.sqlite`.

**How to use.**

```yaml
codebase:
  enabled: true
  tokenBudget: 4000
  include: ["src/**/*.ts"]
  exclude: ["\\.test\\.tsx?$"]
```

The map rebuilds itself on each planning run when the cache is stale; there is no manual rebuild step. Full details: [REPOMAP.md](./REPOMAP.md).

### Text selection and copying

In fullscreen, drag with the mouse or touchpad to select visible text in the composer, transcript or workflow panels. Releasing the drag copies that text to the clipboard. Wheel scrolling and ordinary clicks remain available. Selection does not edit the draft.

`Ctrl+C` copies an active selection, clears its highlight, and reports the copy result. The next press stops active work or arms quit at rest/home; another press quits. Without a selection, the normal stop/quit sequence applies. On macOS, `Cmd+C` is usually handled by the terminal itself. The text is already copied on release, so the usual drag, `Cmd+C`, `Cmd+V` sequence works without a custom terminal keymap. Terminals that forward `Cmd+C` using the extended keyboard protocol can also request a copy directly.

Incoming output cannot replace the text being selected: the display holds still during the drag while the workflow continues, then catches up on release. The highlight survives updates to other text and clears if the selected content changes. Typing, paste, `Esc`, scrolling or resizing clears it. `--no-mouse` leaves selection to the terminal instead.

### Image attachments

**What it does.** Attach screenshots or images for the next planner call (multimodal-capable backends only). A pasted or dropped image lands in the draft itself, as one atom at the caret shown as `[image #1]`, with editable text on either side; moving and deleting act on the whole atom. Submitting hands the draft's images to the workflow store in document order and sends the planner an `[image:<id>]` reference at each atom's position plus a legend binding those ids to the attachments. `/image <path>` also inserts an inline image.

Images from `/image`, drop, or paste may come from any folder. SPLITBRIEF follows symlinks and records the resolved path. Each file must exist, be a regular file, be at most 10 MiB, and be readable.

A composer reference such as `@x.png` becomes an image on send, like a dropped image. It uses the same image atom and pending attachments. The PLAN seat must support images.

File refusals use `not-found`, `not-a-file`, `too-large`, or `unreadable`. Image-only actions also use `not-image` for unsupported formats. The supported formats are PNG, JPEG, GIF, WebP, and BMP. Feedback names the reason and fix.

A composer send uses `Cannot send: <reason>`. Its file refusals end with ` File: <base name>.`. The base name uses at most 24 terminal cells. `/image` and drop use `Cannot attach image: <reason>` without that suffix.

Sending the directory reference `@/Users/me/notes/` reports `Cannot send: not a regular file. Name a file, not a directory. File: notes.`

Without vision, `/image` reports `PLAN seat cannot see images — pick a vision model with /crew plan`. The dispatcher refuses the command before its handler runs.

Drop, paste, and sending a resolved `@x.png` use the composer's vision check. With a loaded configuration, each reports `Cannot attach: PLAN seat <seat identity> cannot see images — /crew plan`.

Without a loaded configuration, drop and paste report `Cannot attach image: the planner cannot see images. Choose a vision model with /crew plan.` Without a loaded configuration, sending `@x.png` reports `Cannot send image: the planner cannot see images. Choose a vision model with /crew plan.`

**How to use.**

```
/image screenshot.png
/image list
/image remove 1
```

On macOS, copy an image and press `Cmd+V` in Zed's terminal. [Zed 1.20.2 forwards image paste as `Ctrl+V`](https://github.com/zed-industries/zed/blob/v1.20.2/crates/terminal_view/src/terminal_view.rs#L848-L895), which SPLITBRIEF handles by reading the image from the clipboard. When the clipboard also contains text, [Zed chooses the text representation](https://github.com/zed-industries/zed/blob/v1.20.2/crates/gpui_macos/src/pasteboard.rs#L47-L83); pressing `Ctrl+V` directly reads the image instead. Ordinary text paste stays text.

The composer shows `Pasting image…` during the read and keeps text typed meanwhile after the image's insertion point. Wait for `[image #1]` before submitting. Empty, unreadable, oversized, or unsupported clipboard content produces feedback without changing the draft.

Clipboard images are stored as private PNG files under `~/.splitbrief/clipboard/`, up to 10 MiB each. Identical image bytes share a file. These files remain after submission and exit so draft history and recorded attachments can still read them.

Dragging a file onto the terminal also inserts it at the caret. The home composer advertises this with a `drop an image` hint on its legend line; the workflow composer shows no hint because its byline is occupied by live status, but image input works there too. `Backspace` beside an atom takes the whole reference, and that image with it. `/image list` and `/image remove` address attachments already pending for the planner, including command-line `--image` inputs; edit inline draft atoms in the composer.

Quoted drag paths and backslash-escaped paths such as `/Users/me/design\ notes/mock.png` resolve to the same image. A dropped non-image path stays text. Use `@` to attach that file's text.

Offered only when the PLAN seat can receive images; on a seat without vision the command answers with the reason instead of dropping the attachment at call time. Claude Code takes images on stdin; Codex, OpenCode, Copilot and Kilo Code take them by a file flag; Cursor, Command Code and Antigravity take none. An `api` seat takes them only when detection reports its model as vision-capable, and a `shell` or `agent` seat takes none. See the per-seat table under [Slash commands palette](#slash-commands-palette).

### Skills

**What it does.** Loads skills into the picker so every seat — planner, implementer and reviewer — is primed with project-specific knowledge. Source discovery lives in `src/engine/skill-discovery.ts` and does not depend on which tool holds the PLAN seat. It scans one fixed union of roots, listed here in precedence order — project `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `./.github/skills/`, `./.commandcode/skills/`, `./.kilo/skills/`, `./.kilocode/skills/`, `./.cursor/skills/`, then global `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.commandcode/skills/`, `~/.kilo/skills/`, `~/.config/kilo/skills/`, `~/.cursor/skills/`. The path table is `src/core/skills/scan-paths.ts`, and the skills overlay's empty state lists the same roots. Dedup is by skill id and by skill name, first root wins, so project skills always outrank global ones. `<project>/AGENTS.md` is emitted as the `agents-root` entry whenever the file exists.

**Detection.** A directory holding a `SKILL.md` is a skill and is not descended into; other directories are walked to depth 4. Loose `.md` files count only at the top level of a root. Frontmatter that omits `name` falls back to the directory (or file) name; a file with no frontmatter block is skipped. Symlinks are followed in both scopes, but project scope never leaves the project: a project symlink whose target resolves outside the project is dropped, not read.

**Where they reach the seats.** The run renders the selected skills once (`buildSkillsContext`, `src/engine/orchestrator/run/skills-context.ts`) into one `## Active Project Skills` section, and each seat's calls carry it: every turn of the planning session, the consult, each implementer brief and its retries, and the final review, for every runner kind. The plan's context-fit check counts the section the way the worker receives it. A `cli` implementer in its isolation worktree may read an attached global skill's files; a write there halts the brief. A Claude Code planner, reviewer or consult call may read them too, and never write them. Per skill the section says where the skill lives — `Base directory:` for a skill directory, `File:` for a loose `.md` skill (a `SKILL.md` at the top of a root included) or `AGENTS.md`. A project skill, and a global one whose files live in the project, is spelled relative to the project root, so the checkout and an isolation worktree resolve it alike. A project skill git ignores — `.splitbrief/skills` always is — is in no isolation copy, so it is spelled by its absolute path in the checkout and read like a global skill, and so is every other global skill. Then come its `SKILL.md` body and its `references/*.md`. A 16 000-character budget takes every body whole first, in selection order, then the references of each inlined skill, each whole; a body or a reference that does not fit is named by path instead, never cut. A continued run rebuilds the section from the skill ids the run saved when it started. A saved id that no longer resolves, or a selected skill whose file cannot be read, raises a `warning` with code `skills_unresolved` naming it, and the section leaves it out. Each start and continue records the ids of the skills the section carries as `skills` on its `workflow_config` event, so `session.jsonl` names what reached the seats. A body named by path raises a `warning` event with code `skills_truncated` naming its skill (`1 skill over the skills budget, named by path: …`) and the TUI feedback row says the same; a reference named by path is the normal case and raises none. The four pipeline skills (`splitbrief`, `splitbrief-brief`, `splitbrief-run`, `splitbrief-review`) are excluded from this list: the planner gets that contract from the pipeline spec, not from a skill file.

**How to use.** Open the picker via `/skills` on any screen (Ctrl+S on home). Discovery re-runs when the overlay opens or when `/skills` is typed, so a skill added mid-session appears without a restart. `/skills <id> [<id>…]` toggles one or several skills from the composer instead of opening the picker; ids match fuzzily, and the `/` menu completes them project-first, then already-selected global ones, showing each skill's name and description. The command palette also carries one `Skill · <name>` row per discovered skill, which toggles selection directly. From the command line, `--skills <id,…>` selects them without a picker: on headless `start` (`--json` / `--plain`) and on `resume` / `continue` in either mode. An unknown id fails before planning with `Unknown skill: <id> (scanned: <roots>)` and exit 2. Selection applies to the session only. On `resume` / `continue`, `--skills` applies to that continue only: it is not saved, so a later continue without it uses the selection the run saved when it started. Read-only — SPLITBRIEF never writes to skill sources.

---

## See also

- [WORKFLOW.md](./WORKFLOW.md) — phase state machine, abort/queue/continue, resume semantics.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief v1, checks log, drift report.
- [CONFIGURATION.md](./CONFIGURATION.md) — every config field, default, and validation rule.
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — slash command reference, dispatch, phase guards.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — workflow hooks: events, schemas, trust, security.
- [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what) — code-level inventory, event union, persistence layout.
- [API-KEYS.md](./API-KEYS.md), [REPOMAP.md](./REPOMAP.md), [DEBUGGING.md](./DEBUGGING.md).
