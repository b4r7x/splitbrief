# Thermo-Nuclear Remediation Subagent Prompts - 2026-05-31

Use these prompts with subagents while executing `docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md`.

Every subagent must receive the global contract below. Then paste the phase-specific prompt for that subagent.

## Global Contract

```text
CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Leave all changes unstaged.
- Do not revert unrelated user changes.
- Preserve ESM .js import suffixes.
- Preserve repo invariants: no barrel index.ts files, no runtime classes, no memoization, no broad casts, no engine imports from UI layers.
- Add behavior tests for every bug fix.
- Do not weaken tests to make them pass.
- Keep comments sparse and only for non-obvious safety invariants.

Required source files:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md

Report format:
STATUS: DONE | BLOCKED
FILES_CHANGED:
- path
TESTS_RUN:
- command: PASS | FAIL
NOTES:
- short note, or "none"
```

## P0 Implementer - Path Confinement And Snapshot Safety

```text
You are the P0 implementer for the thermo-nuclear remediation.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md, P0 only

Own these findings:
- 1: run snapshot rejection can follow symlinked parents and unchecked encodedName blobs
- 6: snapshot diff can disclose outside files through symlinked parents and unchecked encodedName blobs
- 11: confinement tests cover lexical traversal but miss symlink-parent escapes
- 12: writeSecureFileAsync follows symlinked parent directories

Implement the P0 checklist:
- Add or reuse realpath-aware confinement for reject write/delete paths.
- Add a validated snapshot blob resolver shared by run, restore, and diff.
- Validate encodedName as hex, decoded path equality, and expected hash before blob reads.
- Make secure async writes root-aware or introduce a confined async write helper.
- Migrate snapshot manifest, run ledger, and detection cache writes to the confined writer.
- Add POSIX symlink-parent regressions for snapshot reject, snapshot diff, secure async writes, and handoff renderer output.
- Fix handoff output writes if the new regression exposes the existing bug.

Run:
- npm run typecheck
- npm test -- src/engine/snapshots/run.test.ts src/engine/snapshots/restore.test.ts src/engine/snapshots/diff.test.ts src/lib/fs.test.ts src/engine/handoff/write-confinement.test.ts

Return using the global report format.
```

## P1 Implementer - CLI, Streaming, And Routing Correctness

```text
You are the P1 implementer for the thermo-nuclear remediation.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md, P1 only

Own these findings:
- 2: detached --mode full rejects a documented alias through nested overrides
- 4: routing preview can read files outside projectDir
- 5: malformed stream-json usage drops valid result text

Implement the P1 checklist:
- Normalize overrides.mode for detached server args or make CLIOverridesSchema accept legacy aliases through the same preprocess as top-level mode.
- Add parseIpcServerArgs coverage for mode full with overrides.mode full.
- Add detached start coverage for --detach --mode full.
- Add confinement before refreshTaskForRoutingPreview reads task.file.
- Unsafe routing-preview paths must remove stale currentCode and return current-code-unavailable.
- Parse stream-json result envelope independently from usage.
- Treat usage as unknown and let toTokenDelta validate it.

Run:
- npm run typecheck
- npm test -- src/engine/ipc/server-args.test.ts src/engine/ipc/spawn-server.test.ts src/cli/commands/start.test.ts
- npm test -- src/engine/facades/routing-preview.test.ts
- npm test -- src/engine/streaming/parse-stream-json.test.ts src/engine/streaming/output-parsers.stream.test.ts

Return using the global report format.
```

## P2 Implementer - Orchestrator Lifecycle And Test Helpers

```text
You are the P2 implementer for the thermo-nuclear remediation.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md, P2 only

Own these findings:
- 3: applyChangedFiles stopped passing cleanup, abort, and error handling into the shared gate
- 9: makeWctx builds an inconsistent workflow context

Implement the P2 checklist:
- Pass signal, cleanup, and catchChangedFilesError from applyChangedFiles into gateAndPromoteChangedFiles.
- Add regression coverage for staged cleanup on successful promotion.
- Add regression coverage for changed-file snapshot errors returning the blocked approval result instead of throwing through the workflow.
- Update makeWctx so default context.dir equals overrides.projectDir.
- Preserve explicit overrides.context behavior.
- Add a makeWctx regression for context.dir.

Run:
- npm run typecheck
- npm test -- src/engine/orchestrator/task/apply-changed-files.test.ts src/engine/orchestrator/approval/gate-and-promote.test.ts
- npm test -- testing/helpers/orchestrator-factories.test.ts src/engine/orchestrator/**/*.test.ts

Return using the global report format.
```

## P3 Implementer - Architecture Boundaries And Plan Review

