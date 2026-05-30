# B03 — Schema & enum single-sourcing

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Collapse every place where a Zod schema and its TypeScript type (or a const tuple and
its enum) are maintained by hand into one source of truth. Concretely: derive the
~90-member `EngineEvent` union from its Zod `discriminatedUnion` via `z.infer` and drop
the `z.custom` wrapper so `parseEngineEvent` parses with real structured errors; move the
conflict-kind / conflict-action / context-fit / current-code-mode enums to const tuples
in `core/schemas/enums.ts` and derive both the Zod schemas and TS types from them;
single-source the 11 hook-event names; derive `TokenUsageLike`, `IpcServerArgs`,
`CLIOverrides`, and the IPC protocol types from their schemas; replace the hand-rolled
`isDriftReport` with `DriftReportSchema.safeParse`; make `RoutingEventFields` a
`Pick<RoutingDecision, …>`; share the byte-identical MCP param schemas; and give the two
`approval_needed`/protocol IPC requests a real Zod schema. After this brief no consumer
behavior changes — only the definitions consolidate.

## Wave / ordering

- **Wave:** 1. **Runs after:** B01 (formatting sweep) only, because B01 reflows whitespace
  in every file and all later edits must land in formatted files. B02 runs in the same
  wave but on disjoint files (see Out of scope); there is no ordering dependency between
  B02 and B03 except the two collision rows below.
- **Why B03 sits in wave 1:** it **produces** the const-tuple enums and the `z.infer`
  types that downstream briefs consume; setting these first keeps later code clean.
- **Decisions that bind this brief:**
  - **D7** — `core/layout/` relocates and its hand-mirrored `LayoutEvent` is **deleted by
    B09**. B03 must **NOT** touch `LayoutEvent` or `core/layout/event-types.ts`; it is
    deleted there, not single-sourced here.
  - **D13** — an unbiased validator re-derives each finding from your diff; address every
    row in code, not in prose.

## File ownership

