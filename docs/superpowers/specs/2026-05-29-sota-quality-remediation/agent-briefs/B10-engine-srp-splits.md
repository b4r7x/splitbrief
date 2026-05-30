# B10 — Engine SRP file splits

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Break up the largest junk-drawer engine modules so each file owns one concern. Split
`snapshots/store.ts` (5 concerns), `orchestrator/planning/shared.ts` (3 concerns),
`streaming/output-parsers.ts` (one file per stream format), `orchestrator/drift/drift.ts`
(analyze/io/format), `orchestrator/recovery/builders/shared.ts` (issue/actions/details),
`mcp/resolver.ts` (manifest extraction + table-driven `readResource`),
`codebase/repomap.ts` (extract `discover-files.ts`), `orchestrator/evidence/review-packet`
(extract `sections-io.ts`/`artifacts.ts`), and `orchestrator/run/phases.ts` (extract
`auto-split-review.ts`); rename `providers/pricing.ts`→`providers/cost.ts` while extracting
`cost-math.ts`. Along the way: dedupe the snapshot Accept/Reject result types from `core`,
derive the checkpoint excluded-paths from `ALWAYS_EXCLUDED`, route the three hand-rolled
`.git/HEAD` reads through `lib/git`, replace `repomap.ts`'s `console.warn` with
`warnError`, eliminate a redundant `stat()` per file in the repo-map walk, route the MCP
brief-hash read through `readJsonSafeAsync`, and flatten the stream-result builder. **Two
intended behavior changes only:** (1) RU-03 — the resolver now records `sourceCommit` on
branch checkouts, not only on detached HEAD; (2) KISS-03 — the flattened `wrapStreamParser`
keeps `isResult`/`usage` whenever the parser produced them (the old cascade dropped them
incidentally). Every other change is a pure structural relocation.

## Wave / ordering

- **Wave:** 6. **Runs after:** B05–B07 and B09 because:
  - **B05** added `writeSecureFileAsync` to `lib/fs.ts` and applied critical confinement
    in `snapshots/run.ts` / secure writes in `snapshots/store.ts` (EH-01, DRY-20). Build
    on those edits — do not revert them.
  - **B06** converted `planning/shared.ts`'s functions to parameter objects (PD-09 etc.).
    Split the file **with B06's current signatures**, do not change them.
  - **B07** changed the `calculateUsageCost` family **signatures inside `providers/pricing.ts`**
    (PD-19). B10 rebases the `pricing.ts`→`cost.ts` split/rename onto whatever B07 left.
  - **B09** ran D8/AR-01: deleted `getProviderPricing` from `pricing.ts` and threaded
    `wctx.modelCache` into `predictCost`, relocated facades, extracted `core/evidence/ledger.ts`,
    and moved `core/layout`. Read the **live** post-B09 files before editing; importer lists
    below may have shifted.
- **Decisions that bind this brief:**
  - **D9** — rename `providers/pricing.ts`→`providers/cost.ts` as part of the SRP split
    (it is all cost math, zero pricing; real pricing lives in `pricing-resolver.ts`). Update
    every importer's `.js` path in the same change so importers churn once.
  - **D3** (context only) — snapshot manifest reads are security-/integrity-critical and
    must keep **throwing** on corruption. Preserve `readManifest`'s `throw`; do not convert
    it to the warn-and-default policy.
  - **D12** (ADOPT-NOT-DELETE) — `hasRetryBudget` and `summarizeUnknownError` still live in
    `recovery/builders/shared.ts`. **B14 deletes them later, not B10.** When you split the
    file, carry these two functions across into the new module; do not delete them.

## File ownership

**Snapshots (split `store.ts` into 5 modules + dedup types + excluded-paths):**
- `src/engine/snapshots/store.ts` — **shared with B05.** B05 owns: `writeSecureFileAsync`
  usage (DRY-20). B10 owns: the 5-way SRP split + `createSnapshot` per-file dedup (DRY-45).
  Build on B05's secure-write edits.
- **Create:** `src/engine/snapshots/path-codec.ts`, `src/engine/snapshots/manifest.ts`,
  `src/engine/snapshots/lock.ts`, `src/engine/snapshots/files.ts`,
  `src/engine/snapshots/create.ts`.
- `src/engine/snapshots/run.ts` — **shared with B05.** B05 owns: critical confinement
  (EH-01). B10 owns: import `AcceptRunSnapshotResult`/`RejectRunSnapshotResult` from
  `core/runtime/commands/types.ts`; delete the local duplicate type definitions (DRY-21).
- `src/engine/snapshots/checkpoint-summary.ts` — derive `CHECKPOINT_RESTORE_SAFETY.excludedPaths`
  / `text.excludedPaths` from `ALWAYS_EXCLUDED` (DRY-46).
- Update importers of `store.ts` symbols (see step 1.7) and `run.ts` (no symbol renames).

**Planning (split `shared.ts` into 3):**
- `src/engine/orchestrator/planning/shared.ts` — **shared with B06.** B06 owns: the param
  objects on the functions. B10 owns: the 3-way SRP split (SRP-02). Build on B06's signatures.
- **Create:** `src/engine/orchestrator/planning/planner-call-loop.ts`,
  `src/engine/orchestrator/planning/briefs-approval-loop.ts`,
  `src/engine/orchestrator/planning/planning-io.ts`.

**Streaming (one file per format + flatten builder):**
- `src/engine/streaming/output-parsers.ts` — keep only the dispatcher (`getLineParser`)
  + `wrapStreamParser` (flattened per KISS-03); re-home each format parser+schemas.
- **Create:** `src/engine/streaming/parse-stream-json.ts`,
  `src/engine/streaming/parse-jsonl.ts`, `src/engine/streaming/parse-text.ts`,
  `src/engine/streaming/parse-opencode.ts`.

**Drift (analyze/io/format):**
- `src/engine/orchestrator/drift/drift.ts` — keep as the analyze module (or re-home — see
  step 4); split IO + format out.
- **Create:** `src/engine/orchestrator/drift/io.ts`,
  `src/engine/orchestrator/drift/format.ts`. (Keep file named `drift.ts` for `analyzeBriefDrift`.)

**Recovery builders (issue/actions/details):**
- `src/engine/orchestrator/recovery/builders/shared.ts` — **shared with B04 → B10 → B14.**
  B04 already moved `formatPercent`/`formatCostFact`/`budgetPercentOf` to `core/formatting.ts`
  (RU-01/DRY-09) — they are **gone** from this file; do not re-add. B14 will later delete
  `hasRetryBudget`/`summarizeUnknownError` — **keep them** (D12). B10 owns: split the
  remainder into the 3 modules below (SRP-07).
- **Create:** `src/engine/orchestrator/recovery/builders/recovery-issue.ts`,
  `src/engine/orchestrator/recovery/builders/recovery-actions.ts`,
  `src/engine/orchestrator/recovery/builders/recovery-details.ts`.

**MCP resolver (manifest + table-drive + git HEAD + JSON read):**
- `src/engine/mcp/resolver.ts` — extract manifest, table-drive `readResource` (SRP-12);
  route `.git/HEAD` via `lib/git` (RU-03); use `readJsonSafeAsync` for brief-hash (DRY-63).
- **Create:** `src/engine/mcp/manifest.ts`.

**Codebase repo-map (discover-files + stat perf + warn):**
- `src/engine/codebase/repomap.ts` — extract the glob/walk subsystem (SRP-14); replace
  `console.warn` with `warnError` (EH-17); remove the redundant gate-`stat()` per file by
  threading the cache's `FileStat` (PF-02).
- **Create:** `src/engine/codebase/discover-files.ts`.
- `src/engine/codebase/cache.ts` — thread the already-computed `FileStat` to the parse fn (PF-02).
- `src/engine/codebase/parse.ts` — `parseFile` accepts an optional pre-computed `FileStat` (PF-02).

**Evidence review-packet (sections-io / artifacts):**
- `src/engine/orchestrator/evidence/review-packet/sections.ts` — extract the fs/git IO
  helpers (SRP-08).
- `src/engine/orchestrator/evidence/review-packet/build.ts` — extract artifact
  deserialization (SRP-08).
