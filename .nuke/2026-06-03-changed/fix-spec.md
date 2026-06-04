# Fix Spec — diptych — 2026-06-04
source: .nuke/2026-06-03-changed/findings.md (75 findings: 0 critical / 3 high / 11 medium / 39 low / 22 info)
scorecard: .nuke/2026-06-03-changed/report.md — target after execution: 5/5 in every category

## Executor context (self-contained — assume zero prior knowledge)
- Project: diptych — open-source cost-aware task compiler for AI coding agents (expensive planner compiles Task Briefs; cheaper implementer executes them). Stack: Node.js 22+, TypeScript 6.x, ESM-only (`.js` extension in every import), Ink 6 (React 19) TUI, Vitest 4, Biome 2, Zod 4, commander, simple-git.
- Scope of this spec: the working-tree changeset vs HEAD audited on 2026-06-03/04 (111 files; full ledger with evidence in `findings.md` next to this file — read the F-### entry before fixing it).
- Conventions executors must obey (from CLAUDE.md / docs):
  - Zero runtime classes in production source; pure functions + module-scoped state.
  - ESM imports always end in `.js`; kebab-case filenames; colocated tests (`foo.test.ts`).
  - No decorative comments; no barrels (`index.ts` re-exports); zero `useMemo`/`useCallback`/`React.memo`; no `forwardRef`/`useImperativeHandle`.
  - No incidental `!` or broad `as` in production (sanctioned exceptions listed in CLAUDE.md).
  - Errors at boundaries: internal functions propagate; callers decide (docs/ERRORS.md).
  - Zero engine → React imports (`src/engine/` must not import ink/react/features/components/hooks).
- Gates: `npm run typecheck` · `npm run lint` · `npm test` — all must pass at every phase exit; `npm run test-ci` (format && typecheck && lint && test && invariants) before finishing.
- Rules: never `git add` / `git commit` / `git stash` (the repo owner commits manually; a PreToolUse hook blocks staging). No `.bak` files. Fix EVERY task including low/info. Behavior-preserving unless the task says otherwise. Cost is not a concern — use as many subagents as needed for the highest quality.

## Execution protocol (for any executor — the nuke-fix skill automates this)
For each phase, in order:
1. Run every batch in the phase as parallel implementation subagents (one agent per batch; batches within a phase touch disjoint files).
2. Validation wave with FRESH subagents (never the implementers): per task, check acceptance criteria with file:line evidence; re-audit every changed file for newly introduced issues; run all gates.
3. Any failure or any new issue (any severity) → dispatch fix subagents with the exact findings → revalidate. Repeat until clean (cap: 5 cycles, then stop and report honestly).
4. Only then move to the next phase.
After the last phase: run all gates, then a final full-sweep wave (correctness+security pass and structure/quality pass over all changed files) plus a completeness check (every task done, every finding ID resolved).

## Phase 1 — Shared contracts & DRY extractions (first: later fixes land on the deduplicated shapes)

### Batch 1.A — files: src/engine/change-detection.ts, src/engine/snapshots/files.ts, src/engine/orchestrator/approval/file-snapshots.ts, src/engine/implementers/base.ts, src/engine/implementers/command-invoke.ts, src/engine/agent-sdk-backend.ts
- [ ] T-001 (fixes F-021) — src/engine/change-detection.ts:1-4
      Change: Merge the duplicate imports from the same module into `import { getCurrentChangedFiles, isGitRepo } from '../lib/git.js';`.
      Accept: change-detection.ts has exactly one import statement from `../lib/git.js`.
- [ ] T-002 (fixes F-018, F-023) — src/engine/change-detection.ts, src/engine/agent-sdk-backend.ts:191-194, src/engine/implementers/base.ts:96-99, src/engine/implementers/command-invoke.ts:20-25
      Change: Export a single named `ChangeDetector` type (function signature + result shape) from change-detection.ts and use it at all three inline-spelled sites.
      Accept: `grep -rn 'changed: boolean; output: string'` shows the shape defined once in change-detection.ts; the three call sites reference `ChangeDetector`.
- [ ] T-003 (fixes F-024, F-051) — src/engine/snapshots/files.ts:6-10, src/engine/orchestrator/approval/file-snapshots.ts:41-55, 76-101
      Change: Import `CollectTrackedFilesOptions` in file-snapshots.ts and annotate `captureProjectFileContents` / `getChangedFilesSinceBaselineContents` opts with it (this justifies keeping the export).
      Accept: no inline `{ ignoreProjectDir?: string | undefined }` re-spelling remains in file-snapshots.ts; the type is imported from `../../snapshots/files.js`.

### Batch 1.B — files: src/core/config/runtime/overrides.ts, src/core/types/config-options.ts, src/core/config/accessors/implementer-profiles.ts
- [ ] T-004 (fixes F-015) — src/core/config/runtime/overrides.ts:29-38, 90-99
      Change: Replace the standalone `RunnerOverrides` interface with `type RunnerOverrides = z.infer<typeof RunnerOverrideSchema>` so the shape is single-sourced.
      Accept: only one definition of the runner-override shape exists; typecheck passes.
- [ ] T-005 (fixes F-013) — src/core/config/accessors/implementer-profiles.ts:40-43, src/core/config/runtime/overrides.ts:200-203
      Change: Export the existing `stripProfileMetadata` from implementer-profiles.ts and import it in overrides.ts; delete the duplicate `stripImplementerProfileMetadata`.
      Accept: the strip logic exists exactly once.
- [ ] T-006 (fixes F-014) — src/core/config/runtime/overrides.ts:271-316
      Change: In applyCLIOverrides pass the already-shaped `overrides.planner` / `{ ...overrides.implementer, ...(merged contextLength) }` objects directly instead of ~30 lines of conditional per-field re-spreading.
      Accept: behavior identical (existing overrides tests pass); the conditional re-spread block is gone.
- [ ] T-007 (fixes F-017) — src/core/types/config-options.ts:18, 27, src/core/config/runtime/overrides.ts:66-76
      Change: Delete dead `plannerApiKey`/`implementerApiKey` WorkflowOpts fields; simplify the two reads to use `opts.plannerApiKeyEnv` / `opts.implementerApiKeyEnv`.
      Accept: `grep -rn 'plannerApiKey[^E]'` returns nothing in src/.

### Batch 1.C — files: src/features/workflow/handlers.ts, src/app/keys.ts, src/app/keys.test.tsx, testing/integration/ui/esc-through-filtered-stdin.test.tsx
- [ ] T-008 (fixes F-032, F-057) — src/features/workflow/handlers.ts:47, src/app/keys.ts:32, 58, src/app/keys.test.tsx:14, testing/integration/ui/esc-through-filtered-stdin.test.tsx:33-39
      Change: Export `type InterruptResult = 'turn' | 'workflow' | 'none'` from handlers.ts next to `interruptTurn` and import it at the four re-spelled sites.
      Accept: the literal union is spelled exactly once in src/ + testing/.

### Batch 1.D — files: src/core/recovery/user-edit-actions.ts (new), src/engine/orchestrator/recovery/builders/recovery-actions.ts, src/features/workflow/user-edit-conflict-prompt.ts
- [ ] T-009 (fixes F-048) — recovery-actions.ts:36-41, user-edit-conflict-prompt.ts:14-29
      Change: Move the UserEditConflictAction→RecoveryAction mapping into one canonical core/ helper and import it from both the engine builder and the features prompt (respect docs/LAYERS.md for placement; engine must not import from features).
      Accept: the mapping exists once in core/; both consumers import it; engine→React import gate still clean.

### Phase exit
All gates pass · every T in this phase validated · zero new findings in changed files

## Phase 2 — Engine & TUI behavior fixes (the high/medium correctness core)

### Batch 2.A — files: src/engine/orchestrator/final-review.ts, src/engine/orchestrator/run/phases.ts, src/engine/orchestrator/run/run.ts, src/cli/headless.ts, src/features/workflow/screen.tsx, src/features/workflow/hooks/use-workflow-runner.ts, src/core/phases.ts
- [ ] T-010 (fixes F-009) — final-review.ts:196-228, run/phases.ts:288-289
      Change: Return an explicit status (`{ status: 'complete' | 'final-review-failed' }` or the final WorkflowState) from `runFinalReviewPhase`; derive `completed` from the return value in `runTasksAndReview` instead of re-reading state from disk via `loadState`.
      Accept: no `loadState` call used to learn the just-finished review outcome; tests pass.
- [ ] T-011 (fixes F-002, F-008) — run/phases.ts:258-270, final-review.ts:142-194, src/cli/commands/resume.ts
      Change: Make a persisted `state.phase === 'final-review'` resumable: on resume, route directly into `runFinalReviewPhase` (without re-dispatching ALL_DONE) so a failed review can be retried to completion instead of dead-ending.
      Accept: new/updated test: persist a failed-final-review state, resume, planner review succeeds → session reaches phase 'complete'.
- [ ] T-012 (fixes F-059) — src/cli/headless.ts:22-42, 112-117
      Change: After runWorkflow returns in headless mode, detect a non-complete terminal phase (failed final review) and exit non-zero with a diagnostic, mirroring emitRecoveryAndFailIfPending.
      Accept: headless run with a failing final review exits with code ≠ 0.
- [ ] T-013 (fixes F-061) — final-review.ts:164-194, screen.tsx:74-75, use-workflow-runner.ts:157-187
      Change: On a failed final-review gate, drive the interactive TUI to a terminal state (emit a terminal signal or detect the non-complete return; navigate to summary/home or render an explicit 'final review failed' terminal view).
      Accept: simulated failed review in the TUI leaves the user with visible terminal state + navigation, not a stuck workflow screen.
- [ ] T-014 (fixes F-027) — final-review.ts:164-228
      Change: Hoist the duplicated summaryOpts/preSummary/writeReviewPacket block above the `reviewStatus === 'failed'` branch so it runs once; keep only success-specific transitions inside the branch.
      Accept: the summary-build + writeReviewPacket code appears once.
- [ ] T-015 (fixes F-049) — run/phases.ts:60-66
      Change: Compute `isInterruptedPlanningTurn` once into a local and reuse it; drop the redundant savedState variant.
      Accept: single call site of the predicate in runPlanningPhases.

### Batch 2.B — files: src/engine/runners/sandbox-env.ts, src/engine/orchestrator/approval/staged-project.ts, src/engine/orchestrator/approval/file-snapshots.ts, src/engine/orchestrator/approval/gate-and-promote.ts, src/engine/orchestrator/escalation/run-escalation-tier.ts, src/engine/orchestrator/escalation/step.ts, src/engine/change-detection.ts, src/engine/snapshots/files.ts, src/engine/orchestrator/task/run-implementation.ts, src/engine/planners/escalation.ts, src/engine/planners/cli.ts, src/engine/agent-sdk-backend.ts
- [ ] T-016 (fixes F-010) — sandbox-env.ts:5-33, run-implementation.ts:43-78, implementers (read F-010 in findings.md)
      Change: Stop breaking credential/config lookup for direct CLI implementers: keep real HOME for known authenticated CLI tools, or seed sandbox HOME/XDG with the credential/config files the configured tool needs (~/.claude, ~/.codex, ~/.npmrc …). Decide per F-010 evidence; document the choice in code.
      Accept: direct claude-code/codex implementer runs authenticate inside the sandbox (manual trace or integration test with fake HOME-dependent tool).
- [ ] T-017 (fixes F-007) — run-escalation-tier.ts:203-262, planners/escalation.ts:28-58, planners/cli.ts:95-119
      Change: Run tier-1 hint escalation sandboxed: pass sandboxEnv + fileIgnoreProjectDir into `escalateHint` exactly as runFullTier/runRetryStep do (or route hint escalation through the same staged machinery).
      Accept: test asserts escalateHint receives sandboxEnv/fileIgnoreProjectDir; no unsandboxed planner spawn remains on the hint path.
- [ ] T-018 (fixes F-005) — file-snapshots.ts:41-101, staged-project.ts:24-69, escalation/step.ts:47
      Change: Store per-file hashes (reuse hashFile/captureFileHashes from change-detection.ts) for the staged no-git baseline instead of full file contents; diff by hash so unchanged files are not re-read fully on each gate.
      Accept: gating a large staged project does not re-read unchanged file contents (hash-only compare); existing staged-project tests updated and passing.
- [ ] T-019 (fixes F-006) — gate-and-promote.ts:138-152
      Change: Wrap promoteStagedChanges in try/catch that runs cleanup and returns an explicit 'promote-conflict'/'error' outcome instead of letting path-confinement/fs throws escape and crash the retry/task flow.
      Accept: a simulated promote throw produces a handled outcome + cleanup, not an unhandled crash.
- [ ] T-020 (fixes F-025) — staged-project.ts:39-46
      Change: In shouldCopyToStagedProject only skip confirmed symlinks; let unexpected lstat errors propagate (or log) instead of silently dropping files.
      Accept: lstat failure on a regular file no longer silently excludes it.
- [ ] T-021 (fixes F-026) — change-detection.ts:41-53, file-snapshots.ts:37-39
      Change: Use a local-only `.git` existence check (matching hasGitMetadata) in captureChangeDetectorBaseline instead of git's upward-discovering checkIsRepo, so staged copies inside a parent git repo take the file-hash path.
      Accept: baseline capture in a TMPDIR nested in a git repo uses file hashes (unit test).
- [ ] T-022 (fixes F-067) — staged-project.ts:48-69
      Change: Wrap the cp/baseline-capture/createSandboxEnv body of createStagedProject in try/catch that rmSync's stagedRoot before re-throwing.
      Accept: a thrown mkdir/capture leaves no orphan staging dir (test with injected failure).
- [ ] T-023 (fixes F-020) — change-detection.ts:14-28, snapshots/files.ts:12-20
      Change: Bound the hashFile read-stream fan-out in captureFileHashes with a small fixed concurrency pool.
      Accept: descriptor usage stays constant for large file sets (pool implementation reviewed; no unbounded files.map(hashFile)).
- [ ] T-024 (fixes F-045) — file-snapshots.ts:157-165
      Change: Add the short why-comment above the second assertWritablePathConfined call mirroring its fs.ts sibling (TOCTOU re-check after mkdir).
      Accept: comment present, matches fs.ts wording.
- [ ] T-025 (fixes F-072) — agent-sdk-backend.ts:247-255
      Change: Update the stale options.env comment to cover the sandbox-env branch added by the changeset.
      Accept: comment correctly describes both env sources.

### Batch 2.C — files: src/engine/providers/client.ts, src/engine/providers/errors.ts, src/engine/implementers/agent-sdk.ts, src/engine/planners/agent-sdk.ts, src/core/config/runtime/build-runner.ts, src/cli/options.ts, src/core/readiness/collect.ts, src/engine/claude-invoke.ts, src/engine/planners/claude-code.ts
- [ ] T-026 (fixes F-060) — implementers/agent-sdk.ts:16, planners/agent-sdk.ts:20-24, agent-sdk-backend.ts:228-255, providers/client.ts:82-105
      Change: Resolve `env:NAME` apiKey references on the agent-sdk path too — export/reuse the existing resolveApiKeyOverride helper when reading config.{implementer,planner}.apiKey (or centralize resolution in build-runner), failing fast on a missing env var instead of injecting the literal `env:VAR` as ANTHROPIC_API_KEY.
      Accept: agent-sdk runner with `apiKey: env:FOO` uses process.env.FOO and errors clearly when unset; test added.
- [ ] T-027 (fixes F-012) — cli/options.ts:8-10, 43, 66-68
      Change: Make parseNumberOption validate with Number.isFinite (or commander InvalidArgumentError) so malformed numeric flags fail fast instead of producing NaN.
      Accept: `--implementer-context-length abc` exits with a clear CLI error.
- [ ] T-028 (fixes F-043) — overrides.ts:175-198, build-runner.ts:137-155
      Change: warnStderr when --*-api-key-env / --*-api-base are supplied but the resolved runner kind cannot use them (cli/shell/agent), instead of silently dropping.
      Accept: warning emitted in that configuration; no behavior change otherwise.
- [ ] T-029 (fixes F-031) — providers/client.ts:99-105, 164-167
      Change: Delete resolveProviderOverrides; inline `resolveApiKeyOverride(overrides?.apiKey)` at the single consumer.
      Accept: helper gone; provider apiKey resolution unchanged (tests pass).
- [ ] T-030 (fixes F-073) — claude-invoke.ts:144-165, planners/claude-code.ts:39-49
      Change: Delete the dead `env?` field from ClaudePlannerStreamOpts and its pass-through in runClaudePlannerStream (keep env on runClaudeOneShot, which has producers).
      Accept: no unused env plumbing on the planner-stream path; typecheck passes.

### Batch 2.D — files: src/app/keys.ts, src/cli/render.ts, src/lib/terminal/filtered-stdin.ts, src/lib/terminal/escape-debounce.ts, src/core/keybindings/registry.ts, src/features/help/overlay.tsx, src/features/workflow/components/feedback-row.tsx, src/features/workflow/components/workflow-chrome.tsx
- [ ] T-031 (fixes F-001) — app/keys.ts:83-94
      Change: Restore the attach short-circuit: when on the workflow screen with `route.attach` set, Ctrl+C calls `exit()` immediately (attach client is a remote viewer; nothing local to interrupt).
      Accept: attach-mode Ctrl+C exits; non-attach behavior unchanged; covered by a keys test.
- [ ] T-032 (fixes F-004) — cli/render.ts:29-72
      Change: In the SIGINT/termination handler, restore the terminal before process.exit — emit alt-buffer exit (`\x1b[?1049l`) + cursor/raw-mode restore, or register the handler only in non-fullscreen mode and let fullscreen-ink's cleanup run.
      Accept: SIGINT during fullscreen leaves the terminal on the main buffer (manual verification note + unit assertion on the written escape sequence where feasible).
- [ ] T-033 (fixes F-069) — filtered-stdin.ts:59-73, 165-210
      Change: Hold a standalone trailing ESC as `partial` when it could begin a paste marker (as pre-paste mouse.ts did) so split paste-start/end markers reassemble instead of leaking through the bare-ESC short-circuit.
      Accept: test: paste marker split after the leading ESC byte is still stripped/assembled correctly.
- [ ] T-034 (fixes F-064) — app/keys.ts:110-131
      Change: Defer the cancelled-state ESC navigate-home through scheduleEscapeAction (cancellable by the following escape-sequence byte), matching the arm path.
      Accept: test: split arrow-key sequence in cancelled state does not navigate away.
- [ ] T-035 (fixes F-065) — app/keys.ts:83-94, feedback-row.tsx / shared status line
      Change: Either render the armed-exit hint on non-workflow screens (status line driven by abortStore.armed) or special-case non-workflow screens back to single-press exit. Pick one; keep UX coherent with F-044/T-037 wording.
      Accept: Ctrl+C off the workflow screen is either visibly armed or exits immediately — no silent hidden two-press.
- [ ] T-036 (fixes F-016) — core/keybindings/registry.ts:21-32, features/help/overlay.tsx:49-56
      Change: Eliminate duplicate React keys for the two `Esc Esc` rows (key by shortcut id, or merge interrupt/cancel into one registry row).
      Accept: help overlay renders without duplicate-key warning; both behaviors still documented.
- [ ] T-037 (fixes F-044) — core/keybindings/registry.ts:12-17
      Change: Scope the Ctrl+C description: 'Interrupt, then exit' on the workflow screen; plain exit wording elsewhere (align with the T-035 decision).
      Accept: descriptions match actual per-screen behavior.
- [ ] T-038 (fixes F-052) — escape-debounce.ts:1-15, app/keys.ts:131
      Change: Drop the speculative `delayMs` parameter; use DEFAULT_DELAY_MS directly; delete the custom-delay test.
      Accept: scheduleEscapeAction takes no delay parameter; tests updated.

### Batch 2.E — files: src/features/workflow/recovery-prompt.ts, src/features/workflow/user-edit-conflict-prompt.ts, src/engine/orchestrator/user-edit/conflicts.ts, src/engine/orchestrator/recovery/builders/task.ts
- [ ] T-039 (fixes F-033) — recovery-prompt.ts:30-37, 66-72
      Change: Empty the ACTION_ALIASES['planner-split-rebase'] alias array (keep the key for the Record type) so dead 'p'/'split'/'rebase' routing is not presented as live.
      Accept: no alias resolves to the removed action.
- [ ] T-040 (fixes F-034) — user-edit-conflict-prompt.ts:31-48
      Change: Delete visibleActions(); map conflict.availableActions directly (enum member stays only for the assertNever switch).
      Accept: filter helper gone; prompt renders identical actions.
- [ ] T-041 (fixes F-029) — conflicts.ts:76-84
      Change: Collapse the duplicate identical branches into one guard returning ['continue-unrelated', 'pause', 'abort-workflow'].
      Accept: single branch; tests pass.
- [ ] T-042 (fixes F-074) — recovery/builders/task.ts:59-64, 202-217
      Change: Drop the unreachable trailing 'skip-current-task' from the two new chooseRecommended preference lists.
      Accept: preference lists contain only reachable elements.

### Phase exit
All gates pass · every T in this phase validated · zero new findings in changed files

## Phase 3 — Tests (after behavior settles; lock the changed behavior in)

### Batch 3.A — files: testing/integration/orchestrator/cli-planner-cli-implementer.test.ts, testing/integration/orchestrator/full-loop-validation-retry.test.ts, testing/integration/orchestrator/abort-mid-task.test.ts, src/engine/orchestrator/approval/staged-project.test.ts, src/engine/change-detection.test.ts, src/engine/orchestrator/recovery/recovery.test.ts, src/engine/providers/registry.test.ts, src/engine/orchestrator/escalation/step.test.ts, src/engine/orchestrator/escalation/escalation.test.ts, src/engine/orchestrator/final-review.test.ts, src/engine/orchestrator/task/loop-recovery.test.ts, src/engine/implementers/* tests
- [ ] T-043 (fixes F-003) — cli-planner-cli-implementer.test.ts:156-229, full-loop-validation-retry.test.ts:104-106, 576-587
      Change: Broaden normalizeMacTmpPath in both files to reconcile /tmp ↔ /private/tmp generally (strip the /private prefix or realpathSync both operands).
      Accept: suites pass on a macOS host where TMPDIR resolves under /tmp symlink.
- [ ] T-044 (fixes F-038) — full-loop-validation-retry.test.ts:70-102, 572-574
      Change: Replace the over-engineered isFakeOpencodeRun guard with the simple typed cast used by the sibling test; delete the guard.
      Accept: guard gone; test still passes.
- [ ] T-045 (fixes F-019) — change-detection.test.ts
      Change: Add file-hashes cases for a new non-ignored file (changed:true) and a deleted baseline-tracked file (changed:true).
      Accept: both cases present and green.
- [ ] T-046 (fixes F-022) — implementers tests (agent-sdk / command-invoke)
      Change: Add a test asserting sandboxEnv reaches SDK options.env (agent-sdk) and the spawned subprocess env (agent via command-invoke).
      Accept: regression on sandboxEnv threading fails the suite.
- [ ] T-047 (fixes F-066) — staged-project.test.ts:62-88
      Change: Add a deletion case: delete a baseline-tracked file in the staged dir → getChangedFilesSinceSnapshot includes it → promote removes it from the real project.
      Accept: case present and green (depends on T-018 baseline shape).
- [ ] T-048 (fixes F-068) — escalation.test.ts:287-340
      Change: Add a tier-2 spy test asserting escalateFull receives sandboxEnv pointing at the staged SANDBOX_DIR and fileIgnoreProjectDir = real project dir.
      Accept: wiring pinned by assertion.
- [ ] T-049 (fixes F-028) — recovery.test.ts:139-148
      Change: Assert `override.recommendedAction === 'retry-same-worker'` in the retry-exhausted override sub-case.
      Accept: assertion present.
- [ ] T-050 (fixes F-030) — registry.test.ts:67-96
      Change: Add tests: `apiKey: 'env:'` and whitespace-only variant throw matching /env:VARIABLE_NAME/.
      Accept: both negative cases green.
- [ ] T-051 (fixes F-046) — escalation/step.test.ts:130-178
      Change: Replace the three sandbox directory-layout assertions with a propagation-level check; leave canonical layout to staged-project.test.ts.
      Accept: step.test.ts no longer encodes SANDBOX_DIR internal layout.
- [ ] T-052 (fixes F-047) — final-review.test.ts:192-222
      Change: Drop the two non-discriminating `toContain('## Task Briefs')` assertions.
      Accept: only discriminating marker assertions remain.
- [ ] T-053 (fixes F-050) — loop-recovery.test.ts:165-168
      Change: Assert the structured recovery contract instead of verbatim routingBlockMessage prose.
      Accept: no verbatim-copy coupling; behavior still uniquely identified.
- [ ] T-054 (fixes F-037) — abort-mid-task.test.ts:60-92
      Change: Delete the tautological abortStore assertion (mock's own side effect); keep signal-driven assertions.
      Accept: test asserts engine behavior only.
- [ ] T-055 (fixes F-056) — abort-mid-task.test.ts:26-29
      Change: Add abortStore.clear() to afterEach so the 2s arm timer is cancelled.
      Accept: no leaked timer (vitest hanging-handle clean).

### Batch 3.B — files: src/app/keys.test.tsx, testing/integration/ui/esc-through-filtered-stdin.test.tsx, testing/helpers/filtered-stdin-harness.tsx, src/lib/terminal/filtered-stdin.test.ts, src/features/workflow/handlers.test.ts
- [ ] T-056 (fixes F-011) — app/keys.test.tsx
      Change: Add cases: approvalPromptStore pending and costApprovalStore pending on the workflow screen → ESC keeps abortStore.armed 'none', no interrupt/cancel fires.
      Accept: the prompt-pending ESC gate is covered.
- [ ] T-057 (fixes F-042) — app/keys.test.tsx:161, 181, 221
      Change: Stop hardcoding 35ms — import DEFAULT_DELAY_MS (or use a comfortably larger advance).
      Accept: no copied debounce literal in tests.
- [ ] T-058 (fixes F-035) — filtered-stdin-harness.tsx:55-90
      Change: Install the stdout mute BEFORE createFilteredStdin (and across disable()) so terminal-mode sequences are actually suppressed as the comment claims.
      Accept: no escape sequences leak into captured test output.
- [ ] T-059 (fixes F-036) — filtered-stdin-harness.tsx:60-91
      Change: Wrap render in try/finally restoring process.stdout.write.
      Accept: a throwing render leaves stdout unmuted.
- [ ] T-060 (fixes F-054) — filtered-stdin-harness.tsx:16-27
      Change: Replace the CaptureStdout class with the file's established Object.assign(new EventEmitter(), {...}) pattern.
      Accept: zero `class` keywords in the harness.
- [ ] T-061 (fixes F-055) — filtered-stdin-harness.tsx:47-91
      Change: Drop the unused `frames` field from the harness interface, return object, and capture stub.
      Accept: no dead surface on FilteredStdinHarness.
- [ ] T-062 (fixes F-039) — esc-through-filtered-stdin.test.tsx:1, 91-92, 136-137, 330-339
      Change: Use vi.fn() + toHaveBeenCalledTimes instead of the hand-rolled vi_noop counter and manual counters; delete the misleading comment.
      Accept: no hand-rolled mock counters remain.
- [ ] T-063 (fixes F-040) — esc-through-filtered-stdin.test.tsx:26-31, 84-99
      Change: Import the hint constant from feedback-row (or rely on armed-state asserts with a single render-integration check) instead of re-spelling UI copy.
      Accept: hint copy spelled once in src/.
- [ ] T-064 (fixes F-041) — esc-through-filtered-stdin.test.tsx:3-5
      Change: Switch relative ../../helpers imports to the #testing/helpers alias.
      Accept: matches repo-wide test import convention.
- [ ] T-065 (fixes F-053) — filtered-stdin.test.ts:391-398
      Change: Rename the test to the real contract (preserves split escape sequence byte-for-byte) and fix the inline comment.
      Accept: name no longer claims folding.
- [ ] T-066 (fixes F-075) — handlers.test.ts:26-32
      Change: Assert the registered cancel handler fired (`expect(cancel).toHaveBeenCalledTimes(1)`) in the 'workflow' case.
      Accept: controller.abort path pinned.

### Phase exit
All gates pass · every T in this phase validated · zero new findings in changed files

## Phase 4 — Docs & references (last: document the now-final behavior)

### Batch 4.A — files: docs/SLASH-COMMANDS-REFERENCE.md, docs/CLI-REFERENCE.md, docs/CONFIGURATION.md, docs/TESTING.md, docs/STORES-AND-UI.md, docs/STORES.md
- [ ] T-067 (fixes F-058) — docs/SLASH-COMMANDS-REFERENCE.md:361-415
      Change: Rewrite the Ctrl+C/Esc abort section to the armed model (abortStore.arm/armed, 'Ctrl+C again to exit'), correct the registry label wording, add the new Esc Esc shortcuts; remove DOUBLE_PRESS_WINDOW_MS/pending/'Aborting…' references.
      Accept: every claim in the section matches src/app/keys.ts + src/stores/workflow/abort.ts as fixed in Phase 2.
- [ ] T-068 (fixes F-062) — docs/CLI-REFERENCE.md:65-101, 469-487, docs/CONFIGURATION.md:930-954
      Change: Document all 10 new --planner-*/--implementer-* flags (api-base, api-key-env, args, output-format, context-length) in the start options table + synopsis, noting per-kind applicability (and the T-028 warning behavior).
      Accept: `diptych start --help` flags and CLI-REFERENCE.md agree 1:1.
- [ ] T-069 (fixes F-063) — docs/TESTING.md:343-349
      Change: Replace `abortStore.set({ armed: 'exit' })` with `abortStore.arm('exit')` in the 'Good' example.
      Accept: example compiles against the real store API.
- [ ] T-070 (fixes F-070) — docs/STORES-AND-UI.md:68
      Change: Describe abortStore as the armed-abort indicator (none/interrupt/cancel/exit), dropping 'pending'.
      Accept: matches abort.ts.
- [ ] T-071 (fixes F-071) — docs/STORES.md:55
      Change: Update the file-tree comment to the armed-kind abort state wording.
      Accept: file-tree comment matches the table row at line 178.

### Phase exit
All gates pass (`npm run test-ci`) · every T validated · final full-sweep wave + completeness check (every F-### resolved)

## Coverage map
F-001→T-031 · F-002→T-011 · F-003→T-043 · F-004→T-032 · F-005→T-018 · F-006→T-019 · F-007→T-017 · F-008→T-011 · F-009→T-010 · F-010→T-016 · F-011→T-056 · F-012→T-027 · F-013→T-005 · F-014→T-006 · F-015→T-004 · F-016→T-036 · F-017→T-007 · F-018→T-002 · F-019→T-045 · F-020→T-023 · F-021→T-001 · F-022→T-046 · F-023→T-002 · F-024→T-003 · F-025→T-020 · F-026→T-021 · F-027→T-014 · F-028→T-049 · F-029→T-041 · F-030→T-050 · F-031→T-029 · F-032→T-008 · F-033→T-039 · F-034→T-040 · F-035→T-058 · F-036→T-059 · F-037→T-054 · F-038→T-044 · F-039→T-062 · F-040→T-063 · F-041→T-064 · F-042→T-057 · F-043→T-028 · F-044→T-037 · F-045→T-024 · F-046→T-051 · F-047→T-052 · F-048→T-009 · F-049→T-015 · F-050→T-053 · F-051→T-003 · F-052→T-038 · F-053→T-065 · F-054→T-060 · F-055→T-061 · F-056→T-055 · F-057→T-008 · F-058→T-067 · F-059→T-012 · F-060→T-026 · F-061→T-013 · F-062→T-068 · F-063→T-069 · F-064→T-034 · F-065→T-035 · F-066→T-047 · F-067→T-022 · F-068→T-048 · F-069→T-033 · F-070→T-070 · F-071→T-071 · F-072→T-025 · F-073→T-030 · F-074→T-042 · F-075→T-066