Files B03 **edits** (read each first; build on B01's formatting):

- `src/core/schemas/enums.ts` — **add** new const tuples + Zod schemas + `z.infer` types
  (file already exists and is populated; do not rewrite it, append).
- `src/engine/events/types.ts` — replace the hand-written `EngineEvent` union with
  `z.infer`; keep the other exports.
- `src/engine/events/schema.ts` — make `EngineEventSchema` the discriminated union itself
  (drop `z.custom`); reference shared enum schemas.
- `src/engine/events/workflow-events.ts` — re-derive the four enum types from
  `enums.ts`; keep everything else.
- `src/engine/orchestrator/task/routing-fields.ts` — `RoutingEventFields` →
  `Pick<RoutingDecision, …>`.
- `src/core/schemas/hooks.ts` — `HookEventSchema` from a new `HOOK_EVENTS` tuple.
- `src/core/config/load/transform.ts` — `HOOK_EVENT_KEYS` from `HOOK_EVENTS`.
- `src/core/schemas/tokens.ts` — replace inline `contextFit`/`currentCodeContextMode`
  enums with the shared enum schemas.
- `src/core/schemas/summary.ts` — derive the `contextFit` superset (line 100) from
  `TASK_CONTEXT_FITS` (DRY-10's 4th file). **Only** line 100; do **not** touch line 96's
  `taskId: z.string()` (that is B02's TS-07).
- `src/engine/streaming/output-parsers.ts` — `usage: TokenUsageLikeSchema.optional()`.
- `src/engine/ipc/protocol.ts` — real Zod for the protocol requests; derive types via
  `z.infer`; `safeParse` in the parsers (EH-16, DRY-33).
- `src/engine/ipc/server-args.ts` — `IpcServerArgsSchema` + `z.infer` (TS-09).
- `src/core/config/runtime/overrides.ts` — add `CLIOverridesSchema`; `CLIOverrides`
  becomes `z.infer`. Keep `RunnerOverrides` hand-written (distinct shape — see step 9).
  **Only** the type→schema derivation; leave `applyCLIOverrides` / `applyRunnerOverrides` /
  `existingToOpts` logic untouched.
- `src/core/schemas/drift.ts` — `isDriftReport` → `DriftReportSchema.safeParse`.
- `src/core/schemas/review-packet.ts` — import canonical enums for the byte-identical
  re-inlined ones (DRY-43, scoped — see step 13).
- `src/engine/mcp/handlers.ts` — collapse the two identical param schemas (DRY-76).

Files B03 **creates:** none (all new symbols are added to existing files; `enums.ts`
already exists).

Files B03 **deletes:** none.

**Collision-map rows that mention B03 (this file owns these outright):**

| File | Briefs | B03 owns |
|---|---|---|
| `engine/events/{types,schema}.ts` | **B03 only** | The entire `EngineEvent` `z.infer` migration and `z.custom` removal. No other brief touches these. |

There is no shared-line collision for B03 — every other brief that touches an adjacent
file owns a different file or concern (see Out of scope).

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| TS-03 | high | `engine/events/schema.ts:127-428` + `events/types.ts:13-90` | Derive `type EngineEvent = z.infer<typeof EngineEventSchema>`; delete the hand-written union. |
| TS-04 | high | `engine/events/schema.ts:430-437` | Drop `z.custom`; `EngineEventSchema` **is** the discriminated union; `parseEngineEvent` calls its `safeParse`. |
| TS-08 | med | `engine/streaming/output-parsers.ts:36,119` | `usage: TokenUsageLikeSchema.optional()` on `ResultEvent` and `TurnCompletedEvent`. |
| TS-09 | med | `engine/ipc/server-args.ts:27-127` | Zod `CLIOverridesSchema`; derive `IpcServerArgs` via `z.infer`; parsers use `safeParse`. |
| TS-11 | med | `engine/orchestrator/task/routing-fields.ts:4-13` | `RoutingEventFields = Pick<RoutingDecision, …>`; delete the duplicate interface body. |
| EH-16 | low | `engine/ipc/protocol.ts:29` | Real Zod schema for the 2 `z.custom`/`isRecord`-gated requests (`task_review`, `user_edit_conflict`). |
| DRY-01 | high | `events/schema.ts:43-78` + `events/workflow-events.ts:5-43` | Const tuples for conflict-kind (written **2×** in schema.ts) / conflict-action / context-fit / current-code-mode; export `USER_EDIT_CONFLICT_KINDS`. |
| DRY-02 | high | `core/schemas/hooks.ts:4-79` + `config/load/transform.ts:11-23` | One `HOOK_EVENTS` tuple; build the enum schema and the `HOOK_EVENT_KEYS` Set from it. |
| DRY-10 | high | `core/schemas/tokens.ts:36,41` (+ `summary.ts:100`, the 4th file) | contextFit/currentCodeContextMode schemas in `enums.ts`; adopt in tokens.ts; derive summary.ts's `'unknown'`-superset from the tuple. |
| DRY-33 | med | `engine/ipc/protocol.ts:85-254` | Derive `ServerMessage`/`IpcPromptRequest`-family types via `z.infer` where the schema exists; parse via `safeParse`. |
| DRY-42 | med | `core/schemas/drift.ts:36-46` | `isDriftReport` delegates to `DriftReportSchema.safeParse`. |
| DRY-43 | med | `core/schemas/review-packet.ts:105-327` (+summary/drift/evidence) | Import `DriftSeveritySchema`/`DriftCodeSchema` (the only identical exported twins). All other re-inlined shapes verified divergent — bounded exclusions in step 13. |
| DRY-76 | low | `engine/mcp/handlers.ts:21-22` | Collapse `JsonRpcParamsSchema`/`ToolArgumentsSchema` (byte-identical) into one shared schema. |

## Required changes

Work top-down. Run `npm run typecheck` after the `EngineEvent` migration (step 1–4)
before continuing — it is the highest-risk change.

### 1. Add the shared enum tuples + schemas to `core/schemas/enums.ts` (DRY-01, DRY-10)

`enums.ts` already exists and exports many tuples in exactly this style (e.g.
`RECOVERY_ACTIONS` + `RecoveryActionSchema` + `type RecoveryAction = z.infer<…>`).
**Append** the following, matching that style. Place them near the other workflow enums:

```ts
export const USER_EDIT_CONFLICT_KINDS = [
  'unrelated',
  'current-task-conflict',
  'future-task-stale-input',
  'dependency-file-conflict',
  'changed-during-approval-promotion',
] as const;
export const UserEditConflictKindSchema = z.enum(USER_EDIT_CONFLICT_KINDS);
export type UserEditConflictKind = z.infer<typeof UserEditConflictKindSchema>;

export const USER_EDIT_CONFLICT_ACTIONS = [
  'continue-unrelated',
  'regenerate-rebase',
  'pause',
  'skip-current-task',
  'abort-workflow',
] as const;
export const UserEditConflictActionSchema = z.enum(USER_EDIT_CONFLICT_ACTIONS);
export type UserEditConflictAction = z.infer<typeof UserEditConflictActionSchema>;

export const TASK_CONTEXT_FITS = ['fits', 'tight', 'overflow'] as const;
export const TaskContextFitSchema = z.enum(TASK_CONTEXT_FITS);
export type TaskContextFit = z.infer<typeof TaskContextFitSchema>;

export const CURRENT_CODE_CONTEXT_MODES = ['none', 'whole-file', 'function-level', 'truncated'] as const;
export const CurrentCodeContextModeSchema = z.enum(CURRENT_CODE_CONTEXT_MODES);
export type CurrentCodeContextMode = z.infer<typeof CurrentCodeContextModeSchema>;
```

The values must match exactly the current literals (verified against
`workflow-events.ts:5-20,42-43`, `schema.ts:43-78`, `tokens.ts:36,41`).

### 2. Rewire `engine/events/workflow-events.ts` to consume the shared enums (DRY-01, DRY-10)

This file currently **defines** `UserEditConflictKind` (lines 5-10),
`USER_EDIT_CONFLICT_ACTIONS` + `UserEditConflictAction` + `isUserEditConflictAction`
(lines 12-24), `TaskContextFit` (line 42), `CurrentCodeContextMode` (line 43). Replace
those definitions with re-exports of the canonical ones from `enums.js`, so every existing
importer of these names from `workflow-events.js` keeps compiling (there are ~9–20 such
importers across `engine/` and `features/`; do not chase them — re-exporting keeps them
valid). Concretely:

- Add to the imports: `UserEditConflictKind`, `USER_EDIT_CONFLICT_ACTIONS`,
  `UserEditConflictActionSchema`, `UserEditConflictAction`, `TaskContextFit`,
  `CurrentCodeContextMode` from `'../../core/schemas/enums.js'`.
- Delete the local `type UserEditConflictKind = …` union and re-export the type:
  `export type { UserEditConflictKind } from '../../core/schemas/enums.js';`
- Delete the local `USER_EDIT_CONFLICT_ACTIONS` array, the `UserEditConflictAction` type,
  and keep `isUserEditConflictAction` but implement it via the schema:

  ```ts
  export { USER_EDIT_CONFLICT_ACTIONS } from '../../core/schemas/enums.js';
  export type { UserEditConflictAction } from '../../core/schemas/enums.js';

  export function isUserEditConflictAction(value: string): value is UserEditConflictAction {
    return UserEditConflictActionSchema.safeParse(value).success;
  }
  ```

  (Keep `isUserEditConflictAction` exported from `workflow-events.ts` — `ipc/protocol.ts`
  and others import it from here.)
- Delete the local `TaskContextFit` and `CurrentCodeContextMode` type aliases; re-export:
  `export type { TaskContextFit, CurrentCodeContextMode } from '../../core/schemas/enums.js';`
- `UserEditConflictFile`, `UserEditConflict`, `TaskReviewStatus`, `TaskReviewCommand`,
  `TaskReviewAction`, `TaskReviewValidation`, `TaskReviewRequest`, `TaskReviewResponse`
  stay defined here (they are structural, not single-string enums) — they now reference
  the re-exported `UserEditConflictKind` / `UserEditConflictAction` / `TaskContextFit` /
  `CurrentCodeContextMode`.

Re-exporting types/values from a file that still owns substantial declarations does **not**
violate the zero-barrels rule (the rule forbids re-export-only `index.ts`; this is not an
`index.ts` and is not re-export-only).

### 3. Derive `EngineEvent` via `z.infer` in `engine/events/types.ts` (TS-03)

The audit's primary recommendation (#4) is explicit: derive `EngineEvent` from the Zod
union, killing the 90-member dual definition. Do this:

- Delete the entire hand-written `export type EngineEvent = …` union (types.ts:13-90).
- Replace it with:
  ```ts
  import type { EngineEventSchema } from './schema.js';
  export type EngineEvent = z.infer<typeof EngineEventSchema>;
  ```
  (import `z` from `'zod'`). `import type` of the schema const is fine for `typeof`.
- **Keep** these exports unchanged — they are not part of the union derivation and have
  external consumers:
  - `export type ValidationStages = { typecheck: boolean; lint: boolean; test: boolean };`
    (consumed by `engine/orchestrator/{validation,events}.ts` and
    `features/workflow/conversation-rows/event-format.ts`).
  - `export type EngineEventOf<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;`
  - `export type EventSink = (event: EngineEvent) => void;`
  - `export interface EventBus { … }`
- Delete the now-unused per-enum `import type { … }` lines at the top of types.ts
  (`TaskId`, `ApproveLevel`, `Phase`, `RecoveryAction`, …, `UserEditConflict`,
  `TaskReviewRequest`, etc.) **only if** they become unused after the union is removed.
  `ValidationStages` needs no imports. Let `noUnusedLocals`/lint tell you which to drop;
  do not leave dead imports.

**Risk note (verified):** `z.infer` of a `discriminatedUnion` whose members all use
`.passthrough()` produces variants that (a) narrow correctly by `type`, (b) work with
`Extract<…, { type: T }>`, and (c) carry a catchall `[k: string]: unknown` index
signature. The catchall only *permits* extra keys and was confirmed compatible under
`--strict --exactOptionalPropertyTypes`. The `task_review_needed` variant derives from
`taskReviewRequestFields` (schema.ts:80-125) and remains structurally a superset of
`TaskReviewRequest`; its consumers (`.taskId`, `toMatchObject`, switch narrowing) are
unaffected. If — and only if — the full typecheck surfaces unbounded fallout you cannot
resolve locally, fall back to the audit's sanctioned alternative: keep the hand-written
`EngineEvent` type and add a Vitest `expectTypeOf` equivalence test
(`expectTypeOf<z.infer<typeof EngineEventSchema>>().toEqualTypeOf<EngineEvent>()`) in
`schema.test.ts` to compile-link the two. Prefer the `z.infer` derivation.

### 4. Make `EngineEventSchema` the union and drop `z.custom` (TS-04)

In `engine/events/schema.ts`:

- Remove `import type { EngineEvent } from './types.js'` (it would now be circular and is
  unused once the helpers below are relaxed).
- Relax the two helper generics so they no longer depend on `EngineEvent['type']`:
  ```ts
  function phaseEvent<T extends string>(type: T) { … }
  function noPhaseEvent<T extends string>(type: T) { … }
  ```
  (Their bodies already only use `type` in `z.literal(type)`; the `T` literal is
  preserved by `z.literal`, so the discriminant union stays exact.)
- Rename the local `const EngineEventDiscriminatedSchema = z.discriminatedUnion(…)` to be
  the exported schema, and delete the `z.custom` wrapper:
  ```ts
  export const EngineEventSchema = z.discriminatedUnion('type', [ … ]);

  export function parseEngineEvent(value: unknown): EngineEvent | null {
    const result = EngineEventSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  ```
  `parseEngineEvent`'s return type is `EngineEvent` (= `z.infer<typeof EngineEventSchema>`),
  so `result.data` is already that type — no cast.
- Inside schema.ts, replace the inline enums that now have canonical schemas (DRY-01):
  - `userEditConflictActionSchema` (lines 43-49) → import and use `UserEditConflictActionSchema`.
  - the conflict-`kind` `z.enum([...])` written **twice** (lines 52-58 and 64-70) → use
    `UserEditConflictKindSchema` both times.
  - `taskContextFitSchema` (line 77) → `TaskContextFitSchema`.
  - `currentCodeContextModeSchema` (line 78) → `CurrentCodeContextModeSchema`.
  Add these to the `from '../../core/schemas/enums.js'` import block at the top (it already
  imports `ActionClassSchema`, `PhaseSchema`, etc.). Keep `userEditConflictSchema`,
  `taskReviewRequestFields`, and all `.passthrough()` calls exactly as they are.

`EngineEventSchema` is embedded as a field in `ServerMessageSchema` (protocol.ts:94) —
a `z.discriminatedUnion` embeds fine as a field schema; that line needs no change.

### 5. `routing-fields.ts`: `RoutingEventFields = Pick<RoutingDecision, …>` (TS-11)

`RoutingDecision` (in `engine/orchestrator/context-routing/types.ts:44-59`) already has
every field of the hand-written `RoutingEventFields` interface. Replace lines 4-13:

```ts
import type { RoutingDecision } from '../context-routing/types.js';

export type RoutingEventFields = Pick<
  RoutingDecision,
  | 'fit'
  | 'estimatedTokens'
  | 'untruncatedEstimatedTokens'
  | 'contextLength'
  | 'currentCodeTruncated'
  | 'currentCodeContextMode'
  | 'costPosture'
  | 'reason'
>;
```

The existing `import type { TaskContextFit, CurrentCodeContextMode } from '../../events/workflow-events.js'`
line becomes unused — remove it. `buildRoutingEventFields` is called with
`wctx.routingDecision` (a `RoutingDecision`) in `task/pre-task.ts:37,54`; `RoutingDecision`
is assignable to the `Pick`, so callers are unaffected. The `RoutingPayloadFields`
`Pick<Extract<EngineEvent, …>>` and the function body stay unchanged.

### 6. Single-source the hook events (DRY-02)

Add the tuple to `core/schemas/hooks.ts` (its schema home) and build both consumers from it.

In `core/schemas/hooks.ts`, above `HookEventSchema`:
```ts
export const HOOK_EVENTS = [
  'pre_planning',
  'pre_task',
  'post_task',
  'pre_validation',
  'post_validation',
  'pre_commit',
  'post_commit',
  'pre_escalation',
  'pre_compact',
  'on_error',
  'on_complete',
] as const;
export const HookEventSchema = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEventSchema>;
```
Leave the `HooksConfigSchema` object keys (lines 67-78) as literal property names — an
object shape's keys are structural and are not derivable from a string tuple without
`z.record`, which would weaken the schema (it must enforce the exact known keys via
`.strict()`). DRY-02's fix targets the **enum** and the **Set**, not the object shape.

In `core/config/load/transform.ts`, replace the literal `HOOK_EVENT_KEYS` Set (lines
11-23) with one built from the tuple:
```ts
import { HOOK_EVENTS } from '../../schemas/hooks.js';
const HOOK_EVENT_KEYS: ReadonlySet<string> = new Set(HOOK_EVENTS);
```
`HOOK_EVENT_KEYS.has(...)` already takes a `string`; `ReadonlySet<string>` is correct.

### 7. `tokens.ts`: adopt the shared context-fit/mode schemas (DRY-10)

In `core/schemas/tokens.ts`:
- Add `TaskContextFitSchema` and `CurrentCodeContextModeSchema` to the import from
  `./enums.js` (it currently imports only `TaskCompletionMethodSchema` from there).
- Line 36: `contextFit: z.enum(['fits', 'tight', 'overflow']).optional()` →
  `contextFit: TaskContextFitSchema.optional()`.
- Line 41: `currentCodeContextMode: z.enum(['none', 'whole-file', 'function-level', 'truncated']).optional()`
  → `currentCodeContextMode: CurrentCodeContextModeSchema.optional()`.

The inferred `TaskTokenUsage` type is unchanged (same literals).

**The 4th copy (DRY-10 says "across 4 files"):** `core/schemas/summary.ts:100`
(`CostPredictionSchema.tasks[].contextFit`) is a deliberate **superset**:
`z.enum(['fits', 'tight', 'overflow', 'unknown'])` — it adds `'unknown'`. To single-source
without changing its members, derive it from the tuple:
- summary.ts already imports `z` and from `./enums.js`; add `TASK_CONTEXT_FITS` to that import.
- Line 100: `contextFit: z.enum(['fits', 'tight', 'overflow', 'unknown'])` →
  `contextFit: z.enum([...TASK_CONTEXT_FITS, 'unknown'])`.
- Do **NOT** touch `summary.ts:96` `taskId: z.string()` — that `TaskIdSchema` consistency
  fix is **B02's** (audit TS-07 lists `summary.ts:96`). Leave the `contextConfidence`,
  `priceConfidence` enums (lines 101-107) alone — they have no canonical twin.

### 8. `output-parsers.ts`: tighten `usage` to `TokenUsageLikeSchema` (TS-08)

`TokenUsageLikeSchema` already exists and is exported from
`engine/streaming/token-utils.ts`. Import it and use it:
- Add to the existing `./token-utils.js` import: `TokenUsageLikeSchema` (currently only
  `toTokenDelta` is imported from there).
- Line 36, `ResultEvent`: `usage: z.record(z.string(), z.unknown()).optional()` →
  `usage: TokenUsageLikeSchema.optional()`.
- Line 119, `TurnCompletedEvent`: `usage: z.record(z.string(), z.unknown())` →
  `usage: TokenUsageLikeSchema`.
`toTokenDelta(...)` already accepts `unknown` and re-parses; passing the now-typed
`usage` is compatible. Behavior is unchanged (same fields accepted), only the double-broad
parse is removed.

### 9. `server-args.ts` + `overrides.ts`: derive `IpcServerArgs`/`CLIOverrides` (TS-09)

**First**, in `core/config/runtime/overrides.ts`, add a Zod schema and derive the types
(this is the single-source the audit asks for; `overrides.ts` is not in any collision
row, but touch **only** the type/schema definitions — leave every `apply*` function
intact):

`overrides.ts` already imports `z`? No — it does not. Add `import { z } from 'zod';`.
It imports `WORKFLOW_MODES` and `type WorkflowMode` from `'../../schemas/enums.js'` but
**not** `WorkflowModeSchema`; add `WorkflowModeSchema` to that existing import block.

```ts
const RunnerOverrideSchema = z.object({
  tool: z.string().optional(),
  model: z.string().optional(),
  command: z.string().optional(),
});

export const CLIOverridesSchema = z.object({
  planner: RunnerOverrideSchema.optional(),
  implementer: RunnerOverrideSchema.optional(),
  contextLength: z.number().optional(),
  autoApprove: z.boolean().optional(),
  approve: z.string().optional(),
  mode: WorkflowModeSchema.optional(),
  budget: z.number().optional(),
  plannerEffort: z.string().optional(),
  yolo: z.boolean().optional(),
});

export type CLIOverrides = z.infer<typeof CLIOverridesSchema>;
```
Delete the hand-written `interface CLIOverrides { … }` (lines 18-28). Keep
`interface RunnerOverrides` (lines 30-35) as-is — it has an extra `contextLength` field
and is a distinct local concern; do **not** fold it into the schema.

> `z.infer` of `z.string().optional()` yields `string | undefined`, matching the current
> interface under `exactOptionalPropertyTypes`. Verify the typecheck: if any consumer
> relied on the property being **required-but-undefined** vs **optional**, adjust, but the
> current interface already uses `?: T | undefined`, so the shapes match.

**Then**, in `engine/ipc/server-args.ts`, replace the hand-rolled validation with a schema:

```ts
import { CLIOverridesSchema } from '../../core/config/runtime/overrides.js';
import { z } from 'zod';
// keep: normalizeLegacyMode is still needed for legacy 'full' → 'speckit' on `mode`.

const IpcServerArgsSchema = z.object({
  sessionId: z.string(),
  projectDir: z.string(),
  feature: z.string(),
  mode: z.string().transform((m, ctx) => {
    const normalized = normalizeLegacyMode(m);
    if (normalized === null) { ctx.addIssue({ code: 'custom', message: 'invalid mode' }); return z.NEVER; }
    return normalized;
  }),
  configPath: z.string(),
  overrides: CLIOverridesSchema.default({}),
  allowHooks: z.boolean().optional(),
  plannerContext: z.string().optional(),
});

export type IpcServerArgs = z.infer<typeof IpcServerArgsSchema>;

export function parseIpcServerArgs(value: unknown): IpcServerArgs | null {
  const result = IpcServerArgsSchema.safeParse(value);
  return result.success ? result.data : null;
}
```
- Delete the hand-written `type IpcServerArgs = { … }`, `RUNNER_OVERRIDE_KEYS`,
  `CLI_OVERRIDE_KEYS`, `RunnerOverride`, `hasOnlyKnownKeys`, `parseRunnerOverride`,
  `isOptionalBoolean`, `isOptionalNumber`, `parseCliOverrides`, and the old body of
  `parseIpcServerArgs`. The schema subsumes them and **fixes the silent-drop bug** (the
  old key-allowlist Set silently dropped any new override field).
- Keep `SERVER_ARGS_FILE`, `ipcServerArgsError`, `readIpcServerArgsFile`,
  `writeIpcServerArgsFile` unchanged (they still throw `invalidServerArgs` when
  `parseIpcServerArgs` returns null).
- Remove now-unused imports (`isRecord`, `isOptionalString` from `./guards.js`,
  the `CLIOverrides` type import if it was only used for the deleted helpers — re-check
  with lint).

> Behavior note: the old `parseCliOverrides` **rejected** unknown override keys (returned
> `null`). The new `CLIOverridesSchema` (a plain `z.object`) **strips** unknown keys by
> default rather than rejecting — which is the *intended* forward-compatible behavior and
> directly resolves the "new field silently drops" complaint by making the known set the
> single source. Do not add `.strict()`; stripping is correct here. The two existing
> `server-args` tests (if any assert rejection of unknown keys) must be updated to assert
> the known fields survive a round-trip; if `engine/ipc/*.test.ts` covers this, adjust the
> assertion to the strip behavior.

### 10. `protocol.ts`: real schemas for the `z.custom` requests + `z.infer` types (EH-16, DRY-33)

In `engine/ipc/protocol.ts`:
- `TaskReviewRequestSchema = z.custom<TaskReviewRequest>(isRecord)` (line 29) is the
  weakest — replace with a real object schema. A `TaskReviewRequestSchema` shape already
  exists in `engine/events/schema.ts` as the `taskReviewRequestFields` object literal used
  by `task_review_needed`. **Export** that field map from `schema.ts`
  (`export const taskReviewRequestFields = { … } as const;` — it is already declared
  `as const`, just add `export`) and build the protocol schema from it:
  ```ts
  import { taskReviewRequestFields } from '../events/schema.js';
  const TaskReviewRequestSchema = z.object(taskReviewRequestFields).passthrough();
  ```
  This makes the IPC `task_review` request validate the same shape the engine emits.
- `TieredApprovalRequestSchema = z.custom<TieredApprovalRequest>(…)` (lines 25-27): the
  real shape `TieredApprovalRequestShape` is already defined directly above it (lines
  17-23). Replace the `z.custom` indirection with the shape itself:
  `const TieredApprovalRequestSchema = TieredApprovalRequestShape;` (it already
  `safeParse`s the same object; this removes the boolean-collapsing `z.custom`).
- The `user_edit_conflict` request uses `conflict: z.custom<UserEditConflict>(isRecord)`
  (line 42). Build a real `UserEditConflictSchema` from the shared enums (reuse the
  `userEditConflictSchema` already defined in `engine/events/schema.ts` — **export** it
  there and import it here), so the IPC conflict payload validates structurally:
  ```ts
  import { userEditConflictSchema } from '../events/schema.js';
  // …
  conflict: userEditConflictSchema,
  ```
  (`userEditConflictSchema` in schema.ts already covers `kind`, `files`,
  `affectedTaskIds`, `fileConflicts`, `safeToContinue`, `availableActions` with
  `.passthrough()`.)
- **DRY-33 type derivation:** `ServerMessageSchema` is a real discriminated union and a
  matching hand-written `ServerMessage` union (lines 145-150) duplicates it. Replace the
  hand-written `ServerMessage` with `export type ServerMessage = z.infer<typeof ServerMessageSchema>;`
  Verify the inferred type matches: `payload: EngineEvent` now flows from
  `EngineEventSchema`; `mode: WorkflowMode` from `WorkflowModeSchema`. Keep
  `IpcPromptRequest`, `IpcPromptRequestInput`, `IpcPromptResponse`, `ClientMessage`
  hand-written **for now** — `IpcPromptResponse`/`ClientMessage` are parsed by the manual
  `parseIpcPromptResponse`/`parseClientMessage` switch functions (not by a Zod schema), so
  they are not dual-defined; deriving them would require building response schemas, which
  is out of scope. `IpcPromptRequestInput` is an `Omit`-derived type with no schema twin.
  Only derive `ServerMessage`, where a complete schema twin already exists. `parseServerMessage`
  already uses `ServerMessageSchema.safeParse` — leave it.
  - **Fallback for `ServerMessage`:** tightening the three request schemas changes the
    nested types in `z.infer<typeof ServerMessageSchema>` while `IpcPromptRequest` stays
    hand-written. This should still compile (the passthrough request shapes are assignable
    to the named types). If deriving `ServerMessage` via `z.infer` fights the typecheck,
    leave `ServerMessage` hand-written — DRY-33 is already satisfied by the existing
    `safeParse` plus the request-schema tightening (EH-16). Do not block on it.
- After these changes, `isRecord` may still be used by `parseClientMessage`/
  `parseIpcPromptResponse`; keep imports that remain referenced, drop those that don't.

### 11. `drift.ts`: `isDriftReport` via `DriftReportSchema.safeParse` (DRY-42)

Replace the hand-rolled body (lines 36-46) with:
```ts
export function isDriftReport(value: unknown): value is DriftReport {
  return DriftReportSchema.safeParse(value).success;
}
```
Consumers: `engine/export/collect.ts:105` and `engine/orchestrator/drift/drift.ts:164`
call `isDriftReport(raw)` then use the value as `DriftReport`. `DriftReportSchema` is
stricter than the old guard (it also validates `findings` element shape, `score` finite,
`briefHash` nullable) — this is the intended tightening. Confirm both call sites still
typecheck (they treat the narrowed value as `DriftReport`, which the predicate guarantees).

### 12. `mcp/handlers.ts`: collapse the identical param schemas (DRY-76)

Lines 21-22 define `JsonRpcParamsSchema` and `ToolArgumentsSchema` as the **byte-identical**
`z.record(z.string(), z.unknown()).optional().nullable().transform(value => value ?? {})`.
Replace both with one:
```ts
const JsonRpcRecordSchema = z.record(z.string(), z.unknown()).optional().nullable().transform(value => value ?? {});
```
Update both use sites — `JsonRpcParamsSchema.safeParse(msg['params'])` (line 71) and
`ToolArgumentsSchema.safeParse(params['arguments'])` (line 156) — to use
`JsonRpcRecordSchema`. Keep the variable name descriptive; do not change behavior.

### 13. `review-packet.ts`: import the byte-identical canonical enums (DRY-43, scoped)

`review-packet.ts` already imports many canonical enums from `./enums.js` and
`./snapshot.js`. The remaining **re-inlined** enums that have an identical canonical twin:

- `ReviewPacketDriftFindingSchema.severity` (line 186): `z.enum(['info', 'warning', 'error'])`
  → import `DriftSeveritySchema` from `./drift.js` and use it.
- `ReviewPacketDriftFindingSchema.code` (line 187): `z.string()` → `DriftCodeSchema` from
  `./drift.js` (the canonical drift code enum). This **tightens** the packet's drift
  `code` to the known set, matching the engine's `DriftFinding`.

Add `import { DriftSeveritySchema, DriftCodeSchema } from './drift.js';`

**Bounded exclusions — each verified against the codebase, not asserted.** The audit's
DRY-43 fix text also says "+ `EvidenceDecisionRecordSchema`" and lists "(+ summary/drift/
evidence)". Here is why each remaining inline shape is **left as-is**, with the evidence so
the validator sees reasoning:

- **`EvidenceDecisionRecordSchema` does not exist.** A repo-wide grep
  (`grep -rn 'EvidenceDecisionRecord\|DecisionRecordSchema' src`) returns nothing — the
  audit named a schema that was never created. The closest real schemas are
  `EvidenceApprovalSchema` (evidence.ts:15-22) and `EvidenceRejectionSchema`
  (evidence.ts:5-12), and they are **not exported** and are **not byte-identical** to the
  review-packet approvals/rejections (lines 167-182): evidence uses
  `tier: z.literal('confirm')` / `z.enum(['sticky','confirm'])`, while the review-packet
  deliberately uses `tier: z.string()` (it serializes arbitrary persisted approval-log
  tiers). Unifying these would require creating a new exported schema *and* reconciling a
  divergent `tier` type on a persisted contract — out of B03's finding scope and risky.
  **Leave the review-packet approvals/rejections inline.**
- **Final-review-status diverges (4 vs 3 members).** review-packet line 327 is
  `z.enum(['written', 'failed', 'missing', 'skipped'])`; the canonical
  `EvidenceFinalReviewStatusSchema` (evidence.ts:54) is `z.enum(['written', 'failed', 'skipped'])`
  — review-packet adds `'missing'`. They are **not** equal, so line 327 cannot adopt the
  canonical schema without changing members. **Leave line 327.** (Note: lines 155, 165, 328
  already correctly use the canonical `EvidenceFinalReviewStatusSchema` for the *evidence*
  status fields — those are fine and untouched.)
- **Recovery-outcome enums diverge.** `ReviewPacketRecoveryOutcomeSchema.status` (line 263)
  uses `skipped`/`resumed`/`failed`/`unresolved`; the engine's `recovery_resolved` outcome
  (schema.ts:167) uses `skipped-current-task`; `entry-types.ts:43` uses
  `skipped-current-task`/`blocked`. Different member sets per artifact — forcing one tuple
  changes the persisted contract. **Leave lines 243, 263.**
- **Snapshot-phase / checkpoint-kind / readiness-status** (lines 105, 108, 49): the only
  near-twin is `PhaseSchema`, which has 15 members (vs the 4 review-packet checkpoint
  phases) — not interchangeable. No exported twin exists. **Leave them.**

DRY-43 is therefore satisfied by importing the two drift enums that **do** have an
identical exported canonical twin (`DriftSeveritySchema`, `DriftCodeSchema`). Do not invent
new shared enums for the review-packet-only shapes.

### 14. Final pass

Run `npm run typecheck` and fix any dead imports the changes surfaced (especially in
`types.ts`, `routing-fields.ts`, `server-args.ts`, `protocol.ts`). Run `npm run lint`
(`biome check`) and `npm run format` if B01's formatter flags the new tuples (it should
not, but keep the file biome-clean). Then run the affected test globs (Tests section).

## Out of scope (owned elsewhere — do NOT touch)

- `core/layout/event-types.ts` / the `LayoutEvent` mirror, and the whole `core/layout/`
  tree → **owned by B09** (D7 deletes `LayoutEvent` and relocates `core/layout`). Do not
  single-source or edit `LayoutEvent` here.
- `tsconfig.json`, `biome.json`, `scripts/check-invariants.ts`, the `assertNever`
  exhaustiveness switches, the stray `!`/broad `as` fixes, `TaskIdSchema`-consistency for
  `taskId` fields in `review-packet.ts`/`drift.ts`/`summary.ts`/`drift-chain.ts`
  (audit TS-07), the dual-vocab alias removals → **owned by B02**. (B02 may also edit
  `review-packet.ts` for TS-07 `taskId` brands and `stores/navigation/router.ts`,
  `core/state/machine.ts` switches — those are B02's lines; B03 only touches the drift
  enums there.)
- `stores/project/config.ts` `as Config` casts (TS-05) → **B02**.
- `engine/runners/factory.ts` switch/agent-sdk error/signatures → **B02/B05/B07**.
- `providers/pricing.ts` `parseUsage`/`TokenUsageLikeSchema` re-enumeration (DRY-28) and
  the `anthropic/stream.ts`/`models-dev.ts`/`openrouter.ts` usage parsers → **B12**. B03
  only adopts the existing `TokenUsageLikeSchema` in `output-parsers.ts`; it does **not**
  refactor the provider-side `parseUsage`.
- `evidence/review-packet/{sections,build}.ts` readiness/artifact dedup and SRP splits
  (DRY-22, SRP-08) → **B12/B10**.
- `engine/ipc/replay.ts` reader policy (D3, DRY-34), `ipc/protocol.ts` is B03 but the
  **D3 JSON-reader policy** for replay/persistence is **B05/B12**; B03 does not change
  reader policy, only protocol type/schema single-sourcing.
- The 14 dead `z.infer` aliases + knip/ts-prune gate (DC-18) → **B14**. Do not delete
  unused `z.infer` exports here; if your changes leave a newly-unused export, prefer
  keeping it (B14 sweeps dead code after adoption) unless lint/`noUnusedLocals` forces
  removal of a *local* (non-exported) symbol.
- `RunnerOverrides` folding, `recovery-outcome` enum unification, snapshot/readiness
  review-packet-local enums → explicitly **not in scope** (see steps 9, 13).

## Acceptance criteria

- [ ] Every finding ID above (TS-03, TS-04, TS-08, TS-09, TS-11, EH-16, DRY-01, DRY-02,
  DRY-10, DRY-33, DRY-42, DRY-43, DRY-76) is addressed in the code.
- [ ] `type EngineEvent` is `z.infer<typeof EngineEventSchema>` (no hand-written union in
  `events/types.ts`); `EngineEventSchema` is a `z.discriminatedUnion` (no `z.custom`
  wrapper); `parseEngineEvent` calls `EngineEventSchema.safeParse` and returns structured
  data or `null`. `ValidationStages`, `EngineEventOf`, `EventSink`, `EventBus` remain
  exported from `types.ts`.
- [ ] `parseEngineEvent` still: accepts a valid `task_completed` event, rejects unknown
  `type`, and rejects a known type missing required fields (the three existing cases in
  `schema.test.ts` pass unchanged).
- [ ] `USER_EDIT_CONFLICT_KINDS`, `USER_EDIT_CONFLICT_ACTIONS`, `TASK_CONTEXT_FITS`,
  `CURRENT_CODE_CONTEXT_MODES` (and their `*Schema` + `z.infer` types) exist in
  `core/schemas/enums.ts`; `schema.ts`, `workflow-events.ts`, `tokens.ts`, and `summary.ts`
  consume them — no inline `z.enum(['fits',…])` or `z.enum(['none','whole-file',…])` copy
  survives in any of those files (`summary.ts:100` uses `z.enum([...TASK_CONTEXT_FITS, 'unknown'])`,
  preserving its `'unknown'` member). `workflow-events.ts` re-exports the four types so
  existing importers compile unchanged.
- [ ] `HOOK_EVENTS` is the single source; `HookEventSchema = z.enum(HOOK_EVENTS)` and
  `HOOK_EVENT_KEYS = new Set(HOOK_EVENTS)` (transform.ts) both derive from it.
- [ ] `RoutingEventFields` is a `Pick<RoutingDecision, …>`; `buildRoutingEventFields`
  callers in `task/pre-task.ts` still compile.
- [ ] `output-parsers.ts` `usage` fields use `TokenUsageLikeSchema`; stream parsing
  behavior (text/tool/usage extraction) unchanged.
- [ ] `IpcServerArgs` and `CLIOverrides` derive via `z.infer`; `parseIpcServerArgs` uses
  `safeParse`; legacy `mode` (`full`→`speckit`) still normalizes; unknown override keys are
  stripped (not crash). `readIpcServerArgsFile` still throws on invalid input.
- [ ] `protocol.ts`: `task_review`, `tiered_approval`, and `user_edit_conflict` requests
  use real object schemas (no `z.custom`); `ServerMessage` derives via `z.infer`.
- [ ] `isDriftReport` delegates to `DriftReportSchema.safeParse`; `export/collect.ts` and
  `drift/drift.ts` consumers compile.
- [ ] `mcp/handlers.ts` has one shared record schema for params + tool arguments.
- [ ] `review-packet.ts` drift `severity`/`code` use `DriftSeveritySchema`/`DriftCodeSchema`.
- [ ] No new `!` / broad `as` / `any` / barrels (no re-export-only `index.ts`) / non-Error
  classes / `useMemo`/`useCallback`/`React.memo`; every import keeps the `.js` extension;
  `engine/` imports nothing from `react`/`ink`/`src/features`/`src/components`/`src/hooks`;
  no decorative comments or section banners.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated where behavior changed — see the server-args
  strip-behavior note in step 9).

## Tests

```bash
npm test -- src/engine/events src/engine/ipc src/engine/streaming/output-parsers src/engine/mcp/handlers.test.ts src/core/schemas src/core/config/load src/engine/orchestrator/task/routing.test.ts src/engine/orchestrator/drift src/engine/orchestrator/final-review.test.ts src/engine/export
npm run typecheck
npm run lint
```

Note: there are no dedicated `summary.test.ts` / `review-packet.test.ts` / `drift.test.ts`
schema-unit tests; `final-review.test.ts` exercises the review-packet + drift schemas
end-to-end, and `enums.test.ts`/`hooks.test.ts` cover the enum/hook areas (neither
currently asserts on the specific enum members you single-source, so they should pass
unchanged). If `schema.test.ts` is where you add the optional `expectTypeOf` fallback,
include `src/engine/events/schema.test.ts` (already inside the `src/engine/events` glob).
