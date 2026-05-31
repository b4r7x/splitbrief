# Thermo-Nuclear Remediation Spec - 2026-05-31

Source audit: `docs/audits/thermo-nuclear-audit-2026-05-31.md`

Goal: fix all 13 confirmed findings from the thermo-nuclear audit, add the missing regression coverage, then run a fresh re-audit loop until no new medium/high issues remain.

## Critical Rules

1. Never run `git commit`, `git add`, `git stage`, or any command that stages or commits. Leave all changes unstaged.
2. Preserve ESM `.js` import suffixes.
3. Preserve project invariants: no barrel `index.ts`, no runtime classes, no memoization, no broad casts, no engine imports from UI layers.
4. Add behavior tests for every bug fix. Do not weaken existing tests to make them pass.
5. Keep comments sparse. Add comments only for non-obvious safety invariants.
6. After each phase, run `npm run typecheck`, `npm run lint`, `npm run check:invariants`, and the focused tests for that phase.
7. At the end, run `npm run test-ci`.

## Execution Order

Work in phases. Do not start broad refactors before the security/correctness fixes are done.

- P0: path confinement and snapshot/blob safety
- P1: CLI, streaming parser, and routing preview correctness
- P2: orchestrator lifecycle and test-helper correctness
- P3: architecture boundaries and plan-review metadata
- P4: code-quality decomposition
- P5: final validation and re-audit loop

## Definition of Done

- All checklist items below are checked.
- New tests fail on the old behavior and pass after the fix.
- `npm run test-ci` passes.
- A remediation re-audit file exists at `docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md`.
- The final re-audit wave reports no new medium/high issues.
- No files are staged or committed.

## P0 - Path Confinement And Snapshot Safety

### P0.1 Snapshot reject cannot escape `projectDir`

Finding: audit item 1.

Checklist:

- [ ] Add or reuse a realpath-aware helper for write/delete targets.
- [ ] Before `rejectRunSnapshot` writes restored baseline content, assert the target path is writable and confined inside `projectDir`.
- [ ] Before `rejectRunSnapshot` unlinks a file, assert the existing target is confined inside `projectDir`.
- [ ] Validate baseline blob entries before reading: `encodedName` must be hex, `decodeSnapshotPath(encodedName) === path`, and blob hash must match the expected manifest hash.
- [ ] Share the blob validation logic with snapshot restore and diff instead of duplicating it.
- [ ] Add a regression test that snapshots a normal file, replaces its parent directory with a symlink outside the repo, runs reject, and proves the outside target is untouched.
- [ ] Add a regression test with a tampered baseline manifest whose `encodedName` points outside snapshot storage.

Suggested files:

- `src/engine/snapshots/run.ts`
- `src/engine/snapshots/restore.ts`
- `src/engine/snapshots/diff.ts`
- `src/engine/snapshots/path-codec.ts` or a new `src/engine/snapshots/blob-resolver.ts`
- `src/lib/path-confinement.ts`
- `src/engine/snapshots/run.test.ts`

Focused checks:

```bash
npm run typecheck
npm test -- src/engine/snapshots/run.test.ts src/engine/snapshots/restore.test.ts src/engine/snapshots/diff.test.ts
```

### P0.2 Snapshot diff cannot disclose outside files

Finding: audit item 6.

Checklist:

- [ ] Before hashing or diffing a live current path, use realpath-aware read confinement.
- [ ] If the file does not exist, report the removed/missing status without reading through an unsafe path.
- [ ] Validate `fileEntries[].encodedName` before joining it under `snapshotFilesDir`.
- [ ] Add a symlink-parent regression for a recorded path used by `computeSnapshotDiff`.
- [ ] Add a tampered-manifest regression where `encodedName` points outside snapshot storage and must not be read.

Focused checks:

```bash
npm test -- src/engine/snapshots/diff.test.ts
```

### P0.3 `writeSecureFileAsync` is not secure through symlinked parents

Finding: audit item 12.

Checklist:

- [ ] Do not rely on final-target `lstat` only.
- [ ] Add a root-aware secure write API, for example `writeConfinedSecureFileAsync(rootDir, relativePath, content)`.
- [ ] Use `assertWritablePathConfined` or equivalent before temp write and rename.
- [ ] Migrate new call sites to the confined API:
  - `src/engine/snapshots/manifest.ts`
  - `src/engine/snapshots/run.ts`
  - `src/engine/detection/cache.ts`
