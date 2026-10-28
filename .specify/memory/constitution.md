<!--
Sync Impact Report
- Version change: 4.3.0 → 4.4.0. MINOR: Principle V changes the fix check rule. A red settles when no own failure remains. An own failure that an unfinished fix task of the same cycle also carries is left to that task. Failures the brief does not own do not gate it; their fix tasks or the next review answer them. The proof that an original other failure still shows is no longer a gate condition. Fix tasks may share the failures of one pending input. A carried check whose own failures are all test failures runs the stack's test runner on the own test files only.
- Modified principles: V.
- Updated sections: Governance.
- Templates checked: plan-template.md, spec-template.md and tasks-template.md remain compatible. They set no fix-check failure rule.
- Docs and skills: workflow, features, CLI reference, troubleshooting, task contract, how-it-works, engine, architecture, recovery, changelog, the skill recovery references and the generated skill gates references updated.
- Follow-up TODOs: none.
-->

<!--
Sync Impact Report
- Version change: 4.2.0 → 4.3.0. MINOR: Principle V expands. A fix check judges only the failure keys its findings carry for that check id. A red passes only when no carried failure remains and the re-run still shows a key the original red showed that is not the task's own. Otherwise, the command must pass. A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. Keys with no file match exactly. Other failures belong to other fix tasks or the next review. Each judged re-run gets a fix check verdict row. A green re-run shows that all carried failures are gone. A red without proof shows `your N failures not shown · not proven fixed`. Plan and task checks get only a done row, with no duration. A check with no carried keys, or a re-run with no named failure, must pass. Fix checks never re-run at the run base. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass. Older saved fix tasks still load and must pass their commands.
- Modified principles: V.
- Updated sections: Governance.
- Templates checked: plan-template.md, spec-template.md and tasks-template.md remain compatible. They set no fix-check failure rule.
- Docs and skills: workflow, features, CLI reference, troubleshooting, task contract, how-it-works, engine, architecture, recovery, changelog and the canonical skill gates reference updated.
- Follow-up TODOs: none.
-->

<!--
Sync Impact Report
- Version change: 4.1.0 → 4.2.0. MINOR: Principle V expands. The reviewer command policy runs any installed program of any language and refuses only what breaks a named danger rule; plan checks keep the allowlist. A red that the run base re-run cannot compare (a timeout, or no failure keys) is never pre-existing. With `validation.approve_checks: ask` the user runs or skips the reviewer checks, and a skipped check is never a pass.
- Modified principles: V.
- Updated sections: Technical Constraints (Project languages), Governance.
- Templates checked: plan-template.md, spec-template.md and tasks-template.md remain compatible. They name no check program.
- Docs and skills: configuration, workflow, features, concepts, task contract, troubleshooting, CLI reference and the canonical skill gates reference updated.
- Follow-up TODOs: none.
-->

<!--
Sync Impact Report
- Version change: 4.0.0 → 4.1.0. MINOR: Principle V expands. The reviewer chooses the reviewer checks from the project, and SPLITBRIEF runs them under its command policy. Only reviewer checks re-run at the run base. The stack gates and their typecheck, lint and test settings are retired. A failed plan call halts the review the same way a failed verdict call does. A fix task carries the red check it answers, and its brief gate runs that check again before the next review.
- Modified principles: V.
- Updated sections: Technical Constraints (Project languages), Governance.
- Templates checked: plan-template.md, spec-template.md and tasks-template.md remain compatible. They name no stack gate.
- Docs and skills: configuration, workflow, features, how-it-works, task contract, recovery, testing and CLI skill references updated, the generated gates references included.
- Follow-up TODOs: none.
-->

<!--
Sync Impact Report
- Version change: 3.0.0 → 4.0.0. MAJOR: Principle V gives every new red to the review seat and removes brief reopening. Principle I and VI.3 let the same review answer return fix work.
- Modified principles: I, V, VI.3.
- Updated sections: Governance.
- Templates checked: plan-template.md, spec-template.md and tasks-template.md remain compatible. They assign no planner triage call.
- Docs and skills: workflow, task contract, reviewer, recovery, configuration, testing and CLI skill references updated.
- Follow-up TODOs: none.
-->

