# Thermo-Nuclear Remediation Re-Audit - 2026-05-31

Source audit: `docs/audits/thermo-nuclear-audit-2026-05-31.md`
Remediation spec: `docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md`

This re-audit confirms the remediation of all 13 findings, records the validation
evidence, and lists remaining confirmed medium/high issues (none).

## Scope (files changed)

Production source:

- `src/lib/fs.ts` — root-aware `writeConfinedSecureFileAsync`; `writeSecureFileAsync` confinement.
- `src/lib/path-confinement.ts` — realpath-aware `assertWritablePathConfined` / readable confinement.
- `src/engine/snapshots/run.ts` — reject read/write/delete confinement; validated baseline blob reads.
- `src/engine/snapshots/restore.ts` — shared validated blob resolver.
- `src/engine/snapshots/diff.ts` — realpath read confinement; validated delta/file-entry blob reads.
- `src/engine/snapshots/blob-resolver.ts` (new) — shared `resolveValidatedBlobPath` (hex `encodedName`, decode-equals-path, hash match).
- `src/engine/snapshots/manifest.ts` — migrated to confined secure write.
- `src/engine/detection/cache.ts` — migrated to confined secure write.
- `src/engine/handoff/write.ts` — realpath write confinement for renderer output.
- `src/core/config/runtime/overrides.ts` — `CLIOverridesSchema.mode` legacy-mode preprocess.
- `src/engine/facades/routing-preview.ts` — confinement before `task.file` read; `current-code-unavailable` on unsafe path.
- `src/engine/streaming/parse-stream-json.ts` — `ResultEvent.usage` treated as `unknown`, passed through `toTokenDelta`.
- `src/engine/orchestrator/task/apply-changed-files.ts` — passes `signal`, `cleanup`, `catchChangedFilesError`.
- `src/engine/orchestrator/task/loop.ts` — decomposed (401 → 210 lines).
- `src/engine/orchestrator/task/{dependency-gate,user-edit-gate,routing-selection,post-task,stop-with-review,auto-snapshot}.ts` (new) — extracted per-task steps.
- `src/core/plan-review/{types,predicates}.ts` (new) — TS-only plan-review contracts moved out of `core/schemas`.
- `src/features/workflow/plan-review-scorecard.ts`, `src/engine/facades/routing-preview.ts` — typed `routingBlockKind` / `currentCodeContextMode` / `currentCodeTruncated` classification.
- `src/utils/terminal-width.ts`, `src/utils/meter-bar.ts`, `src/core/task-status-glyph.ts` (new) — shared utilities moved out of features.
- Import-site updates: `src/components/overlays/overlay-panel.tsx`, `src/components/overlays/text-input-overlay.tsx`, `src/components/pickers/two-column-picker/picker.tsx`, `src/features/home/layout.ts`, `src/features/sessions/picker.tsx`, `src/features/settings/overlay.tsx`, `src/features/skills/picker.tsx`, `src/features/summary/components/evidence.tsx`, `src/features/summary/components/progress.tsx`, `src/features/workflow/components/cost/drilldown-overlay.tsx`, `src/features/workflow/components/{sidebar,task-summary,brief-review-format}.tsx`, `src/stores/workflow/plan-editor.ts`.
- Removed: `src/features/workflow/layout/terminal-width.ts`, `src/features/workflow/status-glyph.ts`, `src/features/summary/components/meter-bar.ts`, `src/core/schemas/plan-review.ts`, `src/core/schemas/plan-review-predicates.ts`.
- `scripts/check-invariants.ts` + `scripts/import-boundaries.ts` (new) — resolver-based boundary check (components→features, sibling features).

Tooling/tests:

- New: `scripts/check-invariants.test.ts`, `testing/helpers/orchestrator-factories.test.ts`, `testing/helpers/{planning-phase,runtime-commands}.ts`.
- New split tests: `src/engine/orchestrator/planning-{approvals,continuation,rejection,rewind}.test.ts`, `src/core/runtime/commands/registry-{dispatch,session,snapshots,workflow}.test.ts`, `src/engine/orchestrator/task/apply-changed-files.test.ts`.
- Modified tests: snapshot/handoff confinement, routing-preview, streaming, server-args/spawn, fs, scorecard, helpers.
- Removed monolith tests: `src/engine/orchestrator/planning.test.ts`, `src/core/runtime/commands/registry.test.ts`.
- `testing/helpers/orchestrator-factories.ts` — `makeWctx` default `context.dir = overrides.projectDir`.