- **Create:** `src/engine/orchestrator/evidence/review-packet/sections-io.ts`,
  `src/engine/orchestrator/evidence/review-packet/artifacts.ts`.

**Run phases (auto-split-review):**
- `src/engine/orchestrator/run/phases.ts` — extract the auto-split-overflow review/approval
  sub-flow (SRP-09).
- **Create:** `src/engine/orchestrator/run/auto-split-review.ts`.

**Pricing rename + cost-math extraction (D9):**
- `src/engine/providers/pricing.ts` — **rename to** `src/engine/providers/cost.ts`;
  extract the primitive math into `cost-math.ts` (SRP-11/NM-03/D9). **Shared with B02 → B07
  → B10** — build on B02's cast fixes and B07's signatures.
- **Create:** `src/engine/providers/cost-math.ts`.
- **Delete:** `src/engine/providers/pricing.ts` (renamed away).
- Update every importer's `.js` path (see step 9.4).

**Estimate-review parser:**
- `src/engine/orchestrator/planner-estimate-review.ts` — extract the LLM-response parser
  (SRP-15).
- **Create:** `src/engine/orchestrator/estimate-review-parser.ts`.

**Shared lib touched (additive only):**
- `src/lib/git.ts` — **shared with B05** (B05 added `runGit`/`discardChangedFiles`). B10
  owns: **add** `getCurrentBranch(dir)` for RU-03. Do not change B05's functions.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| SRP-01 | high | `engine/snapshots/store.ts:33-362` | Split 5 concerns into `path-codec`/`manifest`/`lock`/`files`/`create`.ts. |
| SRP-02 | high | `engine/orchestrator/planning/shared.ts:39-295` | Split into `planner-call-loop`/`briefs-approval-loop`/`planning-io`.ts. |
| SRP-06 | high | `engine/streaming/output-parsers.ts:1-227` | One file per format; keep the dispatcher in `output-parsers.ts`. |
| SRP-07 | med | `engine/orchestrator/recovery/builders/shared.ts:19-225` | Split into `recovery-issue`/`recovery-actions`/`recovery-details`.ts. |
| SRP-08 | med | `evidence/review-packet/{sections,build}.ts` | Extract `sections-io.ts` (fs/git IO) and `artifacts.ts` (deserialization). |
| SRP-09 | med | `engine/orchestrator/run/phases.ts:115-250` | Extract `auto-split-review.ts`. |
| SRP-10 | med | `engine/orchestrator/drift/drift.ts:27-195` | Split into `drift/{drift(analyze),io,format}.ts`. |
| SRP-11 | med | `engine/providers/pricing.ts:1-394` | Extract `cost-math.ts`; rename file→`cost.ts` (= NM-03, D9). |
| SRP-12 | med | `engine/mcp/resolver.ts:1-332` | Extract `manifest.ts`; table-drive `readResource`. |
| SRP-14 | med | `engine/codebase/repomap.ts:104-225` | Extract `discover-files.ts` (= PF-02). |
| SRP-15 | med | `engine/orchestrator/planner-estimate-review.ts:152-204` | Extract `estimate-review-parser.ts`. |
| EH-17 | low | `engine/codebase/repomap.ts:70` | `warnError('repo-map unavailable', err)` instead of `console.warn`. |
| DRY-21 | high | `engine/snapshots/run.ts:21-41` ↔ `runtime/commands/types.ts:10-25` | Import Accept/Reject result types from `core/runtime/commands/types.ts`; delete the local duplicates. |
| DRY-45 | med | `engine/snapshots/store.ts:235-318` | Extract `captureFile`/`buildManifest` to dedupe the baseline/incremental loops in `createSnapshot`. |
| DRY-46 | med | `engine/snapshots/checkpoint-summary.ts:51` | Derive `excludedPaths` from `ALWAYS_EXCLUDED`. |
| DRY-63 | low | `engine/mcp/resolver.ts:76-89` | Use `readJsonSafeAsync` for the brief-hash read. |
| RU-03 | high | `mcp/resolver.ts:91-98` + `handoff/write.ts:223` + `worktree.ts:103` | Route `.git/HEAD` via `lib/git` `getCurrentCommitSha`/`getCurrentBranch` (resolver bug: records `sourceCommit` on branch checkouts). |
| KISS-03 | med | `streaming/output-parsers.ts:170-177` | Build one result object and return it (flatten `wrapStreamParser`). |
| NM-03 | med | `engine/providers/pricing.ts:1-394` | Rename file→`cost.ts` (= SRP-11, D9). |
| PF-02 | low | `engine/codebase/parse.ts:149` | Pass the cache's `FileStat` into `parseFile`; remove redundant gate `stat()` (= SRP-14). |

## Required changes

> Throughout: ESM `.js` extensions on every import; no decorative comments / section banners;
> no new `!`, broad `as`, `any`, classes, memoization, or barrels (`index.ts`). Run the
> targeted tests + `npm run typecheck` + `npm run lint` after each group.

### 1. Split `snapshots/store.ts` into 5 modules (SRP-01, DRY-45)

Current `store.ts` exports (all consumed by tests and siblings — keep them all importable):
`encodeSnapshotPath`, `decodeSnapshotPath`, `generateSnapshotId`, `writeManifest`,
`readManifest`, `listSnapshotIds`, `hashFile`, `collectTrackedFiles`, `acquireSnapshotLock`,
`hasBaseline`, `createSnapshot`, `listSnapshots`, plus types `CreateSnapshotOptions`,
`CreateSnapshotResult`, `ListSnapshotsResult`. Also private: `readdirRecursive`,
`ALWAYS_EXCLUDED`, `STALE_LOCK_MS`.

1.1 **`path-codec.ts`** — move `encodeSnapshotPath`, `decodeSnapshotPath`,
`generateSnapshotId` (pure, no imports beyond `node:buffer` semantics — none needed).

1.2 **`manifest.ts`** — move `writeManifest`, `readManifest`, `listSnapshotIds`,
`hasBaseline`, `listSnapshots`, and the `ListSnapshotsResult` type. Keep `readManifest`
**throwing** `snapshot-manifest-not-found` and Zod-parsing (D3 — integrity-critical, do not
soften). Imports needed here: `node:fs/promises` (`readdir`, `readFile`, `rename`, `stat`,
`writeFile`), `node:path` (`join`), the snapshot path helpers from `core/paths.js`,
`SnapshotManifest`/`SnapshotManifestSchema` from `core/schemas/snapshot.js`,
`ensureSecureDir`/`SECURE_FILE_MODE` from `lib/fs.js`, `error` from `utils/error.js`,
`SNAPSHOT_MANIFEST_FILE` + `SNAPSHOT_BASELINE_ID`.

1.3 **`lock.ts`** — move `acquireSnapshotLock` + `STALE_LOCK_MS`. Imports:
`node:fs` (`openSync`, `closeSync`, `unlinkSync`, `statSync`), the lock/snapshots path
helpers, `ensureSecureDir`, `isNodeError` from `lib/process/errors.js`, `error`.

1.4 **`files.ts`** — move `hashFile`, `collectTrackedFiles`, the private `readdirRecursive`,
and `ALWAYS_EXCLUDED`. **Export `ALWAYS_EXCLUDED`** (needed by `checkpoint-summary.ts` for
DRY-46). Imports: `node:crypto` (`createHash`), `node:fs` (`createReadStream`, type `Dirent`),
`node:fs/promises` (`readdir`), `node:path` (`join`, `relative`), `checkIgnoredPaths` from
`lib/git.js`, `TREES_DIR` from `core/paths.js`.