- [ ] Keep `writeSecureFileAsync` only for truly rootless internal use, or make it require confinement options.
- [ ] Add a symlink-parent test in `src/lib/fs.test.ts`.

Focused checks:

```bash
npm test -- src/lib/fs.test.ts src/engine/snapshots/manifest.test.ts src/engine/snapshots/run.test.ts src/engine/detection/cache.test.ts
```

### P0.4 Confinement tests must cover the real escape class

Finding: audit item 11.

Checklist:

- [ ] Add POSIX symlink-parent regressions for snapshot reject.
- [ ] Add POSIX symlink-parent regressions for snapshot diff.
- [ ] Add POSIX symlink-parent regressions for `writeSecureFileAsync` or its replacement.
- [ ] Add POSIX symlink-parent regressions for handoff renderer output.
- [ ] Fix `src/engine/handoff/write.ts` if the new handoff test exposes the pre-existing product bug. Use the same realpath-aware write confinement pattern.

Focused checks:

```bash
npm test -- src/engine/handoff/write-confinement.test.ts src/engine/snapshots/run.test.ts src/engine/snapshots/diff.test.ts src/lib/fs.test.ts
```

## P1 - CLI, Streaming, And Routing Correctness

### P1.1 Detached `--mode full` must normalize nested overrides

Finding: audit item 2.

Checklist:

- [ ] Normalize `overrides.mode` before writing detached server args, or make `CLIOverridesSchema.mode` apply the same legacy-mode preprocess as top-level server args.
- [ ] Persist normalized mode (`speckit`), not legacy `full`, when possible.
- [ ] Add coverage for `parseIpcServerArgs({ mode: "full", overrides: { mode: "full" } })`.
- [ ] Add detached start coverage for `--detach --mode full`, reading the generated `server-args.json` and asserting nested mode parses as `speckit`.

Focused checks:

```bash
npm test -- src/engine/ipc/server-args.test.ts src/engine/ipc/spawn-server.test.ts src/cli/commands/start.test.ts
```

### P1.2 Routing preview must not read outside the project

Finding: audit item 4.

Checklist:

- [ ] Add confinement before `refreshTaskForRoutingPreview` reads `task.file`.
- [ ] Prefer sharing the live dispatcher's current-code refresh behavior if possible.
- [ ] On unsafe path, remove stale `currentCode` and return `current-code-unavailable`.
- [ ] Add regressions for `../` traversal, absolute paths, and symlinked parent directories.

Focused checks:

```bash
npm test -- src/engine/facades/routing-preview.test.ts
```

### P1.3 Malformed usage must not drop valid result text

Finding: audit item 5.

Checklist:

- [ ] Parse the result envelope independently from `usage`.
- [ ] Treat `usage` as `unknown` in the result event schema.
- [ ] Keep `toTokenDelta` responsible for validating token usage.
- [ ] Add a regression where `usage.input_tokens` is a string but `result` text and `isResult` are preserved.

Focused checks:

```bash
npm test -- src/engine/streaming/parse-stream-json.test.ts src/engine/streaming/output-parsers.stream.test.ts
```

## P2 - Orchestrator Lifecycle And Test Helpers

### P2.1 `applyChangedFiles` must pass lifecycle options into the shared gate

Finding: audit item 3.

Checklist:

- [ ] Pass `signal: wctx.signal` to `gateAndPromoteChangedFiles`.
- [ ] Pass `cleanup: staged ? () => staged.cleanup() : undefined`.
- [ ] Pass `catchChangedFilesError: true`.
- [ ] Add a test proving staged cleanup runs on successful promotion.
- [ ] Add a test proving changed-file snapshot errors return the old blocked-by-approval result instead of throwing through the workflow.
- [ ] Add or update abort coverage if the missing signal left a gap.

Focused checks:

```bash
npm test -- src/engine/orchestrator/task/apply-changed-files.test.ts src/engine/orchestrator/approval/gate-and-promote.test.ts
```

### P2.2 `makeWctx` must produce a production-shaped context

