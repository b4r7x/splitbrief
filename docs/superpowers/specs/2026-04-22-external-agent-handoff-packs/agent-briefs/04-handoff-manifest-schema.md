# 04 — Handoff Manifest Schema

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Prerequisite — BLOCKED

This brief depends on `docs/superpowers/specs/2026-04-26-brief-hash-versioning/`. That spec must land
and export a stable helper before this brief may be implemented:

```ts
// from 2026-04-26-brief-hash-versioning (exact path TBD by that spec)
export function computeBriefHash(tasks: Task[]): string;
```

`computeBriefHash` returns `sha256(canonicalJSON(tasks))` where `canonicalJSON` is deterministic
key-ordered serialization of the validated `Task[]` excluding mutable fields like `status`
(per ADR-008). Do not implement it here — import it from wherever the hash spec places it.

Do not begin this brief until that export exists and typechecks.

## Goal

Define and validate the `manifest.json` schema for every Handoff Pack (ADR-005), and wire its
generation into the writer service created in brief 02 (`src/engine/handoff/write.ts`).

`manifest.json` is a machine-readable index that lets external tools verify pack integrity,
detect staleness, and discover artifacts without parsing markdown.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `src/core/schemas/task.ts`               (Task, TaskId)
- `src/core/schemas/enums.ts`              (WorkflowMode)
- `src/core/schemas/evidence.ts`           (pattern for a versioned Zod schema)
- `src/core/paths.ts`                      (existing path constants)
- `src/engine/handoff/types.ts`            (HandoffTarget, from brief 01)
- `src/engine/handoff/write.ts`            (writeHandoffPack to extend, from brief 02)
- `src/core/paths-io.ts`                   (getDiptychVersion, writeSecureFile pattern)

## Files To Touch

- `src/core/schemas/handoff-manifest.ts` **new** — Zod schema + inferred types
- `src/core/paths.ts` — add `HANDOFF_MANIFEST_FILE = 'manifest.json'`
- `src/engine/handoff/manifest.ts` **new** — `buildManifest` and `writeManifest` helpers
- `src/engine/handoff/manifest.test.ts` **new**
- `src/engine/handoff/write.ts` — call `writeManifest` after writing all pack files

Do not create `src/core/schemas/index.ts` (zero barrels).

## Schema (`src/core/schemas/handoff-manifest.ts`)

```ts
import { z } from 'zod';
import { WorkflowModeSchema } from './enums.js';

export const HandoffManifestSchema = z.object({
  packVersion: z.literal('1'),
  diptychVersion: z.string(),
  generatedAt: z.string(),            // ISO 8601
  sessionId: z.string(),
  briefHash: z.string(),              // sha256 from computeBriefHash(tasks)
  sourceCommit: z.string().optional(),// git HEAD at generation time, if in a git repo
  target: z.string(),                 // "spec-kit" | "agents-md" | "claude-code" | "copilot-issue" | <custom>
  mode: WorkflowModeSchema,
  taskIds: z.array(z.string()),       // ordered T0NN ids in this pack
  artifacts: z.object({
    spec: z.literal('spec.md').optional(),
    plan: z.literal('plan.md').optional(),
    constitution: z.literal('constitution.md').optional(),
    tasks: z.array(z.string()),       // relative paths, e.g. ["tasks/T001.md", "tasks/T002.md"]
  }),
  validation: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
  }),
  notes: z.string().optional(),
});

export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;
```

**Schema design note — `target` is `z.string()`, not a closed union.** ADR-005 lists four
built-in values, but ADR-010 allows custom renderer targets with arbitrary basenames. A closed
`z.union([z.literal('spec-kit'), ...])` would reject custom targets at parse time. The open
`z.string()` accepts both. Built-in renderers should still be documented in JSDoc comments on
the field.

## Manifest Builder (`src/engine/handoff/manifest.ts`)

```ts
import type { Task } from '../../core/schemas/task.js';
import type { HandoffManifest } from '../../core/schemas/handoff-manifest.js';
import type { HandoffTarget } from './types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
// Import computeBriefHash from wherever brief-hash-versioning places it:
import { computeBriefHash } from '<path-from-brief-hash-versioning-spec>.js';

export type BuildManifestOptions = {
  sessionId: string;
  diptychVersion: string;
  target: HandoffTarget | string;
  mode: WorkflowMode;
  tasks: Task[];
  packFiles: string[];          // relative paths of all files in the pack
  spec?: string | null;
  plan?: string | null;
  constitution?: string | null;
  validation?: { typecheck?: string; lint?: string; test?: string };
  sourceCommit?: string;
};

export function buildManifest(options: BuildManifestOptions): HandoffManifest;

export function writeManifest(outDir: string, manifest: HandoffManifest): void;
```