1.5 **`create.ts`** — move `createSnapshot`, `CreateSnapshotOptions`, `CreateSnapshotResult`.
Import `acquireSnapshotLock` from `./lock.js`, `collectTrackedFiles`/`hashFile`/
`encodeSnapshotPath` from `./files.js` + `./path-codec.js`, `writeManifest`/`readManifest`/
`hasBaseline` from `./manifest.js`. Also the `node:fs/promises` (`mkdir`, `readFile`,
`writeFile`), `node:path` (`join`), path helpers (`baselineDir`, `snapshotDir`,
`snapshotFilesDir`, `SNAPSHOT_BASELINE_ID`), schema types, `SECURE_FILE_MODE`, `EventBus`,
`Phase`.

  **DRY-45 dedup:** the baseline branch (lines 228-269) and incremental branch (270-319) both
  iterate `trackedPaths`, hash each file, conditionally write its blob, and push a
  `SnapshotFileEntry`. Extract:
  ```ts
  async function captureFile(opts: {
    projectDir: string; path: string; filesDir: string; force: boolean;
    baselineHash?: string | undefined;
  }): Promise<{ hash: string; entry?: SnapshotFileEntry }>;
  ```
  where `force` is true for the baseline (always capture) and false for incremental (capture
  only when `hash !== (baselineHash ?? '')`). Return `{ hash }` always, plus `entry` when the
  blob was captured. Then extract a `buildManifest(...)` helper that assembles the
  `SnapshotManifest` object (the two identical literals at 251-262 and 300-311 differ only in
  `id` and the entries source). Keep `createSnapshot`'s lock acquire/release, baseline-vs-
  incremental decision, `writeManifest` call, and the post-release `snapshot_created` publish
  exactly as they are. **Do not** rename `captureFile`/`buildManifest` to collide with
  `manifest.ts`'s `writeManifest`/`readManifest`.

1.6 **`store.ts` after the split:** delete it **or** keep it as a thin module only if it
still holds real logic. Since every symbol moves out, **delete `store.ts`** and update all
importers (do NOT leave a re-export-only `store.ts` — that is a barrel by intent).

1.7 **Update `store.ts` importers** (verify with
`grep -rn "snapshots/store" src --include='*.ts'`):
  - `src/cli/commands/snapshot.ts:4` — `createSnapshot` from `./create.js`, `listSnapshots`
    from `./manifest.js` (adjust relative path: `../../engine/snapshots/...`).
  - `src/engine/orchestrator/final-review.ts:29` — `createSnapshot` from `../snapshots/create.js`.
  - `src/engine/orchestrator/task/loop.ts:16` — `createSnapshot` from `../../snapshots/create.js`.
  - `src/engine/snapshots/diff.ts:13` — imports several names from `./store.js`; repoint to
    the new files (it uses `hashFile` → `./files.js`, `readManifest`/`listSnapshotIds` →
    `./manifest.js`, `encodeSnapshotPath`/`decodeSnapshotPath` → `./path-codec.js`,
    `snapshotFilesDir` is from paths). Read `diff.ts:1-20` to confirm the exact set.
  - `src/engine/snapshots/run.ts` — imports `createSnapshot`/`hashFile`/`readManifest`
    (lines 12-16). Repoint: `createSnapshot`→`./create.js`, `hashFile`→`./files.js`,
    `readManifest`→`./manifest.js`.
  - `src/engine/snapshots/checkpoint-summary.ts:4` — `listSnapshots`→`./manifest.js`.
  - **Tests** (update import lists): `src/engine/snapshots/store.test.ts` (imports the full
    set from `./store.js` — lines 10-23: split across `./path-codec.js`, `./manifest.js`,
    `./lock.js`, `./files.js`, `./create.js`), `src/engine/snapshots/diff.test.ts:5`,
    `src/engine/snapshots/restore.test.ts:8` (both import `createSnapshot` → `./create.js`).
    Do not change any test assertions — only the import paths.

### 2. Dedup snapshot Accept/Reject result types (DRY-21)

2.1 In `src/engine/snapshots/run.ts`, delete the local `AcceptRunSnapshotResult` (lines
21-24) and `RejectRunSnapshotResult` (lines 26-41).

2.2 Add `import type { AcceptRunSnapshotResult, RejectRunSnapshotResult } from
'../../core/runtime/commands/types.js';`. These are **byte-identical** to the local ones
(verified against `core/runtime/commands/types.ts:10-25`), so `acceptRunSnapshot`/
`rejectRunSnapshot` return types are unchanged. (engine→core is an allowed direction;
`core/runtime/commands/types.ts` imports only from `core/`, so no cycle.)

2.3 Leave `command-context-factory.ts` and `final-review.ts`/`loop.ts` importers untouched —
they already consume the function return types, which are now sourced from core.

### 3. Checkpoint excluded-paths from `ALWAYS_EXCLUDED` (DRY-46)

In `src/engine/snapshots/checkpoint-summary.ts`, the `CHECKPOINT_RESTORE_SAFETY.excludedPaths`
literal (`['.git/', '.diptych/', 'node_modules/', '.trees/']`, line 51) and the matching
`text.excludedPaths` sentence (line 57) duplicate `ALWAYS_EXCLUDED` (`['.git', '.diptych',
'node_modules', TREES_DIR]`, now exported from `snapshots/files.js`). Import `ALWAYS_EXCLUDED`
from `./files.js` and derive:
```ts
const EXCLUDED_DISPLAY_PATHS = ALWAYS_EXCLUDED.map((p) => `${p}/`);
```
Use `EXCLUDED_DISPLAY_PATHS` for `excludedPaths`, and build the `text.excludedPaths` string
from the same array (e.g. `Snapshots exclude ${EXCLUDED_DISPLAY_PATHS.join(', ')}.`).
Keep the `as const satisfies CheckpointRestoreSafety` shape valid — note `excludedPaths` is
typed `readonly string[]`, so the derived array satisfies it; if `satisfies` complains about
the `text` literal, keep `text.excludedPaths` as a normal string built from the array (it
does not need to be a literal type). Verify `checkpoint-summary.test.ts` still passes;
if it asserts the exact strings, the derived output must match the previous strings exactly
(`.git/, .diptych/, node_modules/, .trees/`).

### 4. Split `orchestrator/drift/drift.ts` (SRP-10)

Current exports: `AnalyzeBriefDriftInput` (type), `analyzeBriefDrift`, `driftReportPath`,
`writeDriftReport`, `readDriftReport`, `formatDriftReportForPrompt`, `publishDriftReport`.
Importers: `summary.ts:22` (`readDriftReport`), `final-review.ts:22` (`analyzeBriefDrift`,
`formatDriftReportForPrompt`, `publishDriftReport`, `writeDriftReport`),
`evidence/review-packet/build.ts:22` (`readDriftReport`).