Finding: audit item 9.

Checklist:

- [ ] Change `makeWctx` so default `context.dir` equals `overrides.projectDir`.
- [ ] Preserve explicit `overrides.context` behavior.
- [ ] Add a regression for `makeWctx({ projectDir, sessionId }).context.dir === projectDir`.
- [ ] Search for other test helpers with the same pattern; fix only if changed code depends on them.

Focused checks:

```bash
npm test -- testing/helpers/orchestrator-factories.test.ts src/engine/orchestrator/**/*.test.ts
```

## P3 - Architecture Boundaries And Plan Review

### P3.1 Features and shared components must not import other features as utilities

Finding: audit item 7.

Checklist:

- [ ] Move terminal-width helpers out of `src/features/workflow/layout/`.
- [ ] Move `statusGlyph` out of `src/features/workflow/`.
- [ ] Move `renderMeterBar` out of `src/features/summary/components/`.
- [ ] Update imports in:
  - `src/components/overlays/overlay-panel.tsx`
  - `src/components/overlays/text-input-overlay.tsx`
  - `src/components/pickers/two-column-picker/picker.tsx`
  - `src/features/home/layout.ts`
  - `src/features/sessions/picker.tsx`
  - `src/features/settings/overlay.tsx`
  - `src/features/skills/picker.tsx`
  - `src/features/summary/components/evidence.tsx`
  - `src/features/workflow/components/cost/drilldown-overlay.tsx`
- [ ] Replace invariant 9 in `scripts/check-invariants.ts` with a resolver-based boundary check.
- [ ] The invariant must block:
  - `src/components/** -> src/features/**`
  - `src/features/<a>/** -> src/features/<b>/**` when `a !== b`
- [ ] Add tests or fixture coverage for the invariant so the current violations would fail.

Focused checks:

```bash
npm run check:invariants
npm test -- scripts/check-invariants.test.ts src/features/workflow/**/*.test.tsx src/components/**/*.test.tsx
```

### P3.2 Plan-review metadata must not live as TS-only contracts in `core/schemas`

Finding: audit item 13.

Checklist:

- [ ] Move TS-only plan-review types out of `src/core/schemas/`, or add real Zod schemas if this data crosses disk/subprocess/network boundaries.
- [ ] Keep type ownership close to the producer/consumer, or create a neutral non-schema module such as `src/core/plan-review/`.
- [ ] Replace `routingReason.includes(...)` classification with explicit typed fields.
- [ ] Candidate fields: `routingBlockKind`, `currentCodeContextMode`, `currentCodeTruncated`.
- [ ] Update routing preview and scorecard code to consume typed metadata.
- [ ] Add tests proving a wording change in `routingReason` does not change readiness classification.

Focused checks:

```bash
npm test -- src/engine/facades/routing-preview.test.ts src/features/workflow/plan-review-scorecard.test.ts
rg -n "routingReason.*includes|includes\\('no capable'|includes\\('overflows'|function-level context|current code truncated" src
# Expected: no behavior-critical string matching remains.
```

## P4 - Code-Quality Decomposition

### P4.1 Split over-1k test files

Finding: audit item 8.

Checklist:

- [ ] Split `src/engine/orchestrator/planning.test.ts` into focused files.
- [ ] Suggested split:
  - planning approvals
  - rejection context
  - continuation
  - rewind
- [ ] Split `src/core/runtime/commands/registry.test.ts` into focused files.
- [ ] Suggested split:
  - dispatch
  - workflow commands
  - session artifacts
  - snapshots/handoff/export
- [ ] Keep shared setup in small local helpers, not a new global test kitchen sink.
- [ ] Keep each new test file under 1k lines.
- [ ] Keep `src/engine/orchestrator/run/phases.test.ts` below 1k.

Focused checks:

```bash
wc -l src/engine/orchestrator/planning*.test.ts src/core/runtime/commands/registry*.test.ts src/engine/orchestrator/run/phases.test.ts
npm test -- src/engine/orchestrator/planning*.test.ts src/core/runtime/commands/registry*.test.ts src/engine/orchestrator/run/phases.test.ts
```

### P4.2 Split `runTaskLoop`

Finding: audit item 10.