<!--
Sync Impact Report
- Version change: 2.6.0 → 2.7.0 (MINOR: the Development Workflow section
  expands — the user chooses where the implementer writes; the git
  worktree stays the default, and `workflow.isolation: none` is the
  user's choice to let the implementer edit the checkout directly)
- Modified principles (2.7.0): none; V already keeps the checkout-run
  rules (validation in the real project directory, no Apply)
- Updated sections (2.7.0): Development Workflow (the run workspace bullet
  names the worktree default, `staged-copy`, and `none` as the user's
  choice; SPLITBRIEF never switches to the checkout automatically)
- Templates requiring updates (2.7.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.7.0): none

Prior pass — 2.5.0 → 2.6.0 (MINOR: VI's mechanism text changes — the
  configured review cadence replaces the single review moment; a per-batch
  review and any review outside the configured cadence stay forbidden)
- Modified principles (2.6.0):
  - VI. Identity & Anti-Goals (exception 3: the review runs at the
    configured cadence — `workflow.review` is `end`, one review after the
    final brief, or `task`, which adds one after each completed brief; a
    fix cycle's re-review of the whole run diff continues that cadence; a
    schema repair is a new call inside the same review, because the
    reviewer holds no session (Principle I); the Apply integration
    re-review clause is kept)
- Updated sections (2.6.0): none
- Templates requiring updates (2.6.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.6.0): none

Prior pass — 2.4.0 → 2.5.0 (MINOR: V and VI change mechanism, not
  principle — worktree and staged-copy runs use one run workspace, the
  checkout changes only at Apply, and Apply, Discard or ending the run
  close it; the Apply integration re-review is a fix cycle of the one
  final review. Same precedent as 2.4.0)
- Modified principles (2.5.0):
  - V. Validate Before Checkpoint (worktree and staged-copy runs validate
    in the run workspace; a passed final review or user-accepted
    override makes the run ready to apply; Apply confirms open findings
    for an override and preserves failed and unverified verdicts; Apply,
    Discard or ending the run close it; unapplied work is written to a
    patch before any close that does not apply it; checkout runs and
    older runs without a recorded workspace retain their prior rules)
  - VI. Identity & Anti-Goals (exception 3: the Apply integration
    re-review reads the whole run diff again and counts as a fix cycle,
    so it is not a second review moment)
- Updated sections (2.5.0): Development Workflow (the run workspace bullet:
  the assessed result is applied once, at Apply, instead of promoted per
  task)
- Templates requiring updates (2.5.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.5.0): none

Prior pass — 2.3.0 → 2.4.0 (MINOR: II's mechanism text changes —
  one planning session replaces the fixed research → spec → plan → tasks
  chain, and the configured implementer model's measured context replaces
  the 7B/8K and 27B/16K prompt figures. The weaker implementer stays)
- Modified principles (2.4.0):
  - II. Spec-Driven Development (the workflow line and the prompt-size
    paragraph are replaced)
- Updated sections (2.4.0): none
- Templates requiring updates (2.4.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.4.0): none; the 2.3.0 TODO is done

Prior pass — 2.2.1 → 2.3.0 (MINOR: II's last task rule changes —
  a task's files are guidance; it carries or names every file it needs, and
  the implementer may edit a further project file the change needs, naming
  it in its report. The rest of II is unchanged until the planning rework)
- Modified principles (2.3.0):
  - II. Spec-Driven Development (the sentence "Tasks MUST NOT reference
    external files or assume the model has access to the broader codebase"
    is replaced; the fixed chain and the 7B/8K figures stay for now)
- Updated sections (2.3.0): none
- Templates requiring updates (2.3.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.3.0): amend the rest of II's mechanism text (one
  planning session; the implementer's measured context) with the planning
  rework

Prior pass — 2.2.0 → 2.2.1 (PATCH: V gains one sentence stating that a
  run is a durable, continuable record until the user closes it — a
  clarification of the checkpoint discipline already described, not a new
  principle)
- Modified principles (2.2.1):
  - V. Validate Before Checkpoint (a run is not discarded by stopping; it
    stays continuable until it is closed)
- Updated sections (2.2.1): none
- Templates requiring updates (2.2.1):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.2.1): none