4.1 Keep `drift.ts` as the **analyze** module: `analyzeBriefDrift`, `AnalyzeBriefDriftInput`,
and the private `isFailedOrSkipped`/`isCompleted`. (Note: RU-07 owned by B04 may already have
introduced `isTaskCompleted` in `core/schemas/task.js` and adopted it here — if so, keep
B04's adoption; do not re-inline.)

4.2 **`drift/io.ts`** — move `driftReportPath`, `writeDriftReport`, `readDriftReport`.
Imports: `node:path` (`join`), `DRIFT_REPORT_FILE`/`sessionDir` from `core/paths.js`,
`readJsonSafe`/`writeSecureFile` from `lib/fs.js`, `isDriftReport`/`DriftReport` from
`core/schemas/drift.js`.

4.3 **`drift/format.ts`** — move `formatDriftReportForPrompt`, `publishDriftReport`.
Imports: `countBySeverity` from `utils/collections.js`, `EngineEvent`/`EventBus`/`Phase`,
`DriftReport`.

4.4 Update the 3 importers' `.js` paths: `readDriftReport`/`writeDriftReport`/`driftReportPath`
→ `../drift/io.js` (or `./drift/io.js` from `summary.ts`/`final-review.ts`;
`../../drift/io.js` from `build.ts`); `formatDriftReportForPrompt`/`publishDriftReport` →
`./drift/format.js`; `analyzeBriefDrift` stays at `./drift/drift.js`. Check
`drift.test.ts` imports and repoint.

### 5. Split `orchestrator/planning/shared.ts` (SRP-02)

Current exported functions (with B06's param-object signatures — read the **live** file
first): `drainAndFormat`, `persistPhases`, `handlePlanningFailure`, `runBriefQualityGate`,
`runPlannerCallInContinuationLoop`, `runBriefsApprovalLoop`, plus const
`MAX_CLARIFICATION_QUESTIONS`. Private helpers: `readPersistedTasks`, `readTasksForApproval`,
`publishBriefQualityFailure`, type `PersistedTasksResult`.

5.1 **`planning-io.ts`** — move the task-file IO concern: `persistPhases`,
`readPersistedTasks`, `readTasksForApproval`, `PersistedTasksResult`. Imports:
`node:fs/promises` (`readFile`), `writeSpecFile`/`SpecMetadata` from `core/paths-io.js`,
`TASKS_FILE` from `core/paths.js`, `formatTasks` from `spec/formatter.js`, `parseTasks` from
`spec/parser.js`, `labelError` from `utils/format-errors.js`, `isENOENT` from
`lib/process/errors.js`, `Task`.

5.2 **`planner-call-loop.ts`** — move `runPlannerCallInContinuationLoop` and
`MAX_CLARIFICATION_QUESTIONS` (the loop's clarification cap is used here). Imports per the
live `shared.ts` head (`createBusTextHandler`, `withContinuationLoop`, `transitionAndSave`,
`createSessionExpiredHandler`, `startPlannerHeartbeat`, `readEvidenceLedger`,
`buildRejectionContext`, the `PlannerCall*` types, etc.).

5.3 **`briefs-approval-loop.ts`** — move `runBriefsApprovalLoop`, `runBriefQualityGate`,
`handlePlanningFailure`, `drainAndFormat`, `publishBriefQualityFailure`. These form the
briefs-approval concern (quality gate + drain + approval loop). Import `regenerateTasks` from
`./regen.js`, `readPersistedTasks`/`readTasksForApproval`/`persistPhases` from `./planning-io.js`,
`MAX_CLARIFICATION_QUESTIONS` from `./planner-call-loop.js` (if `runBriefsApprovalLoop`
references it — it does not currently; only the planner-call loop does, so it stays in
planner-call-loop). Keep `evaluateBriefQuality`, `BRIEF_QUALITY_FILE`, `countBySeverity`,
`drainQueue`/`formatDrainedMessages`, `publishError`, `nowIso`, `randomUUID`, `sessionDir`,
`formatTasks` imports as needed.

  Note `MAX_CLARIFICATION_QUESTIONS` is currently referenced only inside
  `runPlannerCallInContinuationLoop`. Keep its **single** definition in `planner-call-loop.ts`
  and export it; if any other module imports it from `planning/shared.js`, repoint (grep
  `MAX_CLARIFICATION_QUESTIONS`).

5.4 **Delete `shared.ts`** (all symbols moved) and update importers. Find them:
`grep -rn "planning/shared" src --include='*.ts'`. Repoint each named import to its new home
(`./planning-io.js`, `./planner-call-loop.js`, or `./briefs-approval-loop.js`). Update
`planning/shared.test.ts` if present (`ls src/engine/orchestrator/planning/`). Do **not**
leave a re-export-only `shared.ts`.

  If splitting `shared.ts` cleanly is blocked by a tight import cycle between the three new
  files, prefer keeping `briefs-approval-loop.ts` importing from `planning-io.ts` and
  `planner-call-loop.ts` (one-directional). Do not introduce a back-edge.

### 6. Split `streaming/output-parsers.ts` (SRP-06, KISS-03)

6.1 **`parse-stream-json.ts`** — move `parseStreamLine`, `StreamParseResult`, `EMPTY_RESULT`,
and the `TextBlock`/`ToolUseBlock`/`AssistantEvent`/`ResultEvent`/`SessionEvent` schemas.
Imports: `zod`, `ToolUseInfo`/`ParsedLine` from `runners/types.js` (only `ToolUseInfo` here),
`TokenDelta`, `toTokenDelta` from `./token-utils.js`, `warnError`.

6.2 **`parse-jsonl.ts`** — move `parseJsonlLine` + `JsonlTextBlock`/`ItemCompletedEvent`/
`TurnCompletedEvent`/`ThreadStartedEvent`. Imports: `zod`, `ParsedLine`, `toTokenDelta`,
`narrowRecord` from `utils/type-guards.js`, `warnError`.

6.3 **`parse-text.ts`** — move `parseTextLine`. Imports: `ParsedLine`.

6.4 **`parse-opencode.ts`** — move `parseOpencodeLine` + `OpencodeTextEvent`/
`OpencodeStepFinishEvent`. Imports: `zod`, `ParsedLine`, `warnError`.

6.5 **`output-parsers.ts` keeps the dispatcher only:** `getLineParser` + `wrapStreamParser`.
Import each parser from its new file. **KISS-03 — flatten `wrapStreamParser`** (currently 5
branches each constructing a partial object, lines 170-177). Build one object and return it,
omitting `undefined` keys via conditional spreads:
```ts
function wrapStreamParser(line: string): ParsedLine {
  const r = parseStreamLine(line);
  return {
    ...(r.text !== undefined ? { text: r.text } : {}),
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
    ...(r.isResult !== undefined ? { isResult: r.isResult } : {}),
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.toolUse !== undefined ? { toolUse: r.toolUse } : {}),
  };
}
```
Confirm the `ParsedLine` shape in `runners/types.js` accepts these optional keys (it does —
`parseTextLine` returns `{ text }`/`{ usage }` etc.).

  **This is a behavioral *superset*, not byte-equal to the old cascade — and that is the
  intended KISS-03 simplification.** The old cascade (lines 170-177) returns on the first
  truthy branch, so it **incidentally drops** later fields. Concrete case: a `result` event
  with no `result` text and no `usage` but a `session_id` → `parseStreamLine` returns
  `{ isResult: true, sessionId }`; the old code falls through to `if (result.sessionId) return
  { sessionId }`, dropping `isResult`. The flattened version keeps `isResult`. Keeping every
  field that `parseStreamLine` actually produced is the correct behavior; the drop was an
  accident of the cascade ordering. **Do not** claim "no behavior change" for this step.
  Run `output-parsers.stream.test.ts` and `format-messages.test.ts`; if any assertion relied
  on the incidental drop (e.g. asserts an object that omits `isResult`/`usage` where the
  flattened result now includes it), **update that assertion** to expect the field — do not
  re-introduce the cascade to satisfy a stale test. The conditional spreads still omit keys
  whose value is `undefined`, so genuinely-absent fields stay absent.

6.6 **Update importers to import directly from the new files** (NO-BARRELS — prefer direct
imports over re-exporting through `output-parsers.ts`):
  - `src/engine/cli-tools.ts:2` — `parseJsonlLine`→`./streaming/parse-jsonl.js`,
    `parseOpencodeLine`→`./streaming/parse-opencode.js`, `parseTextLine`→`./streaming/parse-text.js`.
  - `src/engine/claude-invoke.ts:7` — `parseStreamLine`→`./streaming/parse-stream-json.js`.
  - `src/engine/streaming/spawn-collect.ts:5` — `getLineParser` stays at `./output-parsers.js`.
  - `src/engine/implementers/cli.ts:6` — `parseTextLine`→`../streaming/parse-text.js`.
  - **Tests:** `output-parsers.test.ts:2` (`parseTextLine`/`parseJsonlLine`/`parseOpencodeLine`
    → their new files), `output-parsers.stream.test.ts:2` (`getLineParser` from
    `./output-parsers.js`, `parseStreamLine` from `./parse-stream-json.js`). Adjust import
    paths only.

### 7. Split `recovery/builders/shared.ts` (SRP-07)

By the time you run, B04 has removed `formatPercent`/`formatCostFact`/`budgetPercentOf`
(moved to `core/formatting.js`) and repointed `workflow.ts`. **Read the live `shared.ts`
first.** The remaining symbols to redistribute (issue-building / action-selection /
detail-formatting):

7.1 **`recovery-issue.ts`** — `RecoveryBuilderBase`, `TaskRecoveryContext`,
`MAX_SUMMARY_LENGTH`, `buildRecoveryIssueId`, `createRecoveryIssue`, `summarizeText`,
`compactFacts`. Imports: enums (`Phase`/`RecoveryAction`/`RecoveryReason`),
`RecoveryFact`/`RecoveryIssue`, `Task`/`TaskId`, `uniqueIds`/`uniqueSorted`.

7.2 **`recovery-actions.ts`** — `ACTION_ORDER`, `orderedActions`, `chooseRecommended`,
`chooseUserEditRecommendation`, `mapUserEditAction`, `hasRetryBudget` (**keep — D12**),
`hasRouteBigger`. Imports: `RecoveryAction`, `UserEditConflict`/`UserEditConflictAction`.

7.3 **`recovery-details.ts`** — `summarizeValidation`, `summarizeUnknownError`
(**keep — D12**), `attemptDetails`, `implementerDetails`, `routeBiggerDetails`, `taskFiles`,
`fileConflictDetails`. These need `summarizeText` (import from `./recovery-issue.js`),
`ValidationResult`, `UserEditConflict`, `Task`, `uniqueSorted`, `looksLikeFilePath`.

  `createRecoveryIssue` (in `recovery-issue.ts`) calls `summarizeText` (same file — fine).
  `recovery-details.ts` imports `summarizeText` from `recovery-issue.ts`. No cycle.

7.4 **Delete `shared.ts`** and update the two importers:
  - `src/engine/orchestrator/recovery/builders/task.ts` (imports `RecoveryBuilderBase`,
    `TaskRecoveryContext` + `attemptDetails`, `chooseRecommended`, `compactFacts`,
    `createRecoveryIssue`, `hasRouteBigger`, `implementerDetails`, `orderedActions`,
    `routeBiggerDetails`, `summarizeValidation`, `taskFiles`) — split across the 3 new files.
  - `src/engine/orchestrator/recovery/builders/workflow.ts` (imports `RecoveryBuilderBase`
    + `chooseRecommended`, `chooseUserEditRecommendation`, `compactFacts`, `createRecoveryIssue`,
    `fileConflictDetails`, `mapUserEditAction`, `orderedActions`, `taskFiles` — note: after
    B04 it no longer imports `budgetPercentOf`/`formatCostFact`/`formatPercent` from here).
  - Check `grep -rn "builders/shared" src --include='*.ts'` for any test importer.

### 8. Split `mcp/resolver.ts` (SRP-12, RU-03, DRY-63)

8.1 **`mcp/manifest.ts`** — move `buildManifest`, `hasCanonicalManifestArtifacts`,
`readBriefHash`, and the `readGitHead` logic. The module needs `projectDir`/`sessionId`/
`diptychVersion`. Imports: `node:fs` (`existsSync`), `node:path` (`join`),
`readJsonSafeAsync`/`readFileSafeAsync` from `lib/fs.js`, the path consts + `sessionDir`,
`SessionSchema`, `WorkflowStateSchema`, `hashTaskBrief` from `../brief-hash.js`,
`isRecord` from `utils/type-guards.js`.

  **DRY-63** — replace `readBriefHash`'s manual `readFileSafeAsync` + `JSON.parse` + try/catch
  (lines 76-89) with `readJsonSafeAsync`:
  ```ts
  async function readBriefHash(projectDir: string, sessionId: string): Promise<string | null> {
    const parsed = await readJsonSafeAsync(join(sessionDir(projectDir, sessionId), 'brief-hash.json'));
    return isRecord(parsed) && typeof parsed.hash === 'string' ? parsed.hash : null;
  }
  ```

  **RU-03** — delete `readGitHead` (lines 91-98, the 40-hex-only variant that silently drops
  `sourceCommit` on a branch checkout). Replace `const sourceCommit = await readGitHead(projectDir)`
  (line 137) with:
  ```ts
  let sourceCommit: string | null = null;
  try { sourceCommit = await getCurrentCommitSha(projectDir); } catch { sourceCommit = null; }
  ```
  Import `getCurrentCommitSha` from `../../lib/git.js`. (`getCurrentCommitSha` runs
  `git rev-parse HEAD`, returning the commit on both detached HEAD and branch checkouts —
  this is the intended bugfix. The `...(sourceCommit !== null ? { sourceCommit } : {})`
  spread at line 148 already handles null.) **Behavior change (intended):** manifests now
  carry `sourceCommit` whenever the repo has any commit, not only when HEAD is detached.

8.2 **`resolver.ts` keeps URI routing + `createResolver`.** Import `buildManifest` from
`./manifest.js`. Keep `createResolver`/`listResources`/`readResource`, the URI helpers
(`sessionsUri`/`sessionBase`/`BASE`), `parseTasksSafe`, `extractTaskBlock`/`extractIdFromBlock`.
Move `hasCanonicalManifestArtifacts` to `manifest.ts` and import it back for `listResources`.

  **SRP-12 — table-drive `readResource`.** The static single-file branches (lines 260-322:
  `spec.md`, `plan.md`, `evidence.json`, `drift-report.json`, `state.json`, `summary.json`)
  all do the same thing: read a file in `sDir`, return `{ uri, mimeType, text }` or `null`.
  Replace them with a lookup table mapping the resource name → `{ file, mimeType }`:
  ```ts
  const STATIC_RESOURCES: Record<string, { file: string; mimeType: string }> = {
    'spec.md': { file: SPEC_FILE, mimeType: 'text/markdown' },
    'plan.md': { file: PLAN_FILE, mimeType: 'text/markdown' },
    'evidence.json': { file: EVIDENCE_FILE, mimeType: 'application/json' },
    'drift-report.json': { file: DRIFT_REPORT_FILE, mimeType: 'application/json' },
    'state.json': { file: STATE_FILE, mimeType: 'application/json' },
    'summary.json': { file: SUMMARY_FILE, mimeType: 'application/json' },
  };
  ```
  After the `manifest.json` branch and before/after the `tasks` branches, look up `resource`
  in `STATIC_RESOURCES`; if present, `readFileSafeAsync(join(sDir, entry.file))` and return
  (or `null`). Keep the special branches that are NOT plain file reads: `sessionsUri()`,
  `manifest.json` (calls `buildManifest`), `tasks` (returns `[]` text / maps tasks), and
  `tasks/<id>` (extracts a block). Preserve the outer `try/catch` with
  `warnError('MCP readResource(...)', err)`. Confirm `resolver.test.ts` / `mcp` tests still
  pass; the observable outputs are unchanged.

### 9. Rename `providers/pricing.ts`→`providers/cost.ts` + extract `cost-math.ts` (SRP-11, NM-03, D9)

> **Read the live file first.** B07 changed the `calculateUsageCost` family signatures
> (PD-19) and B09 deleted `getProviderPricing` (D8). The line numbers below reflect the
> pre-B07/B09 file; the **functions** are what matter.

9.1 **`cost-math.ts`** — move the primitive math + token-allocation heuristics that have no
breakdown-assembly concern: `calculateCost`, `calculateUsageCost`, `splitTokens`,
`allocatedCacheTokens`, `calculateCacheReadSavings`, `recordProviderCost`, `recordPricedUsage`,
`resolveTaskPricingModel`, and the small types `ProviderCostEntry`/`TokenSplit`. Imports:
`ResolvedPricing` from `./pricing-resolver.js`, `resolveAutoModel` from
`core/providers/model-selection.js`. (These are the leaf math helpers consumed by the
breakdown assembler.)

9.2 **`cost.ts`** (the renamed file) — keep the breakdown/aggregation assembler:
`calculateCostBreakdown`, `calculateTaskUsageCost`, `isTaskUsageCostKnown`,
`calculateAggregateImplementerCost`, `calculateTaskAwareImplementerCost`,
`applyImplementerUsageCost`, the `ImplementerCostAccounting`/`CostBreakdownOptions`/
`TaskCostTokenUsage`/`CalculateTaskUsageCostOptions` types, plus whatever of the
`getProviderPricing`/`calculateCost` surface B07/B09 left. Import the leaf helpers from
`./cost-math.js`. **If B09 already deleted `getProviderPricing`, do not reintroduce it.**

9.3 **Delete `providers/pricing.ts`** (it becomes `cost.ts`). Do this as a content move +
new file `cost.ts` + delete `pricing.ts`, so the rename is one churn.

9.4 **Update every importer's `.js` path** from `providers/pricing.js`→`providers/cost.js`.
Find them with `grep -rn "providers/pricing" src --include='*.ts' | grep -v pricing-resolver`.
Current live importers (verify — B07/B09 may have changed the set):
  - `src/features/workflow/hooks/use-cost-stats.ts` (`calculateCostBreakdown`)
  - `src/engine/orchestrator/summary.ts` (`calculateCostBreakdown`, `calculateTaskUsageCost`)
  - `src/engine/orchestrator/budget/estimate.ts` (`calculateCost`)
  - `src/engine/orchestrator/budget/budget.ts` (`calculateCostBreakdown`)
  - `src/engine/orchestrator/budget/cost-prediction.ts` — **B09 territory.** It imported
    `getProviderPricing, calculateCost`. If B09 removed `getProviderPricing`, only
    `calculateCost` remains (now from `./cost-math.js` or `../../providers/cost.js`). Repoint
    whatever is present; do not change cost-prediction's logic (D8 is B09's).
  - Tests: `src/engine/orchestrator/summary.test.ts`. Repoint its `providers/pricing.js`
    import to `providers/cost.js`. **Do not** rename the test file.
  - `calculateCost` is imported by both `estimate.ts` and `cost.ts`/`cost-math.ts`. Decide
    ONE home for `calculateCost`: put it in `cost-math.ts` and have `cost.ts` re-import it;
    update `estimate.ts` to import `calculateCost` from `../../providers/cost-math.js`.

### 10. Extract `discover-files.ts` + stat perf + warn (SRP-14, PF-02, EH-17)

10.1 **`codebase/discover-files.ts`** — move the entire glob/walk subsystem from `repomap.ts`:
`DiscoverOptions`, `IncludeMatcher`, `discoverFiles`, and all the private helpers
`normalizePathPattern`, `normalizeRelativePath`, `escapeRegExp`, `extractSimpleExtensionPattern`,
`extractGlobExtension`, `globToRegExp`, `createIncludeMatcher`, `buildExcludeDirNames`,
`buildFileExcludePatterns`, plus `DEFAULT_EXCLUDE_DIR_NAMES` and `DEFAULT_EXCLUDE_FILE_PATTERNS`.
Export `discoverFiles` + `DiscoverOptions`. Imports: `node:fs/promises` (`readdir`),
`node:path` (`extname`, `isAbsolute`, `join`, `relative`, `resolve`),
`ALL_KNOWN_EXTENSIONS` from `./languages.js`.

  > Note RU/DRY-39 (B04/B12) plans an `escapeRegExp` in `utils/regexp.js`. B10 only **moves**
  > the existing local `escapeRegExp` into `discover-files.ts` as-is; B12 handles adoption of
  > the shared helper. Do not import the shared helper here unless it already exists and is
  > already adopted in this file at the time you run.

10.2 **`repomap.ts`** keeps the orchestrator: `buildRepoMap`, `parseWithConcurrencyLimit`,
`RepoMapOptions`, `MAX_FILE_SIZE_BYTES`, `PARSE_CONCURRENCY`. Import `discoverFiles` from
`./discover-files.js`.

10.3 **EH-17** — replace `repomap.ts:70` `console.warn(`repo-map unavailable: ...`)` with
`warnError('repo-map unavailable', err)`. Import `warnError` from `../../lib/warn.js`. Delete
the manual `err instanceof Error ? err.message : String(err)` formatting (`warnError` does it).

10.4 **PF-02** — eliminate the redundant `stat()`. Today each file is `stat`-ed three times:
the size gate in `parseWithConcurrencyLimit` (repomap.ts:90), the cache key in
`cache.getOrParse` (cache.ts:59), and inside `parseFile` (parse.ts:149). The audit fix:
**pass the cache's `FileStat` into `parseFile`** so `parseFile` does not re-stat.
  - In `parse.ts`, change `parseFile(absPath: string)` →
    `parseFile(absPath: string, fileStat?: Awaited<ReturnType<typeof stat>>)`. Inside, only
    call `stat(absPath)` when `fileStat` is undefined:
    ```ts
    let resolvedStat = fileStat;
    let source: string;
    try {
      if (resolvedStat === undefined) resolvedStat = await stat(absPath);
      source = await readFile(absPath, 'utf8');
    } catch { return null; }
    ```
    Use `resolvedStat.size`/`resolvedStat.mtimeMs` in the returned `FileNode`. Keep
    `import { stat } from 'node:fs/promises'`.
  - In `cache.ts`, `getOrParse` already has `fileStat` (line 59). Change its `parse` callback
    type to accept the stat and forward it:
    `getOrParse(absPath: string, parse: (p: string, s: Awaited<ReturnType<typeof stat>>) => Promise<FileNode | null>)`;
    on the miss path call `await parse(absPath, fileStat)`. Update the `ParseCache.getOrParse`
    signature in the interface (cache.ts:11) accordingly.
  - In `repomap.ts`, `parseWithConcurrencyLimit` already does the size-gate `stat` (line 90).
    Change its worker to pass `parseFn` through to `getOrParse` which now forwards the stat. The
    call site is `c.getOrParse(f, parseFile)` (line 49) — `parseFile`'s new optional second
    param is satisfied by `getOrParse` passing its own `fileStat`. The size gate at line 90-91
    stays (it filters before parsing), but it is the **cache key stat** that flows into
    `parseFile`; the worker's gate `stat` and cache's `stat` remain two reads. **The audit's
    named fix removes the third (`parseFile`'s own) stat** — that is what this step delivers.
    Do not over-engineer eliminating the gate stat; keep the change minimal and matching the
    audit row (`parse.ts:149`).
  - Update `parse.test.ts` / any `getOrParse` callers if the signature change breaks them
    (`grep -rn "getOrParse" src --include='*.ts'`). `parseFile`'s new param is optional, so
    direct `parseFile(path)` callers/tests are unaffected.

### 11. Split evidence review-packet (SRP-08)

11.1 **`review-packet/sections-io.ts`** — extract the fs/git IO from `sections.ts`:
`resolveChangedFiles` (calls `getCurrentChangedFiles`), `reviewExcerpt` (reads `REVIEW_FILE`),
`buildFinalReview` (reads `REVIEW_FILE`), `sourceArtifactMissing` (checks `STATE_FILE`), and
the `stripFrontmatter` helper used by `reviewExcerpt`. Imports: `node:fs` (`existsSync`),
`node:fs/promises` (`readFile`), `node:path` (`join`), `getCurrentChangedFiles` from
`lib/git.js`, `uniqueSorted` from `utils/collections.js`, `addMissing` from
`./missing-artifacts.js`, the path consts, `ReviewPacket`/`ReviewPacketFinalReviewStatus`,
`EvidenceLedger`, `DriftReport`.

  Keep the **pure** builders in `sections.ts`: `buildChanges`, `buildValidation`,
  `buildEvidence`, `buildDrift`, `buildEscalations`, `buildCost`, `buildRun`, and the pure
  helpers `taskEvidence`/`expectedEvidenceForTask`/`missingExpectedEvidence`/
  `groupDriftFindings`/`latestWorkflowComplete`. Note `buildDrift` calls
  `readDriftChainState` (IO) — leave it where the audit places the line: the row targets the
  fs/git IO helpers (`resolveChangedFiles`/`reviewExcerpt`/`buildFinalReview`). Keep
  `buildDrift` in `sections.ts`; do not chase `readDriftChainState` (out of this row's scope).

11.2 **`review-packet/artifacts.ts`** — extract the on-disk-artifact **deserialization** from
`build.ts` (the functions that read a file and validate/narrow it into a typed object). Move
exactly these, with their private helpers and local consts:
  - `readBriefQuality` (lines 84-114) → returns `BriefQualityArtifact | null`.
  - `readReadiness` (lines 116-157) + its helpers `nonnegativeIntegerOrNull` (159-161),
    `recoveryReadinessAction` (173-175), `readinessChecks` (177-191), and the
    `READINESS_NEXT_ACTIONS` const (163-171).
  - `readPacketEvents` (lines 193-232) + the narrowing helpers it uses: `recoveryReason`
    (54-56), `recoveryAction` (58-60), `recoveryActions` (62-66), `taskIds` (68-76),
    `strings` (78-82).
  - `readCheckpoints` (lines 234-271) + `toReviewPacketCheckpoint` (273-282) and the
    `RUN_LEDGER_PATH` const (41).

  `artifacts.ts` imports: `node:fs` (`existsSync`), `node:path` (`join`), the relevant path
  consts + `sessionDir`, `readJsonSafe` from `lib/fs.js`, `readEvents` from
  `core/sessions/log-reader.js`, `readEvidenceLedger` from `../persistence.js` (only if a
  moved fn needs it — it does not; `readEvidenceLedger` stays used by `buildReviewPacket`),
  `listCheckpointSummaries`/`CheckpointSummary` from `../../../snapshots/checkpoint-summary.js`,
  `readRunSnapshotLedger` from `../../../snapshots/run.js`, the enum guards
  (`RECOVERY_ACTIONS`/`RECOVERY_REASONS`/`RecoveryAction`/`RecoveryReason`),
  `TaskIdSchema`/`TaskId`, `ReviewPacket`/`ReviewPacketCheckpoint`,
  `includes`/`narrowRecord`/`optionalString` from `utils/type-guards.js`, `addMissing` from
  `./missing-artifacts.js`, `BriefQualityArtifact`/`PacketEvent` from `./types.js`.
  Export `readBriefQuality`, `readReadiness`, `readPacketEvents`, `readCheckpoints`.

11.3 **`build.ts` after extraction:** keep `buildReviewPacket` (the assembler, lines 284-329)
and `REVIEWER_CHECKLIST` (43-52). Import the four readers from `./artifacts.js`; keep importing
the `build*` section builders from `./sections.js`, `readEvidenceLedger` from `../persistence.js`,
`readDriftReport` from `../../drift/io.js` (repointed in step 4), `resolveChangedFiles`/
`buildFinalReview`/`sourceArtifactMissing` from `./sections-io.js` (repointed in step 11.4),
`makeRecoveryWithSources` from `./recovery.js`. Remove the now-unused narrowing-helper imports
(`includes`/`RECOVERY_*`/`TaskIdSchema`/etc.) from `build.ts` that followed the moved functions.

11.4 Update importers: in `build.ts`, the section-builder import block (lines 25-36) currently
pulls `resolveChangedFiles`/`buildFinalReview`/`sourceArtifactMissing` from `./sections.js` —
repoint those three to `./sections-io.js`; the pure builders (`buildChanges`/`buildCost`/
`buildDrift`/`buildEscalations`/`buildEvidence`/`buildRun`/`buildValidation`) stay from
`./sections.js`. Check `sections.test.ts`/`build.test.ts`
(`ls src/engine/orchestrator/evidence/review-packet/`) and repoint any moved-symbol imports.
All review-packet tests must pass with **no** assertion changes (this split is pure relocation).

### 12. Extract `run/auto-split-review.ts` (SRP-09)

`run/phases.ts` already uses `WorkflowContext` param objects (B06 landed) — do **not** change
signatures. The auto-split-overflow review/approval sub-flow is exactly these three
self-contained functions plus the helper they share:
  - `reviewAutoSplitOutput` (lines 125-163) — writes the split Task Briefs, requests briefs
    approval via `callbacks.onApprovalNeeded`, runs the quality gate, applies the
    `BRIEFS_READY`/`APPROVE_BRIEFS`/`REJECT_BRIEFS` transitions. Signature:
    `(opts: { wctx: WorkflowContext; state: WorkflowState; tasks: Task[]; setTrackedState: (s: WorkflowState) => void }) => Promise<{ state: WorkflowState; tasks: Task[]; approved: boolean }>`.
  - `readApprovedSplitTasks` (lines 115-123) — its private helper (reads + parses `TASKS_FILE`).
  - `formatSkippedSplitNotice` (lines 165-173) — formats the skipped-split warning string,
    typed `(skippedSplits: AutoSplitOverflowSkippedSplit[]) => string`.

12.1 **`run/auto-split-review.ts`** — move all three. Imports it needs:
`node:fs/promises` (`readFile`), `node:path` (`join`), `Task`/`WorkflowState`,
`WorkflowContext` from `../types.js`, `AutoSplitOverflowSkippedSplit` from
`../auto-split-overflow.js`, `runBriefQualityGate` from `./briefs-approval-loop.js`
(moved there in step 5.3 — **not** `./planning/shared.js`), `publishWarning`/`publishError`
from `../events.js`, `transitionAndSave` from `../state-ops.js`, `writeSpecFile` from
`../../../core/paths-io.js`, `formatTasks` from `../../spec/formatter.js`, `parseTasks` from
`../../spec/parser.js`, `TASKS_FILE`/`sessionDir` from `../../../core/paths.js`. Export
`reviewAutoSplitOutput` and `formatSkippedSplitNotice` (both called from `phases.ts`);
`readApprovedSplitTasks` stays module-private in `auto-split-review.ts`.

12.2 **`phases.ts` after extraction:** keep `runTasksAndReview` and its
`if (prediction.deterministic)` block (lines 222-250) — the `autoSplitOverflowTasks(...)`
**call** and the decision logic stay; only the review/approval helpers move out. Import
`reviewAutoSplitOutput`/`formatSkippedSplitNotice` from `./auto-split-review.js`. Leave
`applyPostPlanDrain`, `runPlanningPhases`, `predictTasksCost`, `predictCost`/estimate imports,
`reviewPlannerEstimate`/`runningPlannerEstimateReview` usage, and `runTaskLoop`/
`runFinalReviewPhase` exactly where they are. Note `phases.ts` currently imports
`runBriefQualityGate` from `../planning/shared.js` (line 20) **only** because it was passed
into the now-extracted `reviewAutoSplitOutput`; after the move that import leaves `phases.ts`
(it follows the function into `auto-split-review.ts`). Verify nothing else in `phases.ts` uses
`runBriefQualityGate` before removing the import. Run `phases`/`loop` tests
(`src/engine/orchestrator/run` + `task/loop.test.ts`).

### 13. Extract `estimate-review-parser.ts` (SRP-15)

From `planner-estimate-review.ts`, move the pure LLM-response parser: `parsePlannerEstimateReview`,
`PlannerEstimateReviewDecision` (type), and the private parse helpers `jsonCandidate`,
`parseTaskIds`, `stringField`, plus the `CLASSIFICATIONS` const it depends on. Imports:
`PlannerEstimateReviewClassification` from `core/schemas/summary.js`, `TaskId`/`TaskIdSchema`
from `core/schemas/task.js`, `includes`/`narrowRecord` from `utils/type-guards.js`.

  Keep in `planner-estimate-review.ts`: `buildPlannerEstimateReviewPacket`,
  `resolveProfileSelections`, `reviewPlannerEstimate`, the `*Review` factory functions
  (`runningPlannerEstimateReview`/`completedReview`/`unavailableReview`), and the
  `PlannerEstimateReviewPacket`/`ReviewPlannerEstimateOptions` types. Import
  `parsePlannerEstimateReview`/`PlannerEstimateReviewDecision` from `./estimate-review-parser.js`.
  Update any other importer of `parsePlannerEstimateReview` (`grep -rn "parsePlannerEstimateReview"
  src --include='*.ts'`) and its test (if a parser test exists, repoint it).

### 14. Add `getCurrentBranch` + route worktree/handoff HEAD reads (RU-03)

14.1 **`lib/git.ts`** — add (build on B05's edits; do not touch B05's `runGit`/`discardChangedFiles`):
```ts
export async function getCurrentBranch(dir: string): Promise<string> {
  try {
    const out = await getGit(dir).raw(['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  } catch (err) {
    throw toGitCommandError('rev-parse --abbrev-ref HEAD', err);
  }
}
```
(`--abbrev-ref HEAD` returns the branch name, or `HEAD` when detached — matching the prior
fallback behavior.)

14.2 **`engine/worktree.ts:103` `resolveWorktreeBranch`** — replace the manual `.git`-file →
gitdir → `HEAD` parse (lines 103-115) with `getCurrentBranch(wtDir)`. Import `getCurrentBranch`
from `../lib/git.js`. Behavior: `git rev-parse --abbrev-ref HEAD` run in the worktree dir
returns the worktree's checked-out branch (same value the manual parse extracted from
`refs/heads/<name>`). On detached/unknown it returns `HEAD` / the SHA; the old code returned
the raw head on no-ref — acceptable equivalent. Remove the now-unused `existsSync`/`readFile`
imports **only if** nothing else in `worktree.ts` uses them (grep within the file first — it
likely still uses `readFile` elsewhere; do not remove imports still in use).

14.3 **`engine/handoff/write.ts:223` `tryReadGitHead`** — replace the manual `.git/HEAD` →
`ref:` → ref-file parse with `getCurrentCommitSha` wrapped to preserve best-effort:
```ts
async function tryReadGitHead(projectDir: string): Promise<string | undefined> {
  try { return await getCurrentCommitSha(projectDir); } catch { return undefined; }
}
```
Import `getCurrentCommitSha` from `../../lib/git.js` (verify the relative depth). The old code
returned the resolved commit SHA (ref → ref-file contents) or the raw head; `getCurrentCommitSha`
returns `rev-parse HEAD` (the commit) — equivalent or strictly better. Keep the
`...(sourceCommit !== undefined && { sourceCommit })` spread at the call site. Remove unused
`readFile`/`join` imports **only if** unused elsewhere in the file (grep first).

### 15. Final pass

15.1 Run `find src -name 'index.ts' -o -name 'index.tsx'` → must be empty (no barrels created).

15.2 Run `grep -rn "providers/pricing" src --include='*.ts' | grep -v pricing-resolver` →
must be empty (rename complete).

15.3 Run `grep -rn "snapshots/store" src --include='*.ts'` and
`grep -rn "planning/shared" src --include='*.ts'` and
`grep -rn "builders/shared" src --include='*.ts'` and
`grep -rn "drift/drift" src --include='*.ts'` → only intended targets remain
(`drift/drift.js` for `analyzeBriefDrift`; the others empty).

15.4 Run `grep -rn "console.warn" src/engine/codebase/repomap.ts` → empty (EH-17 done).

## Out of scope (owned elsewhere — do NOT touch)

- `lib/fs.ts` `writeSecureFileAsync`, and `snapshots/run.ts` critical confinement
  (`assertPathConfined`) → **B05** (DRY-20, EH-01). Build on them; do not modify.
- `snapshots/store.ts` secure-write call sites → **B05**. (You move the code; keep B05's
  `SECURE_FILE_MODE`/secure-write usage intact.)
- `planning/shared.ts` function **signatures** / param objects → **B06** (PD-09). Split the
  file; keep B06's signatures.
- `providers/pricing.ts` `calculateUsageCost` family **signatures** → **B07** (PD-19). Rebase
  the split onto them; do not re-sign.
- `getProviderPricing` deletion, `predictCost` model-cache threading, `cost-prediction.ts`
  logic → **B09** (D8/AR-01). Do not reintroduce `getProviderPricing`; only fix its `.js`
  import path if a live importer remains.
- `recovery/builders/shared.ts` `formatPercent`/`formatCostFact`/`budgetPercentOf` (already
  moved to `core/formatting.ts`) → **B04** (RU-01). Do not re-add them.
- `recovery/builders/shared.ts` deletion of `hasRetryBudget`/`summarizeUnknownError` → **B14**
  (DC-06, D12). **Keep both** when splitting.
- `core/layout` relocation, `core/evidence/ledger.ts`, facades, `worker-packet-preview.ts`
  → **B09**. Do not touch.
- `mcp/tool/operations.ts` shared `withUpdatedTask`/`recomputeValidationSummary` → **B09**
  (EH-08/DRY-07). Not part of the resolver split.
- `core/runtime/commands/types.ts` content → **owned by core**; only **import** Accept/Reject
  types from it (do not edit it).
- `core/runtime/commands/registry.ts` (`commands/messages.ts` extraction) → **B11** (SRP-16).
- `stores/project/config.ts` (`config-persistence.ts`) → **B11** (SRP-13).
- `features/workflow/components/brief-review.ts` split → **B11** (SRP-03).
- `cli/commands/start.ts` split → **B11** (SRP-05).
- `handoff/write.ts` double `loadConfig` (PF-01) → **B16**; `worktree.ts` column/`isTerminalPhase`
  adoption → **B16/B04**. You only touch `resolveWorktreeBranch` (worktree.ts) and
  `tryReadGitHead` (handoff/write.ts) for RU-03 — leave everything else in those files alone.
- DRY adoption sweeps (`extract-json-block`, `formatTruncatedList`, `pluralize`, etc.) in the
  post-split engine tree → **B12**. Do the structural splits only; B12 does the adoption.

## Acceptance criteria

- [ ] Every finding ID in the table above is addressed in the code.
- [ ] `snapshots/store.ts` is deleted; its symbols live in `path-codec.ts`/`manifest.ts`/
  `lock.ts`/`files.ts`/`create.ts`; `ALWAYS_EXCLUDED` is exported from `files.ts`;
  `createSnapshot` no longer duplicates the capture loop (shared `captureFile`/`buildManifest`).
- [ ] `snapshots/run.ts` imports `AcceptRunSnapshotResult`/`RejectRunSnapshotResult` from
  `core/runtime/commands/types.js`; no local duplicate definitions remain.
- [ ] `checkpoint-summary.ts` derives `excludedPaths`/`text.excludedPaths` from `ALWAYS_EXCLUDED`;
  output strings are unchanged (`.git/, .diptych/, node_modules/, .trees/`).
- [ ] `planning/shared.ts` is deleted; symbols live in `planner-call-loop.ts`/
  `briefs-approval-loop.ts`/`planning-io.ts` with B06's signatures intact.
- [ ] `streaming/output-parsers.ts` holds only `getLineParser` + a flattened `wrapStreamParser`;
  the 4 format parsers live in `parse-{stream-json,jsonl,text,opencode}.ts`; non-test importers
  import directly from the per-format files.
- [ ] `drift/drift.ts` holds only the analyze concern; IO in `drift/io.ts`, formatting in
  `drift/format.ts`; importers repointed.
- [ ] `recovery/builders/shared.ts` is deleted; symbols split into
  `recovery-{issue,actions,details}.ts`; `hasRetryBudget`/`summarizeUnknownError` preserved.
- [ ] `mcp/resolver.ts` delegates manifest assembly to `mcp/manifest.ts`; `readResource`'s
  plain-file branches are table-driven; brief-hash read uses `readJsonSafeAsync`; `.git/HEAD`
  read uses `getCurrentCommitSha` (manifest now records `sourceCommit` on branch checkouts).
- [ ] `codebase/discover-files.ts` holds the glob/walk subsystem; `repomap.ts` uses `warnError`
  (no `console.warn`); `parse.ts` `parseFile` accepts the cache's `FileStat` and skips the
  redundant `stat()`; `cache.getOrParse` forwards it.
- [ ] `evidence/review-packet/{sections-io,artifacts}.ts` exist and hold the IO/deserialization
  concern split out of `sections.ts`/`build.ts`.
- [ ] `run/auto-split-review.ts` holds the auto-split sub-flow; `run/phases.ts` calls it.
- [ ] `providers/pricing.ts` is gone; `providers/cost.ts` (assembler) + `providers/cost-math.ts`
  (primitives) exist; **every** importer uses `providers/cost.js`/`cost-math.js`;
  `grep providers/pricing` (minus pricing-resolver) is empty.
- [ ] `estimate-review-parser.ts` holds `parsePlannerEstimateReview` + parse helpers;
  `planner-estimate-review.ts` imports it.
- [ ] `lib/git.ts` exports `getCurrentBranch`; `worktree.ts:resolveWorktreeBranch` and
  `handoff/write.ts:tryReadGitHead` route through `lib/git` (B05's git functions untouched).
- [ ] No new `!`/broad `as`/`any`/barrels/non-`Error` classes/memoization; `.js` imports;
  `engine/` does not import `react`/`ink`/`features`; no decorative comments.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (import paths updated; assertions unchanged **except** for the two
  intended behavior changes: (a) **RU-03** — resolver/handoff/worktree now use `lib/git`, so
  manifests record `sourceCommit` on branch checkouts; (b) **KISS-03** — the flattened
  `wrapStreamParser` keeps `isResult`/`usage` whenever `parseStreamLine` produced them. Update
  any stream-parser assertion that relied on the old incidental field drop; do not re-introduce
  the cascade).

## Tests

```bash
npm test -- src/engine/snapshots src/engine/orchestrator/planning src/engine/streaming \
  src/engine/orchestrator/drift src/engine/orchestrator/recovery src/engine/mcp \
  src/engine/codebase src/engine/orchestrator/evidence/review-packet \
  src/engine/orchestrator/run src/engine/providers src/engine/orchestrator/summary.test.ts \
  src/engine/orchestrator/planner-estimate-review src/engine/worktree.test.ts \
  src/engine/handoff
npm run typecheck
npm run lint
```
