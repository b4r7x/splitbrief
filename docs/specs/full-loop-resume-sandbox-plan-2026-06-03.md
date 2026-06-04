# Full loop, resume, and sandbox plan

Date: 2026-06-03

This is the working record for the next changes in the planner to implementer
loop. It captures what was found, what will change, and how the work will be
checked. No files will be staged or committed during this run.

## User requirements

- Use the `test-behavior-not-implementation` testing rule for new and changed
  tests.
- Keep the main context small by using subagents for exploration and, later,
  implementation work where that is useful.
- Document the scope before more implementation work.
- Prove that a session can be re-entered and continued after a planning pause.
- Check the full loop, not only helper functions:
  planner artifacts, task briefs, implementer execution, validation, retry,
  escalation, final review, and completion.
- Cover cheap implementers such as direct agent, OpenCode style CLI, or
  OpenRouter style API through the existing implementer profile contracts.

## Current map

The code already has the main workflow pieces.

- `runWorkflow()` in `src/engine/orchestrator/run/run.ts` starts the workflow,
  planning, task execution, and final review.
- `runPlanningPhase()` in `src/engine/orchestrator/planning/run.ts` handles
  `instant`, `quick`, `standard`, and `speckit` planning modes.
- Planner output is `PlanResult` in `src/engine/planners/types.ts`. `tasks` are
  the required contract. `spec` and `plan` support the review and prompt flow.
- The task loop is in `src/engine/orchestrator/task/loop.ts`.
- Implementer selection is in
  `src/engine/orchestrator/task/routing-selection.ts`.
- Direct-writing implementers run through
  `src/engine/orchestrator/task/run-implementation.ts`, which creates a staged
  project and promotes changed files after the gate.
- Validation is in `src/engine/orchestrator/validation.ts`.
- Retry and escalation are in `src/engine/orchestrator/task/retry.ts` and
  `src/engine/orchestrator/escalation/escalation.ts`.
- Final review is in `src/engine/orchestrator/final-review.ts`.

## Findings

### Resume from planning is broken

A saved state with `awaitingContinue: true` in a planning phase is considered
resumable by the state model, but `runPlanningPhases()` skips planning whenever
any saved state exists and no rewind is pending.

The regression test already added for this behavior is:

`testing/integration/orchestrator/resume-planning-direct-implementer.test.ts`

Current failing result:

```text
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
```

That failure shows the planner is not called after re-entering a paused planning
session.

### Existing tests miss a full behavior loop

The e2e helper in `testing/e2e/helpers/e2e-config.ts` disables validation by
default. Existing e2e scenarios cover happy paths, retries, drift, and routing,
but they do not cover one complete flow where:

- the planner creates tasks,
- a cheap/direct implementer writes in a staged project,
- validation fails,
- retry or escalation happens,
- validation passes,
- final review runs,
- completion is emitted.

The existing tests are useful, but too much of the confidence comes from
smaller unit or integration checks instead of one consumer-visible workflow.

### Direct implementer sandbox is best effort

Direct implementers use a staged project directory before changed files are
promoted back to the original project. That protects normal relative writes, but
it is not a hard OS sandbox. Current gaps to review:

- staged project creation may copy `.git`;
- absolute writes and network side effects are not prevented;
- child process HOME, temp, and common cache directories should be redirected
  into the staged project so normal tool state does not land in the real user
  environment;
- staged file detection must still honor the original project's `.gitignore`
  even though the staged copy does not carry `.git` metadata;
- pre-existing symlinks should not be copied into staged direct-implementer
  runs, because relative writes through them can escape before promotion gates;
- promotion paths should be checked with real paths so symlink paths cannot
  write outside the project;
- planner-side write permissions and planner hint escalation can touch the
  original project.

The first implementation pass should harden what the code owns directly, not
claim a hard sandbox unless the process actually enforces one.

### Final review was advisory

`src/engine/orchestrator/final-review.ts` catches planner review errors and
still let the workflow complete. This pass changed that decision: final review
is now a completion gate. If the planner review fails, the workflow stays in
`final-review`, no `workflow_complete` event is emitted, `onComplete` is not
called, and the review packet records `finalReviewStatus: "failed"`.

There was also a review fidelity issue: final review received spec and diff, but
not the full task brief packet. This pass now includes `tasks.md` in the final
review prompt, with a fallback rendered from current state tasks if the artifact
is missing.

### Recovery had a placeholder path

`planner-split-rebase` was offered by recovery builders, but the recovery action
blocked instead of performing the split and rebase. This pass removed it from new
recovery issues and prompts. The enum/action handler remains only for legacy
saved states and manual calls, where it blocks with `planner-proposal-required`.
A real planner-driven recovery path still needs planner proposal generation,
Task Brief parse/quality gates, and approve/edit/reject handling.

### Provider and CLI configuration need targeted checks

OpenCode style CLI implementers and OpenRouter style API implementers are
supported by profiles. This pass confirmed the lower config layer already
supported the needed runner fields, then extended CLI overrides to carry them:

- CLI start/resume override flags now expose API base, env-backed API key refs,
  repeatable runner args, output format, and context length for planner and
  implementer runner configs.
- When `implementerProfiles` are configured, implementer CLI overrides update
  the default profile used by task routing, while preserving profile label and
  cost tier metadata.
- Test config helpers accepted `implementerProfiles` in their override type but
  did not copy those profiles into the parsed config. Full workflow profile
  tests need the helper to preserve that field.
- OpenCode-style CLI implementers write files directly, so they run in a staged
  project. The staged project intentionally has no `.git`; direct change
  detection must therefore work without relying on `git status` inside the
  staged copy.

## Change plan

