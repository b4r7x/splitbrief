# Thermo-Nuclear Audit - 2026-05-31

## Scope

- Reviewed range: `HEAD^..HEAD` (`7f936ec audit cleanup`)
- Reason: working tree and staged diff were empty; `main` matched `origin/main`.
- Ignore this audit file in subsequent review rounds.

## Method

- Apply `thermo-nuclear-review`: security, correctness, breaking behavior, devex regressions, and feature leaks in added or modified code.
- Apply `thermo-nuclear-code-quality-review`: structural regressions, abstraction quality, file-size growth, spaghetti branching, type-boundary problems, and missed simplifications.
- Run parallel subagents over non-overlapping domains.
- After each round, merge only new, evidence-backed findings here and pass this file into the next round to prevent duplicate reporting.

## Findings

### High

1. Run snapshot rejection hardening can still follow symlinked parents outside `projectDir`.
   - Evidence: `src/engine/snapshots/run.ts:158` and `src/engine/snapshots/run.ts:249` add lexical `assertPathConfined` checks, but `src/engine/snapshots/run.ts:178` still writes `join(projectDir, path)` and `src/engine/snapshots/run.ts:263` still unlinks `join(projectDir, path)`. `restoreBaselineFile` also builds a blob source path from unchecked `baselineEntry.encodedName` at `src/engine/snapshots/run.ts:160`.
   - Impact: if a recorded path has a parent directory that is replaced with a symlink after capture, reject can write to or delete a file outside the project while passing the new lexical checks. A tampered baseline manifest can also point `encodedName` outside snapshot storage and make reject restore that outside content into a project file.
   - Remediation: use a realpath-aware writable-path helper for reject write and delete paths. Share a validated snapshot-blob resolver with restore and diff: `encodedName` must be hex, decode back to the manifest path, and match the manifest hash before any blob read.

### Medium

2. `start --detach --mode full` rejects a documented mode alias.
   - Evidence: `src/cli/options.ts:24` still documents `full=speckit`. `src/cli/commands/start.ts:145` stores `opts.mode ?? 'standard'`, and line 151 persists that raw mode inside `overrides`. `src/engine/ipc/server-args.ts:15` normalizes only the top-level `mode`; `src/core/config/runtime/overrides.ts:32` validates `overrides.mode` with `WorkflowModeSchema` directly.
   - Impact: detached starts with `--mode full` write `overrides.mode: "full"` to `server-args.json`. The child rejects the args and exits before opening IPC, so the parent times out.
   - Remediation: normalize `overrides.mode` before persistence or make `CLIOverridesSchema.mode` use the same legacy-mode preprocess. Add coverage for `parseIpcServerArgs({ mode: "full", overrides: { mode: "full" } })`; existing tests cover top-level `mode: "full"` with empty overrides and detached overrides with `--mode quick`, not this broken nested alias path.

3. `applyChangedFiles` stopped passing cleanup, abort, and error-handling options into the shared gate.
   - Evidence: `src/engine/orchestrator/task/apply-changed-files.ts:32` calls `gateAndPromoteChangedFiles` without `cleanup`, `catchChangedFilesError`, or `signal`. The new helper has those options at `src/engine/orchestrator/approval/gate-and-promote.ts:36`.
   - Impact: staged task directories can leak after task approval, and a changed-files snapshot error now throws through the workflow instead of returning the old blocked-by-approval result.
   - Remediation: pass `signal: wctx.signal`, `cleanup: staged ? () => staged.cleanup() : undefined`, and `catchChangedFilesError: true` from `applyChangedFiles`.

4. Routing preview can read files outside the project.
   - Evidence: `src/engine/facades/routing-preview.ts:404` reads `readFile(join(projectDir, task.file), 'utf-8')` without path confinement. The live dispatcher guards the same operation in `src/engine/orchestrator/state-ops.ts:56`.
   - Impact: a `Task` object that bypasses frontmatter validation can make the preview read arbitrary local files and include that content in routing metadata.
   - Remediation: run `assertPathConfined(task.file, projectDir)` before reading, or share the existing current-code refresh helper. On failure, remove stale `currentCode` and return `current-code-unavailable`.

5. Malformed `usage` drops otherwise valid stream-json result text.
   - Evidence: `src/engine/streaming/parse-stream-json.ts:34` validates result events with `TokenUsageLikeSchema`. If a provider sends `"input_tokens": "10"`, `ResultEvent.safeParse` fails at line 69 and the parser returns only the session id.
   - Impact: a bad token-usage payload silently discards final text and `isResult`, making a provider response look incomplete.
   - Remediation: parse the result envelope independently from usage. Treat `usage` as `unknown` in `ResultEvent` and pass it through `toTokenDelta`.