Checklist:

- [ ] Extract dependency gate logic.
- [ ] Extract user-edit conflict gate logic.
- [ ] Extract routing/profile selection logic.
- [ ] Extract post-task reconciliation logic.
- [ ] Extract a shared stop-with-review helper for repeated stop paths.
- [ ] Keep `runTaskLoop` as a small iterator over clear step results.
- [ ] Preserve behavior. This is a structure change, not a workflow behavior change.

Focused checks:

```bash
wc -l src/engine/orchestrator/task/loop.ts
npm test -- src/engine/orchestrator/task/loop.test.ts src/engine/orchestrator/run/phases.test.ts
```

## P5 - Final Validation And Re-Audit

### P5.1 Full validation

Run:

```bash
npm run typecheck
npm run lint
npm run check:invariants
npm run test-ci
```

Manual checks:

```bash
git status --short
# Expected: modified/untracked files only. Nothing staged.

rg -n "routingReason.*includes|includes\\('no capable'|includes\\('overflows'|function-level context|current code truncated" src
# Expected: no behavior-critical string matching remains.

rg -n "features/(workflow|summary)|summary/components/meter-bar|workflow/status-glyph|workflow/layout/terminal-width" src/components src/features
# Expected: no cross-feature/shared-component imports remain.

wc -l src/engine/orchestrator/planning*.test.ts src/core/runtime/commands/registry*.test.ts src/engine/orchestrator/task/loop.ts
# Expected: each file below 1000 lines; task loop materially smaller than 401 lines.

rg -n "encodedName" src/engine/snapshots
# Manual review: blob reads must go through the validated resolver.
```

### P5.2 Re-audit file

Create `docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md` with:

- Scope: files changed by the remediation.
- Fix summary: map each finding 1-13 to `fixed`, `partially fixed`, or `not fixed`.
- Test evidence: exact commands and pass/fail results.
- Rejected candidates: anything investigated and rejected as duplicate/out of scope.
- Remaining issues: only confirmed medium/high issues.

### P5.3 Re-audit wave

Run at least two waves. Each verifier must read:

1. `docs/audits/thermo-nuclear-audit-2026-05-31.md`
2. `docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md`
3. `docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md`

Verifier prompts:

```text
Read the original audit, the remediation spec, and the current remediation re-audit file first.
Review the current unstaged remediation changes read-only.
Focus on security/correctness regressions and whether findings 1-6, 11, and 12 are fully fixed.
Do not edit, stage, or commit.
Return only confirmed medium/high issues or say no new findings.
```

```text
Read the original audit, the remediation spec, and the current remediation re-audit file first.
Review the current unstaged remediation changes read-only.
Focus on architecture/code-quality findings 7, 8, 10, and 13.
Do not edit, stage, or commit.
Return only confirmed medium/high issues or say no new findings.
```

```text
Read the original audit, the remediation spec, and the current remediation re-audit file first.
Review the current unstaged remediation changes read-only.
Focus on tests and false-positive coverage for findings 2, 4, 5, 9, and 11.
Do not edit, stage, or commit.
Return only confirmed medium/high issues or say no new findings.
```

Loop rule:

- If a verifier finds a valid medium/high issue, fix it, update the re-audit file, and run another verifier wave.
- Stop only after a full wave returns no new medium/high findings.

## Copy-Paste Prompt For The Fixing Agent

```text
You are fixing the thermo-nuclear audit findings for this repo.

Critical rules:
- Never run git add, git stage, git commit, or anything that stages/commits.
- Leave all changes unstaged.
- Preserve ESM .js import suffixes and project invariants.
- Add regression tests for every behavior fix.

Read these files first:
- docs/audits/thermo-nuclear-audit-2026-05-31.md
- docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md

Execute the spec phase by phase:
P0 path confinement and snapshot/blob safety
P1 CLI, streaming parser, and routing preview correctness
P2 orchestrator lifecycle and test-helper correctness
P3 architecture boundaries and plan-review metadata
P4 code-quality decomposition
P5 final validation and re-audit

After each phase, run the focused checks listed in the spec.
At the end, run npm run test-ci, create docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md, and run the re-audit loop until a full verifier wave returns no new medium/high findings.
```