1. Keep this document and `.audit/full-loop-resume-sandbox-2026-06-03.tsv` as
   the working record.
2. Fix planning resume so a saved state with `awaitingContinue: true` in
   `researching`, `specifying`, or `planning` re-enters planning instead of
   skipping to the task loop.
3. Ensure the resume path clears the waiting flag when the session continues.
4. Make the red regression test pass without asserting private helper wiring
   beyond the injected planner and implementer boundary behavior.
5. Add behavior-first tests for the missing loop pieces:
   - planning resume with a direct-writing implementer and staged promotion;
   - validation failure followed by retry or escalation and a later pass;
   - final review evidence in a completed workflow;
   - configured validation command missing should fail rather than silently pass,
     if current behavior confirms that gap.
6. Harden owned sandbox boundaries:
   - avoid copying `.git` into staged projects if that is not required;
   - add realpath-aware promotion confinement;
   - document remaining best-effort limits.
7. Make final review a gate and add behavior tests that completion does not
   happen on review failure.
8. Check provider configuration for `env:` API keys and update behavior or docs.
9. Run focused tests after each fix, then run the broader checks needed for the
   files touched.

## Test rules for this run

- Prefer integration tests that use `runWorkflow()` or CLI entry points.
- Mock only planner, implementer, filesystem, process, or network boundaries.
- Assert observable behavior: files promoted, events emitted, summary fields,
  validation result, and saved continuation state.
- Avoid asserting private call counts unless the injected boundary call is the
  behavior being proved.
- Keep tests few and complete. One full workflow test is better than several
  tests that only check internal steps.

## Open decisions

- Should planner hint escalation run only against staged or text-only artifacts?
- How hard should the "sandbox" claim be for direct implementers without an OS
  sandbox?

## Progress

Completed in this pass:

- Planning resume now re-enters planner phases when a saved state has
  `awaitingContinue: true` in `researching`, `specifying`, or `planning`.
- The resume path clears `awaitingContinue` through `CONTINUE_TURN` before
  continuing the planner call.
- A saved state with zero tasks outside `implementing` no longer reaches final
  review.
- Quick mode now cancels planning when the planner returns zero tasks, matching
  the existing instant-mode guard.
- Configured validation commands now fail when the command is missing. Missing
  auto-detected or default commands still skip as before.
- Final review failure no longer completes the workflow. The saved state remains
  in `final-review`, `workflow_complete` is not emitted, and the review packet is
  written with `finalReviewStatus: "failed"`.
- Direct staged projects no longer copy `.git`.
- Direct staged projects no longer copy symlinked entries. This prevents
  pre-existing project symlinks from becoming write-through escape paths during
  direct implementer execution.
- Direct staged projects now own the child-process sandbox environment. For
  direct CLI/shell implementers and staged full-planner escalation, child
  processes receive HOME, TMP/TMPDIR/TEMP, XDG cache/config/data, npm, pip, and
  cargo cache paths under staged `.diptych-sandbox`.
- Staged project snapshots and promotion change detection exclude
  `.diptych-sandbox`, so tool cache/temp writes do not become promoted project
  changes.
- Staged file-hash snapshots and direct change detection preserve the original
  project `.gitignore` semantics when the staged copy has no `.git` metadata.
  Ignored-only outputs such as `dist/` or logs no longer count as successful
  implementation changes and are not promoted.
- Staged change detection now uses the staged project's own baseline when the
  staged copy has no git metadata.
- Promotion rejects path traversal and symlinked target parent writes that would
  escape the target project.
- `apiKey: env:NAME` now resolves through the API provider boundary, including
  OpenRouter-style profiles, and missing env vars fail with a provider error.
- Added full workflow tests for direct staged implementation, real validation
  failure, local retry success, planner hint escalation success, final review
  output, and review packet generation.
- Added a full workflow test for an OpenRouter-style API implementer profile
  with mocked SSE network, env-backed API key resolution, real validation, final
  review output, and workflow completion.
- Added a full workflow test for an OpenCode-style CLI implementer profile with
  a fake `opencode` executable on `PATH`. It proves the CLI receives the task
  prompt and model flag, runs from a staged directory, receives staged
  HOME/TMP/cache env, writes through staged promotion, passes real validation,
  emits completion events, and writes final review output.
- Added a retry regression proving retry invocations receive the staged sandbox
  env, not only the initial implementation attempt.
- Added regressions for ignored-only staged outputs and pre-existing symlink
  entries in staged copies.
- Final review prompts now include the task brief packet from `tasks.md`, with a
  fallback generated from current state tasks when the artifact is missing.
- Direct change detection now supports staged projects without `.git` by using
  file hash baselines when git metadata is absent.
- Test config helpers now preserve `implementerProfiles` overrides so profile
  routing tests exercise the intended config.
- CLI runner overrides now expose planner/implementer API base, `env:VAR` API
  key references, repeatable args, output format, and context length. If
  implementer profiles exist, overrides update the default profile used by task
  routing.

Still open:

- Direct implementer isolation is still best effort. The code now hardens staged
  file promotion and redirects normal tool home/temp/cache writes into the
  staged project, but it does not prevent absolute writes or network side
  effects by the child process. It also cannot prevent a child process from
  creating a new symlink to an outside path and writing through it during its own
  run.
- A real `planner-split-rebase` recovery flow is still future work. New recovery
  issues no longer offer the placeholder action.
- CLI overrides configure the default implementer profile, not arbitrary named
  profiles. Non-interactive profile creation/editing remains future CLI work.
- Full workflow coverage now includes direct staged, OpenRouter-style API, and
  OpenCode-style CLI implementers. It still does not cover every possible CLI
  tool profile or a real installed OpenCode binary.