6. `snapshot diff` can disclose files outside the project through symlinked parents.
   - Evidence: `src/engine/snapshots/diff.ts:129` uses lexical `assertPathConfined`, then line 131 hashes `join(projectDir, path)` and line 169 diffs the same live path. The same function maps `fileEntries` at line 123 and joins unchecked `encodedName` values into `snapshotFilesDir` at lines 152 and 162.
   - Impact: after a snapshot records `src/file.ts`, replacing `src` with a symlink outside the repo lets `diptych snapshot diff` read and print outside file contents. A tampered manifest can also point `encodedName` outside snapshot storage and include that outside blob in the diff.
   - Remediation: use realpath-aware read confinement before hashing or diffing a live current path. Validate every blob entry before reading it: `encodedName` must be hex, decode back to the manifest path, and match the manifest hash.

7. Feature modules and shared TUI components now use other features as utility layers.
   - Evidence: `src/components/overlays/overlay-panel.tsx:5`, `src/components/overlays/text-input-overlay.tsx:8`, and `src/components/pickers/two-column-picker/picker.tsx:5` import workflow terminal-width helpers. Sibling features do the same in `src/features/home/layout.ts:1`, `src/features/sessions/picker.tsx:6`, `src/features/settings/overlay.tsx:13`, and `src/features/skills/picker.tsx:6`. `src/features/summary/components/evidence.tsx:7` imports `src/features/workflow/status-glyph.ts`. `src/features/workflow/components/cost/drilldown-overlay.tsx:18` imports `renderMeterBar` from `src/features/summary/components/meter-bar.ts`.
   - Impact: `workflow` and `summary` both became accidental shared utility layers. Local feature refactors can now break sibling features and generic components.
   - Remediation: move terminal-width helpers, task status glyphs, and `renderMeterBar` to a shared component or utility layer. Replace the current regex invariant in `scripts/check-invariants.ts:72` with a resolver-based import-boundary check that blocks `src/components/** -> src/features/**` and sibling feature imports. The current gate misses these imports.

8. Two test files crossed the 1k-line decomposition threshold in this commit.
   - Evidence: `src/engine/orchestrator/planning.test.ts` grew from 891 to 1093 lines. `src/core/runtime/commands/registry.test.ts` grew from 695 to 1020 lines. `src/engine/orchestrator/run/phases.test.ts` is now 906 lines.
   - Impact: both files mix several behavioral areas, so future tests will keep accumulating in already broad files.
   - Remediation: split by behavior. For example, split registry tests into dispatch, workflow commands, and session artifacts; split planning tests into approvals, rejection context, continuation, and rewind.

9. `makeWctx` test helper builds an inconsistent workflow context.
    - Evidence: `testing/helpers/orchestrator-factories.ts:34` sets `context: defaultContext` before spreading overrides at line 40. `defaultContext.dir` is a temp path from `testing/helpers/factories/config.ts:107`, not the caller's `projectDir`.
    - Impact: tests that call `makeWctx({ projectDir, ... })` can run with `wctx.projectDir !== wctx.context.dir`, masking project-dir-sensitive behavior.
    - Remediation: derive the default context from `overrides.projectDir`, for example `context: { ...defaultContext, dir: overrides.projectDir }`, while still letting explicit `overrides.context` win.

10. `runTaskLoop` became a multi-policy orchestration blob.
    - Evidence: `src/engine/orchestrator/task/loop.ts` grew from 199 to 401 lines. The single `runTaskLoop` now handles dependency recovery, user-edit conflict checks, code refresh, routing, profile construction, pre/post snapshots, accepted-file baseline updates, task review, and budget checks. Repeated stop-and-review paths appear around lines 135, 161, 232, 310, and 346.
    - Impact: recovery, routing, snapshots, review, and budget logic now share one mutable loop body. Future changes will keep adding early returns and cross-policy state.
    - Remediation: extract the per-task pipeline into focused steps: dependency gate, user-edit gate, routing/profile selection, task execution, post-task reconciliation, and a shared stop-with-review helper.

11. New confinement tests cover lexical traversal but miss symlink-parent escapes.
    - Evidence: `src/engine/snapshots/diff.test.ts:118`, `src/engine/snapshots/run.test.ts:182`, and `src/engine/handoff/write-confinement.test.ts:202` test `../` or absolute-style paths. They do not test a valid recorded path whose parent directory is replaced by a symlink. `src/lib/fs.test.ts:236` tests only a final-file symlink for `writeSecureFileAsync`. The implementation paths in findings 1, 6, and 12 still use lexical or final-path checks before filesystem operations, and `src/engine/handoff/write.ts:176` has the same lexical write guard for renderer output.
    - Impact: the new tests can pass while the real symlink escape paths remain open. For handoff output, the product write loop predates this branch, but the newly added confinement tests give false confidence.
    - Remediation: add POSIX symlink-parent regression tests for snapshot reject, snapshot diff, `writeSecureFileAsync`, and handoff renderer output. Verify the outside target is untouched.