## Fix summary (findings 1–13)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Reject can escape `projectDir`; unchecked baseline `encodedName` | fixed | `hashProjectFileIfConfined` prevents live-file hash reads through symlinked parents; `assertWritablePathConfined` / `assertExistingPathConfined` guard reject write/delete; baseline blob via `resolveValidatedBlobPath`. Symlink-parent + tampered-manifest regressions in `run.test.ts`. |
| 2 | Detached `--mode full` rejects nested override | fixed | `CLIOverridesSchema.mode` legacy preprocess (`overrides.ts:32`); coverage in `spawn-server.test.ts` / `start.test.ts`. |
| 3 | `applyChangedFiles` dropped cleanup/abort/error options | fixed | `apply-changed-files.ts:45-47` passes `signal`, `cleanup`, `catchChangedFilesError`; `apply-changed-files.test.ts`. |
| 4 | Routing preview reads files outside project | fixed | `assertWritablePathConfined(task.file, projectDir)` before read; unsafe path → `current-code-unavailable` (`routing-preview.ts:405,412`). Traversal/absolute/symlink regressions. |
| 5 | Malformed `usage` drops valid result text | fixed | `ResultEvent.usage: z.unknown()` then `toTokenDelta` (`parse-stream-json.ts:34,75`); string-usage regression preserves text + `isResult`. |
| 6 | `snapshot diff` discloses outside files | fixed | Realpath read confinement before hash/diff; file/delta entries via validated resolver (`diff.ts`). Symlink-parent + tampered-manifest regressions in `diff.test.ts`. |
| 7 | Features/components used as shared utility layers | fixed | Shared utils moved to `src/utils/terminal-width.ts`, `src/utils/meter-bar.ts`, `src/core/task-status-glyph.ts`. Resolver-based invariant 9 (`import-boundaries.ts`) blocks components→features and sibling-feature imports. Grep over `src/components`/`src/features` returns none. |
| 8 | Two test files crossed 1k lines | fixed | `planning.test.ts` → 4 files (max 477); `registry.test.ts` → 4 files (max 414); `phases.test.ts` = 906. |
| 9 | `makeWctx` inconsistent context | fixed | `context: { ...defaultContext, dir: overrides.projectDir }` (`orchestrator-factories.ts:34`); regression in `orchestrator-factories.test.ts`. |
| 10 | `runTaskLoop` multi-policy blob | fixed | `loop.ts` 401 → 210 lines; steps extracted to `dependency-gate`, `user-edit-gate`, `routing-selection`, `post-task`, `stop-with-review`, `auto-snapshot`. |
| 11 | Confinement tests missed symlink-parent escapes | fixed | POSIX symlink-parent regressions added for reject, diff, `writeSecureFileAsync`/confined writer, and handoff renderer output. |
| 12 | `writeSecureFileAsync` follows symlinked parents | fixed | Root-aware `writeConfinedSecureFileAsync` with `assertWritablePathConfined` (`fs.ts:109,116`); call sites in `manifest.ts`, `run.ts`, `detection/cache.ts` migrated. Symlink-parent test in `fs.test.ts`. |
| 13 | Plan-review runtime logic in `core/schemas`, text classification | fixed | TS-only contracts moved to `src/core/plan-review/`; classification uses typed `routingBlockKind` / `currentCodeContextMode` / `currentCodeTruncated`. Scorecard has zero `routingReason.includes`. Wording-change regression in `plan-review-scorecard.test.ts`. |

## Test evidence (exact commands + result)

- `npm run typecheck` — PASS (src + test configs, no errors).
- `npm run lint` — PASS (Biome, 1240 files, no findings; fixed one `let`→`const` in `restore.ts:113`).
- `npm run check:invariants` — PASS (all 23 gates, including resolver-based gate 9).
- `npm run test-ci` (format → typecheck → lint → test → invariants) — PASS after final reject-read hardening: 425 test files, 3939 tests passed; all 23 invariant gates passed.

P5.1 manual greps:

- `git status --short` — modified/untracked only, nothing staged (`git diff --cached --name-only` empty).
- routing-reason classification grep — remaining matches are human-readable string construction in `context-routing/helpers.ts` and test assertions on those strings; no behavior-critical classification.
- cross-feature / shared-component import grep over `src/components` `src/features` — none.
- `wc -l` split files + `loop.ts` — every split file < 500 lines; `loop.ts` = 210 (materially below 401).
- `encodedName` grep in `src/engine/snapshots` — all blob reads route through `resolveValidatedBlobPath`; raw joins only in `create.ts` (writing newly-encoded names) and the validated resolver.

## Rejected candidates

- `src/engine/snapshots/restore.ts` symlink-parent write — pre-existing in `HEAD^`; hardened in this patch via the shared validated resolver, not counted as a new regression.
- `src/engine/snapshots/create.ts` records entries when blob capture fails, `lock.ts` ownerless stale locks — pre-existing behavior moved from `HEAD^:store.ts`; out of scope for this remediation.
- `src/engine/streaming/parse-jsonl.ts` strict usage parsing — malformed usage only drops token usage for `turn.completed`; final text is preserved. Not a regression.
- `src/engine/providers/anthropic/stream.ts` CRLF SSE boundary brittleness — predates the audited range.
- `context-routing/helpers.ts` `current code truncated` / `function-level context` strings — these are display strings, not classification inputs; classification is driven by typed fields. Not a finding-13 violation.

## Remaining issues

None. No confirmed medium or high issues remain after remediation. The full gate
(`npm run test-ci`) passes and all 13 findings are fixed.
