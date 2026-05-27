# SOTA Code Quality Audit — 2026-05-27

Status: remediation pass verified after four gpt-5.5 xhigh review waves plus one final confirmation loop against the changed areas. This audit captures the review findings, the local probes, the fixes landed in this pass, broad verification, and the remaining structural backlog.

Scope: entire repository with emphasis on structure, DRY, KISS, SRP, reusability, parameter design, test behavior, anti-slop, security-sensitive quality, and big-file/file-organization pressure.

## Methodology

- 12 read-only gpt-5.5 xhigh agents reviewed independent slices:
  - provider/API pipeline
  - orchestrator/retry/budget/approval
  - CLI/app/runtime commands
  - TUI/features/components
  - core/lib/security-sensitive IO
  - architecture/import graph
  - DRY/reusability
  - parameter-object design
  - test behavior
  - anti-slop
  - docs/invariants
  - security follow-up
- 4 follow-up gpt-5.5 xhigh agents reviewed the changed code and remaining findings:
  - security-sensitive provider, hook, abort, and IO paths
  - orchestrator retry/evidence/approval correctness
  - test behavior, anti-slop, and docs drift
  - structure, DRY, parameter-object pressure, and invariant enforcement
- 3 final gpt-5.5 xhigh agents reviewed the changed code and open blockers:
  - provider credential and abort safety
  - orchestrator abort/retry/final-review correctness
  - quality/docs consistency after remediation
- 6 structural follow-up gpt-5.5 xhigh agents reviewed the remaining architecture backlog:
  - review-packet import cycle
  - two-column picker import cycle
  - remaining cycle scan and layer checks
  - wide positional APIs
  - big-file/SRP split candidates
  - test behavior and anti-slop findings
- 3 final confirmation gpt-5.5 xhigh agents reviewed the completed structural edits:
  - cycle and invariant regression scan
  - test behavior and anti-slop pass over changed tests
  - Agent SDK and invariant-runner correctness check
- Local probes:
  - `npm run check:invariants`
  - production parameter-count AST scan
  - import-cycle scan
  - big-file scan
  - focused grep over hooks, provider routing, evidence, CLI/app boundaries, and docs drift

## Scorecard

| Category | Current | Main Blocker |
|---|:---:|---|
| DRY/Reusability | 3/5 | JSON persistence, review/status formatting, JSONL/readline parsing, setup fixtures |
| SRP/File Structure | 3.4/5 | runtime command registry, `brief-review.ts`, feature imports into engine internals, remaining big-file pressure |
| KISS | 4/5 | mostly healthy; remaining issues are localized boolean/branch complexity and repeated formatting logic |
| Parameter Design | 3.6/5 | regeneration helpers, stream processing, and review-packet recovery builder improved; several exported/cross-boundary APIs still have 6-9 positional params |
| Test Behavior | 3/5 | too many tests assert private seams, UI copy/glyphs, and mock call choreography |
| Anti-Slop | 4/5 | comments/type workarounds/dead exports remain, but no systemic over-engineering |
| Security-Sensitive Quality | 4.2/5 | provider API-base guards, hook confinement, planner/Claude abort propagation, and partial-stream abort handling fixed; secure append and metadata privacy remain |
| Docs/Invariants | 4.6/5 | invariant runner now fails closed with shell `pipefail`, hidden command failures, and malformed output; big-file/test-behavior policies still not mechanically enforced |
| Overall | 4/5 | stronger structure after cycle removal, but not yet "reference SOTA" because big-file, boundary, and test-behavior backlog remains |

## Fixed In This Pass

### Provider and API safety

- Fixed Anthropic API implementer path so custom `apiBase` now routes through provider registry exfiltration checks instead of constructing the Anthropic request directly.
- Added regression coverage for env-sourced Anthropic keys with custom `apiBase`.
- Added the same env-key/custom-`apiBase` exfiltration guard for Ollama by treating `OLLAMA_API_KEY` as a provider env key.
- Added provider `apiBase` validation:
  - must be an absolute URL
  - protocol must be `http` or `https`
  - embedded credentials are rejected

### Hook trust and path confinement

- Auto-discovered `.diptych/hooks/*` module hooks now resolve to project-relative paths.
- Module hook loading now rejects absolute paths, `..` escapes, and symlinks that resolve outside the project root.
- Hook trust hashes now include module file content digests, so editing a trusted module hook invalidates trust.
- Added coverage for absolute path rejection, path escape rejection, symlink escape rejection, and content-change invalidation.