Prior pass — 2.1.0 → 2.2.0 (MINOR: I and VI lose their cost framing —
  the split is justified by capability, and spend is a reported fact rather
  than a promise or a design criterion)
- Modified principles (2.2.0):
  - I. Two-Tool Orchestration (the discipline of not spending the stronger
    tool on mechanical work is restated as a capability argument; the mandate
    to evaluate every architectural decision against strong-model token cost
    is dropped, and so is the "lower cost is a consequence / savings MAY be
    reported" clause)
  - VI. Identity & Anti-Goals (the identity sentence no longer ends on cost,
    and the TUI mandate lists validation results and escalation flow rather
    than cost savings)
- Updated sections (2.2.0): Technical Constraints and the anti-goal boundary
  conditions lose "cheaper model" and "cost tracking" phrasings
- Templates requiring updates (2.2.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.2.0): none

Prior pass — 2.0.0 → 2.1.0 (MINOR: I, V and VI expanded — two roles,
  three fixed seats; the review seat is separately assignable)
- Modified principles (2.1.0):
  - I. Two-Tool Orchestration (two roles fill three seats — plan, build,
    review — and the review seat is the stronger tool's existing final
    review made separately assignable; unassigned, the planner fills it)
  - V. Validate Before Checkpoint (the final review is named by seat
    rather than by role, so a configured reviewer performs it)
  - VI. Identity & Anti-Goals (three fixed seats stated in the identity;
    new anti-goal boundary condition: pointing the review seat at a third
    tool is seat assignment, not a third agent)
- Updated sections (2.1.0): none beyond the principles above
- Templates requiring updates (2.1.0):
  - .specify/templates/plan-template.md ✅ compatible
  - .specify/templates/spec-template.md ✅ compatible
  - .specify/templates/tasks-template.md ✅ compatible
- Follow-up TODOs (2.1.0): none

Prior pass — 1.3.3 → 2.0.0 (MAJOR: I, III and VI redefined):
- Modified principles:
  - I. Cost-Optimal Orchestration → I. Two-Tool Orchestration (ADR-3: the
    identity is orchestrating two coding tools; lower cost is a consequence,
    not the headline promise. ADR-1: the mandate to delegate implementation
    "via the OpenAI-compatible API" is dropped. The discipline of not
    spending the strong model on mechanical work survives unchanged)
  - III. Local-First Implementation → III. Weaker-Model Implementation
    (ADR-1: the implementer is a weaker model, reachable either as a CLI tool
    driving a cheaper model or as an API model — both first-class, user's
    choice. Local inference stays supported but stops being mandated)
  - V. Validate Before Checkpoint (ADR-2: correctness is owned by the smarter
    side — SPLITBRIEF's deterministic pipeline plus the planner's review;
    implementer self-verification is a bonus, not a requirement. Final review
    attributed to the planner, not to Opus specifically. The stop rule is
    qualified to the first failure *attributable to the task*, matching the
    maintainer-accepted glossary amendment and the baseline-relative pipeline in
    `src/engine/orchestrator/validation/run.ts`: a stage already red at the
    run's baseline continues instead of stopping, so the stages behind it
    still get a verdict)
  - VI. Identity & Anti-Goals (ADR-3: identity restated as two-tool
    orchestration. The anti-goal "tool call support for implementer models"
    expires — 2026 local coders are credible tool callers. The other two
    anti-goals stand. `writesFiles: direct` restated as first-class)
- Updated sections:
  - Principle II (task context is inlined for the implementer, which is not
    necessarily a local model — ADR-1)
  - Technical Constraints (implementer transport per ADR-1)
  - Development Workflow (ADR-4: git worktree per run is the default isolation
    for an implementer that writes files directly; promotion into the user's
    real project directory is non-negotiable; a worktree is not a security
    boundary)
- Removed sections: none
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ compatible (generic Constitution Check gate)
  - .specify/templates/spec-template.md ✅ compatible (no principle-specific sections)
  - .specify/templates/tasks-template.md ✅ compatible (story-based organization)
- Follow-up TODOs: none
-->

# SPLITBRIEF Constitution

## Core Principles

### I. Two-Tool Orchestration

SPLITBRIEF orchestrates two coding tools. The stronger one researches the
codebase, compiles Task Briefs, answers escalations, and reviews the
result; the weaker one executes one brief at a time. SPLITBRIEF holds
everything between them: the contract, validation, retry, escalation,
and evidence.

Two roles fill three seats: plan, build, and review. The review seat is
the final review the stronger tool has always performed, made separately
assignable — one stateless, read-only call over the run diff, which
writes no file and holds no session. It returns the verdict and the fix
work. Assigning it to a different tool MUST NOT change the seat count, the contract, or the
review prompt; when it is left unassigned the planner fills it, exactly
as before.

The stronger tool MUST NOT be spent on mechanical work. Research,
specification writing, planning, review, and escalation are the jobs
its capability changes the result on; typing out the edit is not.
Features that consume the stronger tool's attention without a
proportional quality improvement MUST be rejected or deferred.

What a run spent is a reported fact when the prices are known. It MUST
NOT be a headline claim, and it alone MUST NOT justify a feature.

Where the user already pays for a coding tool subscription, that
subscription MUST be usable as the planner — planning MUST NOT require
a separate API key.

### II. Spec-Driven Development

No code is written without a specification. The workflow MUST follow:
plan → implement → validate → review. One planning session produces the
plan: the planner may ask the user questions first, then returns one
typed plan (acceptance criteria, checks, tasks) that SPLITBRIEF checks
deterministically before the build. The specification is that plan's
criteria; there is no fixed chain of planner documents.

Each implementation task MUST be self-contained: all context needed
by the implementer (function signatures, types, current code, test
expectations, constraints) MUST be inlined in the task prompt. Each
task carries or names every file it needs; SPLITBRIEF attaches their
current code, and the implementer may edit a further project file when
the change needs it, naming it in its report.

Each task MUST fit the configured implementer model's measured
context, with room left for the model to work. The implementer stays
the weaker model.

### III. Weaker-Model Implementation

The implementer is a weaker **model**, not a weaker **transport**. Two
paths are first-class and MUST be held to the same maturity in prompt,
isolation, validation, and documentation:
- a runner that writes the files itself, such as a CLI tool driving a
  smaller model (`cli`, `agent` — `writesFiles: direct`)
- a runner that returns file contents as text, which SPLITBRIEF then
  writes, such as an API model (`api`, `shell` —
  `writesFiles: extracted-code`)

The user chooses. SPLITBRIEF MUST NOT favour one transport over the
other in defaults, prompts, isolation, or documentation.

Local inference (Ollama, LM Studio) MUST remain supported, and the
implementation phase MUST work without internet access when a local
model is used. Local inference is no longer the mandated default.

Provider abstraction MUST be thin (baseURL swap via the `openai`
npm package). Adding a new OpenAI-compatible provider MUST NOT
require architectural changes.

### IV. Functional Purity

Zero classes. All modules MUST use pure functions and module-scoped
state only. No class hierarchies, no `this` binding, no inheritance.

ESM imports MUST use `.js` extensions for compatibility with both
`--experimental-strip-types` (dev) and `tsc` output (production).

Error handling follows boundaries: internal functions propagate
errors, boundary functions (CLI, orchestrator callbacks) catch and
handle them. No defensive try/catch in interior modules.

No unnecessary comments. Code MUST be self-explanatory. Comments
are permitted only where the logic is genuinely non-obvious.

### V. Validate Before Checkpoint

Correctness is owned by the smarter side of the split: SPLITBRIEF's
deterministic pipeline and the review seat. The implementer's
ability to run anything itself is a bonus that improves first-pass rate,
never a substitute for either. A task MUST NOT be accepted because the
implementer reports success.

Task completion MUST follow `workflow.review`. With `end`, an ordinary brief
runs no check; it runs only the checks a caller names, such as a consult
`verify`. With `task`, each task MUST pass its own checks and its required
due checks before its scheduled review. Before the final review every
registered check runs, including renders. With `validation.end_checks` on,
the reviewer MUST choose the reviewer checks from the project itself,
and SPLITBRIEF MUST run them under the reviewer command policy: any installed
program of any language, refused only for a named danger rule, with a named row
for each refusal. With `validation.approve_checks: ask` the user MUST choose
Run all or Skip all first, and a skipped reviewer check MUST NOT count as a
pass. A task review chooses
only the reviewer checks that run the related tests. With
`validation.end_checks` off, no reviewer check runs; plan and task checks
still run. Only a red reviewer check at review MUST be re-run at the run base, with
the same command text. Plan checks, task checks and the Apply re-check
MUST NOT run at the run base. SPLITBRIEF MUST refuse a reviewer check whose
package script, task file or interpreter script this run changed. A red that
the run base re-run cannot compare (a timeout, or no failure keys) MUST NOT be
exempt as pre-existing; it reaches the reviewer as not verified at the run base. The run MUST stop at the first
reviewer check with new failures. A failed plan call (a transport error or a
protocol error) halts the review the same way a failed verdict call does; it
is never a pass. Every new red MUST reach the reviewer as a pending input. The same
review answer returns the verdict and the fix tasks. Fix work MUST spend
one fix cycle. A fix task MUST carry the red check it answers: its id, its
command, its output, its file, its own failure keys and all original red keys
per check id. Fix tasks MAY share the failures of one pending input.
Keys MUST come from the full process capture. An incomplete
capture MUST give one placeholder key and require a passing command.
Its brief gate MUST run each check once through the same check runner and
command policy. It MUST NOT re-run a fix check at the run base.
Exact keys MUST pair first. Unmatched diagnostics MUST then pair by message
identity, with only the position removed. Each key MUST pair at most once.
Test keys and keys with no file MUST match exactly.
Every unmatched re-run key MUST count as another failure.
A red MUST settle when no own failure remains. An own failure that an
unfinished fix task of the same cycle also carries MUST be left to that task.
Failures the brief does not own MUST NOT gate it; their fix tasks or the next
review answer them. A check id with no own failures MUST NOT gate the brief
when its findings carry failures for another check id. A check with no own
keys, or a re-run with a placeholder, MUST pass its command. Older saved fix
tasks MUST load and follow that rule. When every own failure of a carried check
is a test failure, the gate MUST run the stack's test runner on the own test
files only; a diagnostic check, an unknown stack and a configured test command
MUST keep the full command.
This rule covers reviewer, plan and task checks. Each judged re-run MUST get
a fix check verdict row. A green re-run MUST show all own failures gone.
Plan and task checks MUST get only a done row, with no duration.
The retry ladder MUST see an own failure that remains before the next review.
Completed briefs MUST stay done. The final review MUST rerun the reviewer checks
after fixes.

Worktree and staged-copy runs validate in the run workspace. The pipeline
writes the reviewed result to the user's project only at Apply. Checkout runs
and older runs without a workspace validate in the user's project.
A red reviewer check at review MUST be compared with the same command at the run base,
by its parsed failing test names or its diagnostic lines. Retry prompts MUST carry
the exact check errors.
The project formatter MUST run on each brief's changed files.
A formatter failure MUST record a warning and MUST NOT reject the brief.

Product-level git commit strategies are optional run-safety and review
features. Agents working in this repository MUST NOT stage or commit;
the maintainer reviews and commits manually.

After all tasks complete, a final review MUST compare the full diff
against the original specification before the workflow is marked
complete. The review seat performs it: the planner unless a reviewer is
assigned (Principle I).

A run is a durable, continuable record until the user closes it. Stopping
one — a park, a gate, a halt, an error, or a killed process — MUST NOT
discard it: the run keeps its place and picks up at the first step it has
not finished. In worktree and staged-copy runs, an assessed result is one
whose final review passed or whose open review findings the user
accepted as an override with "Accept as is". An assessed result makes
the run ready to apply. The override MUST preserve failed and unverified
verdicts and MUST NOT claim that verification passed. Apply MUST list
the open findings and require the user's confirmation before writing
an override. Three things close the run: Apply, which writes the assessed
result to the user's real project directory once; Discard; and the user
explicitly ending it with `CLOSE_RUN`. Before Apply writes, it merges
the checkout's current state into the run workspace; when that merge
changes the reviewed result, the checks run again and the review seat
reviews the whole run diff again. Work that a close does not apply MUST
be written to a patch before the run closes. Checkout runs and older
runs without a recorded workspace close on passing that final review or
the user explicitly ending them. Closing MUST NOT revert what the run
wrote.

### VI. Identity & Anti-Goals

SPLITBRIEF is an **orchestrator of two coding tools** (planner +
implementer) across **three fixed seats** (plan, build, review). One role
plans and reviews, the other executes, and SPLITBRIEF holds the contract,
validation, retry, escalation, and evidence between them. Running the
sides on models from different labs is part of the value: a reviewer that
did not write the code does not repeat its own blind spots.

The collaboration between planner and implementer MUST be **visible,
understandable, and satisfying to use**. Beautiful visualization of the
orchestration is part of the product identity — not scope creep. The TUI
MUST expose the planner/implementer dialog, validation results, and
escalation flow so users see and feel the value.

SPLITBRIEF is NOT:
- A universal AI connector that "connects any AI to any AI"
- A multi-agent coordinator (Claude Squad, Overstory, Agent Orchestrator)
- A generic orchestration framework with N dynamic agents

Features and proposals MUST be evaluated against this identity. Additions
that push SPLITBRIEF toward generic multi-agent orchestration MUST be
rejected unless they directly serve the two-tool split.

Explicit anti-goals that MUST NOT be implemented:
- Generic agent-wrapping-agent patterns with dynamic agent counts
- Features that blur the planner/implementer boundary

**Permitted exceptions**:
1. Delegating file writes to the implementer (`writesFiles: direct`) is a
   first-class path, not a concession, as long as SPLITBRIEF retains
   ownership of validation (plan checks and reviewer checks), retry, escalation,
   checkpoints, and the overall workflow.
2. Rich visualization of the two-role orchestration (structured event
   cards, diff views, pipeline progress, token telemetry) is encouraged
   as product differentiation, not multi-agent coordination.
3. Pointing the review seat at a third tool is seat assignment, not a
   third agent. It violates none of the anti-goals above: the seat count
   stays fixed at three, so there is no dynamic agent count; the reviewer
   is invoked by SPLITBRIEF and never by the planner, so nothing wraps an
   agent in an agent; and it exchanges no messages with the other seats —
   it reads the run diff and returns a verdict and fix tasks — so there is
   no coordination layer. The one review cadence is the configured `workflow.review`:
   `end` reviews once, after the final brief; `task` also reviews after
   every completed brief, with the final review at the end. A re-review of
   the whole run diff after each fix cycle continues that cadence, not a
   further review moment, and a schema repair of a malformed typed answer
   is part of the same review — a new call, because the reviewer holds no
   session (Principle I). A per-batch review, a review of anything other
   than the run diff, or any review outside the configured cadence would
   cross into the anti-goals and MUST be rejected. Interrupt-and-continue
   of the single review call is the same continuation mechanism every
   other seat uses and does not create a second moment. Neither does the
   Apply integration re-review: when the merge at Apply changes the
   reviewed result, the review seat reads the whole run diff again, and
   that re-review counts as one fix cycle of the final review.

## Technical Constraints

- **Runtime**: Node.js 22+; development runs through `tsx`, production runs compiled `tsc` output from `dist/`
- **Language**: TypeScript 6.x, ESM only (`"type": "module"`)
- **TUI**: Ink 6.x (React 19 for CLI), conversation flow layout with structured event cards
- **Target**: macOS (primary), Linux (secondary)
- **Project languages**: TypeScript and JavaScript are the primary stack. The reviewer
  chooses the reviewer checks from the project itself, and the reviewer command policy
  runs any installed program of any language. Plan `cmd` checks keep the allowlist:
  the package managers, `make` and `just` on a bare `typecheck`, `lint` or `test`
  target, and the tools of the five registry stacks.
  SPLITBRIEF records every refused command as a named row. A planner `test` check
  also resolves for Python, Go, and Rust
- **Planner**: Pluggable runner kinds via config: `cli`, `api`, `shell`, and `agent`
- **Implementer**: The same four runner kinds as planner. Runners that write files themselves (`cli`, `agent` — for example a CLI tool driving a smaller model) and runners that return file contents as text for SPLITBRIEF to write (`api`, `shell` — for example an API model) are equally supported; the user picks, and the write mode follows from the kind
- **Edit format**: Whole-file replacement for files under 200 lines,
  search/replace blocks for larger files

## Development Workflow

- Features MUST be specified using SpecKit (`/speckit.specify` →
  `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`)
- Tasks MUST be organized by user story, not by technical layer,
  to enable incremental delivery and independent testing
- When product-level commits are enabled, each commit MUST correspond
  to one completed task or checkpoint
- The user chooses where the implementer writes with
  `workflow.isolation`. A git worktree per run is the default;
  `staged-copy` is the explicit alternative and the fallback when the
  worktree is unavailable. `none` is the user's choice to let the
  implementer edit the checkout directly: validation and review run
  there, a passing review closes the run, and there is no Apply.
  SPLITBRIEF MUST NOT switch a run to the checkout automatically
- In worktree and staged-copy runs, an implementer that writes files
  directly works in the run workspace created once per run, with the
  project's dependencies made available inside it so validation can run
  there; the assessed result defined in Principle V is applied
  to the user's real project directory once, at Apply, guarded against
  clobbering edits made in the meantime. A worktree isolates files — not
  runtime, not security: it shares hooks and config with the repository.
  Same-directory parallel writes remain out of scope
- Tests are written alongside or after implementation (not TDD)
  unless explicitly requested for a specific feature

## Governance

This constitution supersedes all other development practices for
the SPLITBRIEF project. All implementation decisions, code reviews,
and architectural choices MUST be evaluated against these principles.

The 4.0.0 amendment redefines Principle V. The review seat owns every new red and returns the fix work in the same answer.
The 4.1.0 amendment expands Principle V. The reviewer chooses the reviewer checks,
and SPLITBRIEF runs them under its command policy and re-runs only them at the run base.
These rules put the reviewer checks at the review that owns their result. Regression tests
verify both cadences and failure routing. The configuration, workflow, engine and
generated skill references carry the same rule. A fix task's brief gate runs the
red check it answers again before the next review.
The 4.2.0 amendment expands Principle V. The reviewer command policy has no program
allowlist, an uncomparable red at the run base is never pre-existing, and the user
may approve the reviewer checks before they run.
The 4.3.0 amendment expands Principle V. A fix check answers only its carried
failure keys and runs once, with no base re-run.
The 4.4.0 amendment changes Principle V. A fix check settles when no own failure
remains, a shared failure gates only the last unfinished fix task that carries
it, and a test-only fix check runs only the own test files.

**Amendment procedure**:
1. Propose changes via `/speckit.constitution` with rationale
2. Verify no existing features are broken by the amendment
3. Update version per semantic versioning (see below)
4. Propagate changes to dependent templates and documentation

**Versioning**: MAJOR for principle removals/redefinitions,
MINOR for new principles or material expansions, PATCH for
clarifications and wording improvements.

**Complexity justification**: Any deviation from these principles
MUST be documented in the plan.md Complexity Tracking table with:
the violation, why it is needed, and why the simpler alternative
was rejected.

**Version**: 4.4.0 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-10-25