```text
You are the P3 implementer for the thermo-nuclear remediation.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md, P3 only

Own these findings:
- 7: feature modules and shared TUI components use other features as utility layers
- 13: plan-review runtime logic lives in core/schemas without schemas and classifies state by message text

Implement the P3 checklist:
- Move terminal-width helpers, statusGlyph, and renderMeterBar to shared non-feature ownership.
- Update every import listed in P3.1 of the remediation spec.
- Replace invariant 9 with a resolver-based boundary check.
- The invariant must block src/components/** -> src/features/** and sibling feature imports.
- Add invariant tests or fixtures proving the current violations fail.
- Move TS-only plan-review contracts out of src/core/schemas, or add real Zod schemas if they cross runtime boundaries.
- Replace routingReason.includes behavior with explicit typed fields.
- Add tests proving routing reason wording changes do not alter readiness classification.

Run:
- npm run check:invariants
- npm test -- scripts/check-invariants.test.ts src/features/workflow/**/*.test.tsx src/components/**/*.test.tsx
- npm test -- src/engine/facades/routing-preview.test.ts src/features/workflow/plan-review-scorecard.test.ts
- rg -n "routingReason.*includes|includes\\('no capable'|includes\\('overflows'|function-level context|current code truncated" src

Return using the global report format.
```

## P4 Implementer - Code-Quality Decomposition

```text
You are the P4 implementer for the thermo-nuclear remediation.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md, P4 only

Own these findings:
- 8: two test files crossed the 1k-line decomposition threshold
- 10: runTaskLoop became a multi-policy orchestration blob

Implement the P4 checklist:
- Split src/engine/orchestrator/planning.test.ts into focused test files.
- Split src/core/runtime/commands/registry.test.ts into focused test files.
- Keep shared setup small and local.
- Keep each split test file below 1000 lines.
- Extract dependency gate, user-edit gate, routing/profile selection, post-task reconciliation, and stop-with-review logic out of runTaskLoop.
- Keep runTaskLoop as a small iterator over clear step results.
- Preserve behavior.

Run:
- wc -l src/engine/orchestrator/planning*.test.ts src/core/runtime/commands/registry*.test.ts src/engine/orchestrator/run/phases.test.ts src/engine/orchestrator/task/loop.ts
- npm test -- src/engine/orchestrator/planning*.test.ts src/core/runtime/commands/registry*.test.ts src/engine/orchestrator/run/phases.test.ts
- npm test -- src/engine/orchestrator/task/loop.test.ts src/engine/orchestrator/run/phases.test.ts

Return using the global report format.
```

## Phase Validator Prompt

```text
You are validating one remediation phase.

CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Do not edit files unless explicitly asked to be a fixer.
- Review only the current unstaged remediation changes for this phase.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md

Validate phase: <PASTE PHASE NAME>
Findings in scope: <PASTE FINDING NUMBERS>

Tasks:
1. Read the changed files for this phase.
2. Confirm each checklist item for the phase is actually complete.
3. Confirm the tests assert the new behavior, not a weaker version of the old behavior.
4. Run the focused checks from the remediation spec for this phase.
5. Report only concrete remaining issues with file:line evidence.

Report format:
STATUS: PASS | FAIL
TESTS_RUN:
- command: PASS | FAIL
REMAINING_ISSUES:
- finding <n>: path:line - issue
```

## Fixer Prompt

```text
You are fixing remaining issues from validation.

CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Do not revert unrelated changes.

Read:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md

Remaining issues to fix:
<PASTE VALIDATOR REMAINING_ISSUES>

Fix only those issues. Add or update tests where needed. Run the focused checks for the affected phase.

Report format:
STATUS: DONE | BLOCKED
FILES_CHANGED:
- path
TESTS_RUN:
- command: PASS | FAIL
NOTES:
- short note
```

## Re-Audit Security Verifier Prompt

```text
You are a read-only re-audit verifier.

CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Do not edit files.

Read first:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md
- docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md

Review the current unstaged remediation changes.
Focus on security and correctness for findings 1, 2, 3, 4, 5, 6, 11, and 12.
Do not repeat already documented fixed items unless they are still broken.

Return only:
- confirmed remaining medium/high issues with file:line evidence, impact, and exact remediation
- or "No new findings"
```

## Re-Audit Architecture Verifier Prompt

```text
You are a read-only re-audit verifier.

CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Do not edit files.

Read first:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md
- docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md

Review the current unstaged remediation changes.
Focus on architecture and code quality for findings 7, 8, 10, and 13.
Check for new wrong-layer imports, giant files, weak invariant checks, text-based behavior classification, and over-complicated refactors.

Return only:
- confirmed remaining medium/high issues with file:line evidence, impact, and exact remediation
- or "No new findings"
```

## Re-Audit Test Verifier Prompt

```text
You are a read-only re-audit verifier.

CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Do not edit files.

Read first:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md
- docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md

Review the current unstaged remediation changes.
Focus on whether tests would have failed for the original bugs and now pass for the fixes.
Pay special attention to findings 2, 4, 5, 9, and 11.

Return only:
- confirmed remaining medium/high test gaps or false-positive tests with file:line evidence
- or "No new findings"
```

## Final Whole-Diff Re-Audit Prompt

```text
You are the final read-only verifier.

CRITICAL RULES:
- Never run git add, git stage, git commit, or any command that stages or commits.
- Do not edit files.

Read first:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md
- docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md

Review the full unstaged remediation diff.
Report only confirmed new medium/high security, correctness, or maintainability issues introduced by the remediation, or confirmed audit findings that remain unfixed.
If everything is clean, say "No new findings".
```