### Secure writes and redaction

- `writeSpecFile` now uses `writeSecureFile`.
- session `summary.json` writes now use `writeSecureFile`.
- git command error wrapping now uses redacted `toErrorMessage` output instead of raw error strings.

### Orchestrator correctness

- Speckit planner review calls now go through `runPlannerReview`, preserving planner token accounting.
- Sticky approval checks now consult existing grants before emitting `approval_prompted`.
- Retry success evidence now records initial failure validation/changed files separately from the successful retry attempt.
- Planner review, regeneration, escalation, local retry, CLI planner, and Agent SDK paths now propagate/check abort signals. Agent SDK calls pass a forwarded `abortController` into `query()`.
- Regeneration helpers now use options objects instead of adding another positional argument to already-wide APIs.
- Approval regeneration aborts now return a non-rejected approval result instead of converting cancellation into a failed workflow.
- Final review aborts now return an interrupted summary and avoid `REVIEW_DONE`, `workflow_complete`, and `onComplete`.
- Retry validation now checks the workflow signal before validation and again before commit, preventing a commit after cancellation.
- Retry validation evidence now tags all validation entries with retry state and changed-file context, including passed final retry validation.

### Final review wave fixes

- Local Ollama implementers no longer require `OLLAMA_API_KEY` just because Ollama has an env-key name for exfiltration guarding.
- Known-provider `apiBase` variants with the same official origin, such as a trailing slash, can use the provider env key.
- Known providers using custom proxy `apiBase` values no longer receive misleading env-key recommendations in config warnings or docs.
- OpenAI-compatible and Anthropic streams now reject on mid-stream abort instead of returning partial text as a successful response.
- Claude Code planner and one-shot implementer invocations now pass abort signals down to the spawned `claude` process.

### Final structural loop fixes

- Removed the review-packet `build.ts` / `sections.ts` cycle with focused leaf modules:
  - `types.ts` for review-packet build/event types
  - `missing-artifacts.ts` for missing-artifact collection
  - `recovery.ts` for recovery-decision packet building
- Split review-packet recovery construction out of `sections.ts`, eliminating the placeholder `sourceArtifacts: []` shape and converting `makeRecoveryWithSources` to an options object.
- Removed the two-column picker cycle by moving virtual right-column item ownership to `virtual-items.ts`.
- Removed the validation/events cycle by moving `ValidationResult` to `validation-types.ts`.
- Removed explain-helper cycles by moving run-explain DTOs to `explain/types.ts`.
- Removed the session tree branch-summary/summary-prompt cycle by moving `BranchContext` to `branch-context.ts`.
- Removed duplicate Agent SDK abort logic by using the shared `throwIfAborted` helper.
- Added a typed ambient declaration for the optional Agent SDK peer and removed local `@ts-expect-error` suppressions in the SDK backend/session tests.
- Cleaned changed-test slop: approval config casts are centralized in a typed helper, final-review assertion narration comments were removed, and the invariant gate catalog is no longer exported as public API.

### Final confirmation fixes

- Updated Agent SDK stream parsing to match the current SDK shape:
  - assistant text is read from `message.content`
  - final response text is read from `result`
  - usage and session id handling remain unchanged
- Updated Agent SDK thinking options from `budget_tokens` to `budgetTokens`.
- Moved the Agent SDK invoke abort check before optional-peer loading, so an already-aborted call returns the cancellation reason even when the peer dependency is absent.
- Added/updated regression coverage for nested SDK message content, `result` final text, `budgetTokens`, and abort-before-load behavior.
- Tightened invariant gate execution with shell `pipefail` and explicit no-match handling for legitimate grep/rg zero-count gates.
- Added invariant-runner coverage for silent upstream pipeline failure (`false | wc -l`).

### Docs and gates

- `scripts/check-invariants.ts` now fails closed when a gate command itself fails.
- `scripts/check-invariants.ts` now also fails closed when a pipeline hides an upstream command failure behind `wc -l`, including silent nonzero upstream stages, or when a gate emits non-numeric output.
- Added integration coverage for invariant-runner command failure, hidden pipeline failure, and malformed output.
- Updated docs so `test-ci` includes invariants and the gate list is not duplicated across docs.
- Updated hook-trust docs so module hook path/content trust matches the implementation.
- Added parameter-object policy to `docs/PRINCIPLES.md`.
- Converted `processStream` to an options object, matching the parameter-object policy.

## Open Findings

### Critical / High