`buildManifest` must:
1. Call `computeBriefHash(options.tasks)` to populate `briefHash`.
2. Derive `artifacts.tasks` from `options.packFiles` filtered to entries under `tasks/`.
3. Set `artifacts.spec`, `artifacts.plan`, `artifacts.constitution` only when the corresponding input is non-null.
4. Set `generatedAt` to `new Date().toISOString()`.
5. Validate the result via `HandoffManifestSchema.parse(...)` before returning.

`writeManifest` writes `manifest.json` at `outDir/manifest.json` using `writeFileSync` with
mode `0o600`.

## Integration with `write.ts` (brief 02)

At the end of `writeHandoffPack` in `src/engine/handoff/write.ts`, after all pack files have
been written, call:

```ts
import { buildManifest, writeManifest } from './manifest.js';

const manifest = buildManifest({
  sessionId: options.sessionId,
  diptychVersion: getDiptychVersion(),
  target: options.target,
  mode: state.mode,
  tasks: filteredTasks,
  packFiles: result.files,
  spec: specContent,
  plan: planContent,
  constitution: constitutionContent,
  validation: validationCommands,
  sourceCommit: tryReadGitHead(options.projectDir),  // helper below
});
writeManifest(options.outDir, manifest);
```

Add a small private helper in `write.ts`:

```ts
function tryReadGitHead(projectDir: string): string | undefined {
  // read .git/HEAD and resolve the commit sha; return undefined on any error
}
```

`getDiptychVersion` already exists in `src/core/paths-io.ts` — import it from there.

## Versioning and Compatibility

- `packVersion: '1'` is the literal string. Consumers must check this field and reject packs with
  unknown versions rather than silently misinterpreting them.
- Additive changes to `HandoffManifest` (new optional fields) do not bump `packVersion`.
- Removing or changing the type of any field requires a `packVersion: '2'` and a migration note
  in `CHANGELOG.md`.
- ADR-009 reserves `packVersion: '2'` for the future MCP live-feed mode. Pack consumers written
  for v1 will not break: MCP paths (`manifest.json`, `tasks/T0NN.md`) are forward-compatible.

## Evidence / Drift Integration (ADR-008)

`briefHash` is also recorded:
- In the YAML frontmatter of each `tasks/T0NN.md` in the pack (the renderer in brief 01 writes
  a `<placeholder>` string which the writer in `write.ts` must backfill before writing the file).
- In `evidence.json` per-entry if evidence spec is implemented (via the `2026-04-22-task-brief-evidence-contract` spec).
- In `drift-report.json` if drift detection is implemented (via the same spec).

Backfilling task files: after calling `renderHandoff`, before writing files to disk, replace the
literal `<placeholder>` in each `tasks/T0NN.md` content string with the computed `briefHash`.

## Tests (`src/engine/handoff/manifest.test.ts`)

- `buildManifest` with spec + plan + constitution sets all three artifact fields.
- `buildManifest` without spec/plan/constitution omits those artifact fields.
- `briefHash` is a 64-character hex string (sha256).
- `HandoffManifestSchema.parse` accepts a valid manifest.
- `HandoffManifestSchema.parse` rejects a manifest with missing required fields.
- `packVersion` must be `'1'` exactly — numeric `1` is rejected.
- Custom `target` string (not one of the four built-ins) parses successfully (open string field).
- `writeManifest` writes parseable JSON at `manifest.json` inside a temp dir.

## Constraints

- No agent spawning, no auto-pickup, no watch mode (ADR-011). This brief is pure data — no
  execution surface — but cross-reference for completeness.
- Zod schema in `src/core/schemas/` (runtime validation). TypeScript type inferred via
  `z.infer<>` from the schema — do not declare a separate `HandoffManifest` interface.
- No classes. No barrel `index.ts`.

## Acceptance Criteria

- Every pack written by `writeHandoffPack` includes a valid `manifest.json`.
- `HandoffManifestSchema.parse` validates without throwing on the output of `buildManifest`.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/handoff/manifest.test.ts
npm run typecheck
npm run lint
npm test
```