12. Newly added `writeSecureFileAsync` follows symlinked parent directories.
    - Evidence: `src/lib/fs.ts:78` creates the parent directory, checks only the final target with `lstat`, then writes and renames a temp file in `dirname(filePath)` at lines 94 and 95. New call sites include snapshot manifests in `src/engine/snapshots/manifest.ts:20`, run ledger writes in `src/engine/snapshots/run.ts:58`, and detection cache writes in `src/engine/detection/cache.ts:117`.
    - Impact: if `.diptych` or another expected parent under `projectDir` is a symlink to an outside directory, these "secure" async writes create or replace files outside the project metadata tree.
    - Remediation: make the async writer root-aware or require callers to pass through a realpath-aware confinement helper before the temp write and rename. Add a symlink-parent regression test.

13. Plan-review runtime logic lives in `core/schemas` without schemas and classifies state by message text.
    - Evidence: `docs/TYPES.md:17` says runtime Zod validators live in `src/core/schemas/`, while TS-only types live with the consumer. `src/core/schemas/plan-review.ts:1` adds only TS types and interfaces. `src/core/schemas/plan-review-predicates.ts:8` adds runtime helpers in the schemas folder, and lines 11 to 12 and 23 to 25 classify state with `routingReason.includes(...)`.
    - Impact: `core/schemas` no longer means boundary-validated runtime shape, and review readiness can change when someone edits a human-facing routing reason string.
    - Remediation: move TS-only plan-review contracts out of `core/schemas`, or add real Zod schemas if the data crosses a runtime boundary. Replace string matching with explicit typed fields such as `routingBlockKind`, `currentCodeContextMode`, or `currentCodeTruncated`.

## Rejected Or Duplicate Candidates

- Duplicate: detached `--mode full` was reported independently by multiple agents. It is recorded once as finding 2.
- Duplicate: shared TUI imports from `features/workflow` were reported independently by multiple agents. They are recorded once as finding 7.
- Duplicate: missing staged cleanup and changed-file error handling in `applyChangedFiles` was rechecked in round two. It remains finding 3.
- Pre-existing: `src/engine/snapshots/restore.ts` has the same symlink-parent write problem as finding 1, but that restore write path existed in `HEAD^`. Keep it for the same hardening patch, but do not count it as a new branch regression.
- Pre-existing: `src/engine/snapshots/create.ts` still records snapshot entries when blob capture fails. The behavior was moved from `HEAD^:src/engine/snapshots/store.ts`, so it is not counted as a new branch finding.
- Pre-existing: `src/engine/snapshots/lock.ts` still uses ownerless stale locks. The behavior was moved from `HEAD^:src/engine/snapshots/store.ts`, so it is not counted as a new branch finding.
- Pre-existing: `src/engine/handoff/write.ts` uses lexical path confinement before writing renderer files under `outDir`. The write loop predates this branch. The new issue in this branch is the narrower test coverage recorded in finding 11.
- Rejected: `src/engine/streaming/parse-jsonl.ts` uses strict usage parsing, but malformed usage only drops token usage for `turn.completed`; it does not discard final result text.
- Rejected: `src/engine/providers/anthropic/stream.ts` may be brittle for CRLF SSE boundaries, but the boundary logic predates `HEAD^..HEAD`.

## Verification Notes

- First wave ran 10 read-only subagents across CLI, config, orchestrator, snapshots, TUI, streaming, IPC, tests, whole-diff code quality, and whole-diff correctness.
- Second wave ran 6 read-only subagents with this audit file as required context, then deduped against the first wave.
- Third wave ran 6 read-only subagents with this audit file as required context, then added only corrections and the `writeSecureFileAsync` finding.
- Fourth wave ran 4 read-only subagents with this audit file as required context. Three reported no new findings; one added the plan-review schema-boundary finding.
- Fifth wave ran 3 read-only subagents with this audit file as required context. It found no new findings, only the invariant correction now folded into finding 7.
- Local `npm run typecheck` passed.
- Local `npm run lint` passed.
- Local `npm run check:invariants` passed.
- Local `npm test` passed: 416 files, 3908 tests.
- Local reproduction for finding 2: `parseIpcServerArgs` returned `null` when `overrides.mode` was `"full"`.
- Local reproduction for finding 4: `refreshTaskForRoutingPreview({ action: "modify", file: "../../../../../../etc/hosts" }, process.cwd())` returned `estimateStatus: "refreshed-current-code"` and populated `currentCode`.
- Local reproduction for finding 5: malformed `usage.input_tokens` returned `{"sessionId":"s"}` and dropped result text.
- Local reproduction for finding 12: writing through `writeSecureFileAsync(root/meta/cache.json)` where `root/meta` is a symlink wrote `SECRET` into the outside directory.
- `gh` and `glab` are not installed in this environment, so PR discussion comments could not be checked through those CLIs.