1. UI/feature layers still import engine internals in user-facing workflows:
   - `features/summary`
   - workflow recovery driver
   - workflow runner wiring

2. `brief-review.ts` mixes UI formatting, file IO, store mutation, and engine routing. It should be split into a pure parser/formatter plus a small workflow adapter.

3. Several wide APIs still need options objects:
   - `addUsageAndSave`
   - `Validator.runValidation`
   - `collectAndPersistClarifications`
   - `createQueueHandler`
   - `createOpenAICompatProvider`
   - `createAgentSdkPlanner`
   - escalation validation helpers
   - several orchestrator builders around clarification and queue operations

4. Test behavior still needs cleanup:
   - orchestrator tests assert private retry/approval/event sequencing too directly
   - UI tests assert exact copy/glyphs in places where behavior would be stronger
   - fakes encourage call-count assertions instead of workflow outcomes
   - review packet and recovery builders need more direct behavior tests

5. Big-file/registry pressure remains:
   - `runtime/commands/registry.ts`
   - `review-packet/sections.ts` after the first recovery split
   - `recovery/actions.ts`
   - `events/schema.ts`
   - several test files over 500 LOC

### Medium

1. Secure append is still missing for append-only persistence paths. Internal writes now use secure overwrite in more places, but append paths still need their own atomic/permission helper.

2. Hook trust is evaluated at workflow init. If a trusted module hook file is edited during the same long-lived process after trust is accepted, that in-process run can still use the already-trusted configuration.

3. Hook execution and some non-model waits are not uniformly abort-aware. Planner/implementer calls, approval regeneration, final review, and retry commit windows now propagate/check signals, but hook execution still relies on outer workflow control.

4. `lib/file-listing.ts` still carries diptych domain policy in a generic library folder. Move policy out or rename the module into the domain layer.

5. `createGate().wait()` can overwrite a pending resolver. Needs either single-waiter enforcement or a queue.

6. Budget pause recovery cannot offer `skip-current-task` when the pause happens on a current task.

7. Route-bigger recovery can still choose a rejected/unusable profile in some edge cases.

8. Review/status formatting is duplicated across explain, review packet, and TUI surfaces.

9. JSON persistence patterns remain duplicated. A schema-backed read/write helper would reduce repeated parse/default/write boilerplate.

10. Project language and metadata sources are better than in the prior audit, but still need one canonical path for all readiness, prompt, and validation heuristics.

11. CLI/app boundary still has misplaced command-context factory usage across CLI, app, and RPC.

12. `persistTranscript: false` still allows some metadata events, including workflow feature text, to be logged. Decide whether this is intentional metadata or privacy leakage.

### Low / Cleanup

- Remove or justify dead exports and shallow wrappers:
  - `MarkdownBlock`
  - `isNonNull`
  - `hasRetryBudget`
  - `summarizeUnknownError`
  - several same-file-only exports
- Reduce unnecessary comments in hook/config/prompt code where names already explain the behavior.
- Replace remaining type assertions in approval/handoff/repomap/tree-recorder with schema-backed or typed helpers.
- Use the existing `pluralize` helper consistently or remove it if local grammar is clearer.
- Deduplicate palette picker metadata and manual JSON output writing.

## Next Remediation Order

1. Move engine-facing feature imports behind small facades that preserve ownership boundaries.
2. Refactor the remaining 6+ positional public APIs to options objects, starting with `addUsageAndSave`, `Validator.runValidation`, clarifications, and queue handling.
3. Split `brief-review.ts` into pure formatting/IO/workflow adapter modules.
4. Continue splitting `review-packet/sections.ts` by section domain after the recovery split.
5. Add secure append helper and migrate append-only evidence/log/session writers where appropriate.
6. Split oversized tests only where the split improves behavior-focused coverage instead of adding call-count microtests.

## Verification So Far

- `npm test -- src/engine/implementers/api.test.ts`
- `npm test -- src/engine/implementers/api.test.ts src/engine/orchestrator/approval/tiered-approval.test.ts src/core/paths-io.test.ts src/core/sessions/io.test.ts src/engine/orchestrator/planning/speckit.test.ts src/lib/git.test.ts`
- `npm test -- testing/integration/cli/check-invariants.test.ts && npm run check:invariants`
- `npm test -- src/core/hooks/trust.test.ts src/engine/hooks/discover.test.ts src/engine/hooks/load-module.test.ts src/engine/orchestrator/run/init-hook-trust.test.ts`
- `npm test -- src/engine/providers/registry.test.ts src/engine/providers/client.test.ts src/engine/providers/openai-compat.test.ts src/engine/providers/provider-contract.test.ts src/engine/implementers/api.test.ts src/engine/planners/api.test.ts`
- `npm test -- src/engine/orchestrator/task/retry.test.ts src/engine/orchestrator/escalation/step.test.ts src/engine/orchestrator/task/step.test.ts`
- `npm test -- src/engine/session.test.ts src/engine/implementers/agent-sdk.test.ts src/engine/planners/agent.test.ts`
- `npm test -- src/engine/hooks/dispatch.test.ts src/engine/orchestrator/task/retry.test.ts src/engine/orchestrator/task/loop.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm test` — 400 files, 3,874 tests
- `npm run check:invariants` — 19/19 gates
- `npm test -- testing/integration/cli/check-invariants.test.ts src/engine/orchestrator/task/retry.test.ts src/engine/session.test.ts src/engine/providers/registry.test.ts src/engine/orchestrator/planning/speckit.test.ts` — 5 files, 58 tests
- `npm test -- src/engine/session.test.ts src/engine/orchestrator/approval/approval.test.ts src/engine/orchestrator/escalation/step.test.ts src/engine/orchestrator/planning/shared.test.ts src/engine/orchestrator/planning/speckit.test.ts src/engine/orchestrator/task/retry.test.ts` — 6 files, 50 tests
- `npm run lint`
- `npm run typecheck`
- `npm run check:invariants` — 19/19 gates
- `git diff --check`
- `npm test` — 400 files, 3,880 tests
- `npm test -- src/core/config/load/validate.test.ts src/engine/providers/registry.test.ts src/engine/providers/openai-stream.test.ts src/engine/providers/anthropic/stream.test.ts src/engine/claude-invoke.test.ts src/engine/orchestrator/final-review.test.ts src/engine/orchestrator/escalation/step.test.ts src/engine/orchestrator/task/retry.test.ts src/engine/orchestrator/approval/approval.test.ts src/engine/session.test.ts` — 10 files, 103 tests
- `npm run typecheck`
- `npm run lint`
- `npm run check:invariants` — 19/19 gates
- `git diff --check`
- `npm test` — 400 files, 3,888 tests
- `npm test -- src/components/pickers/two-column-picker/use-two-column-state.test.tsx` — 1 file, 3 tests
- `npm test -- src/engine/orchestrator/validation.test.ts src/engine/orchestrator/events.test.ts src/engine/orchestrator/evidence/task-evidence.test.ts src/engine/orchestrator/evidence/reporting.test.ts` — 4 files, 45 tests
- `npm test -- src/engine/orchestrator/explain/explain.test.ts` — 1 file, 3 tests
- Import-cycle probe — 0 cycles in `src`
- `npm test -- src/components/pickers/two-column-picker/use-two-column-state.test.tsx src/engine/orchestrator/explain/explain.test.ts src/engine/orchestrator/validation.test.ts src/engine/orchestrator/events.test.ts src/engine/orchestrator/evidence/task-evidence.test.ts src/engine/orchestrator/evidence/reporting.test.ts src/core/sessions/tree/branch-summary.test.ts src/core/sessions/tree/summary-prompt.test.ts src/engine/orchestrator/final-review.test.ts` — 9 files, 84 tests
- `npm test -- src/engine/session.test.ts src/engine/agent-sdk-backend.test.ts src/engine/orchestrator/approval/tiered-approval.test.ts src/engine/orchestrator/approval/gate-files.test.ts src/engine/orchestrator/final-review.test.ts src/engine/orchestrator/explain/explain.test.ts src/core/sessions/tree/branch-summary.test.ts src/core/sessions/tree/summary-prompt.test.ts testing/integration/cli/check-invariants.test.ts` — 9 files, 88 tests
- `npm run typecheck`
- `npm run lint`
- `npm run check:invariants` — 19/19 gates
- `git diff --check`
- `npm test -- src/engine/session.test.ts src/engine/agent-sdk-backend.test.ts src/engine/implementers/agent-sdk.test.ts testing/integration/cli/check-invariants.test.ts` — 4 files, 42 tests
- `npm run typecheck`
- `npm run lint`
- `npm run check:invariants` — 19/19 gates
- `git diff --check`
- `npm test` — 400 files, 3,891 tests

Closure note: the final confirmation loop found concrete Agent SDK and invariant-runner issues; those are closed and verified. No further confirmation loop is planned. The open findings are remaining architectural/test-boundary backlog, not unresolved regressions from this remediation pass.
