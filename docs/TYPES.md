# Type Placement

Where TypeScript types and Zod schemas live. This is the **type analogue** of [LAYERS.md](./LAYERS.md) (which governs runtime code) and [STRUCTURE.md](./STRUCTURE.md) (which governs file-tree shape).

If you are adding a type or moving one, this is the authority.

---

## The split that matters most: runtime vs compile-time

Two kinds of "types" exist in this codebase:

| | Zod schemas | TypeScript types |
|---|---|---|
| **What** | Runtime validators (`z.object({ id: z.string() })`) | Compile-time declarations (`interface`, `type`, `enum`) |
| **Lives at runtime?** | Yes — emitted to JS, runs in the bundle | No — erased by `tsc` |
| **Lives where** | `src/core/schemas/` | With its consumer (see three-case rule below) |
| **Source of truth for data shapes?** | Yes — types are derived via `z.infer<>` | Only for TS-only concepts (functions, generics, branded IDs, discriminated unions of React components) |
| **Examples** | `Config`, `Task`, `Session`, `WorkflowState`, `ModelsDevCatalog`, `EngineEventSchema` (persisted to `session.jsonl`) | `RunnerRuntime` interface, `OrchestratorCallbacks`, branded `TaskId` nominal type, React prop types |

Zod schemas are the primary source of truth for every data shape that crosses a runtime boundary — anything written to disk, sent over HTTP, parsed from LLM output, or exchanged between subprocess and parent. These are not TypeScript types that happen to have validators; they are schemas, and their TypeScript type is a byproduct of calling `z.infer<typeof X>`.

TypeScript types exist for things that cannot be expressed as runtime-checkable schemas:
- Function types (`(x: T) => Promise<U>`)
- Generics with runtime-impossible constructs (mapped types, conditional types)
- Branded IDs used as nominal types (`type TaskId = string & { __brand: 'TaskId' }`)
- Discriminated unions of React component props
- Type-level utilities used only by inference

**`z.infer<>` types live in the same file as the schema.** Do not split `TaskSchema` and `type Task = z.infer<typeof TaskSchema>` across two files. They are one concept.

**Carve-out — `EngineEvent`.** The type-dispatched schema is `EngineEventSchema` in `src/engine/events/schema.ts`; its inferred alias `EngineEvent = z.infer<typeof EngineEventSchema>` is declared one file over in `src/engine/events/types.ts`, alongside the schema-less `EventBus` / `EventSink` ports it travels with. This is the one sanctioned split: the event ports have no Zod backing and over a hundred consumers import the alias and the ports as a single `events/types.js` contract. The alias is still derived from the schema — never hand-written — so the two files cannot drift.

---

## Three-case rule — where does a TypeScript type go?

For any TS-only type (not a Zod schema), the placement depends on who uses it.

### Case A — one file uses it

**Inline into that file.**

```ts
// src/core/navigation/types.ts
export type Screen = 'home' | 'workflow' | 'summary' | 'setup';
export type InputMode = 'normal' | 'review' | 'question';
// ... types used only by this file live here, not in a separate *-types.ts
```

Why: the only consumer holds the contract. Moving it one file away adds indirection for zero benefit.

### Case B — multiple files in the same folder use it

**Create `types.ts` in that folder.**

```
src/core/runtime/commands/
├── registry.ts         # defines available runtime commands
├── dispatch.ts         # runs them
├── lookup.ts           # exact + fuzzy lookup
└── types.ts            # RuntimeCommandDef, RuntimeCommandContext, CommandPaletteItem
                          — used by registry.ts, dispatch.ts, lookup.ts
```

Why: shared intra-folder contract. Folder name provides the naming context (`runtime/commands/`) so the file is just `types.ts` — no prefix, no suffix.

**Banned**: `*-types.ts` suffix (e.g., `runtime-command-types.ts`) — redundant, the folder already says the domain.

### Case C — cross-folder consumers

**Place the type with its producer** — the file that creates values of this type. Consumers `import type` from there.

```ts
// src/core/skills/types.ts — shared SkillMeta contract
export interface SkillMeta { id: string; name: string; description: string; path: string; scope: 'global' | 'project'; }
```

```ts
// src/engine/skill-discovery.ts — produces SkillMeta values
import type { SkillMeta } from '../core/skills/types.js';
```

Why: if producers and stores/features both consume the type, place the contract in `core/` so lower layers do not import from `engine/`.

### Exception — genuinely cross-cutting types

A type stays in `src/core/types/` only if it meets **either** the cross-cutting bar or a documented carve-out:

- **Cross-cutting bar** — fan-in is broad (tens of consumers) and spans ≥3 top-level folders (e.g., `engine/` + `features/` + `stores/`).
- **Carve-out** — a small boundary shape that no single folder owns. It is the contract for an option bag or reference that is constructed at the CLI/entry edge and threaded through many downstream files, with no natural producer folder to host it.

The current residents (TS-only, no Zod schema):

- `core/types/config-options.ts` — `WorkflowOpts`, the CLI/run option bag (many consumers under `cli/`; carve-out — no single folder owns the option contract). The provider-detection types `DetectedModel` / `PlannerDetection` / `ProviderDetection` live in the domain module `core/discovery/detection.ts`, not here.
- `core/types/session-ref.ts` — `SessionRef`, the `{ projectDir, sessionId }` handle threaded across `cli/` + `engine/` (carve-out — a cross-folder reference with no producer folder).

Inferred counterparts (`Config`, `Task`, `WorkflowState`, `Summary`, `TokenUsage`, etc.) live beside their Zod schema in `core/schemas/`. `z.infer` is forbidden inside `core/types/`.

Everything else moves to Case A/B/C.

---

## Screaming types

Types should live where their domain meaning is created — not in a central `types/` grab-bag.

| Type | Old home | New home | Why |
|---|---|---|---|
| `EngineEventSchema` (type-dispatched union) | n/a (new) | `engine/events/schema.ts` | The type-indexed schema contract is the source of truth for every engine event; persisted to `session.jsonl` and validated by `parseEngineEvent` |
| `EngineEvent` (alias) | n/a (new) | `engine/events/types.ts` | `z.infer<typeof EngineEventSchema>`, carved out next to the event ports (see the colocation carve-out above); workflow sub-stores and all sinks consume it directly |
| `EventBus`, `EventSink` | n/a (new) | `engine/events/types.ts` | Declared alongside the `EngineEvent` alias; schema-less ports for `createEventBus()` and sink subscribers |
| `WorkflowCancelReason`, `WORKFLOW_CANCEL_REASONS` | `engine/orchestrator/types.ts` | `engine/events/workflow-cancel.ts` | Workflow cancellation is an engine event contract used by both schema validation and orchestrator abort handling; keeping it with events avoids schema → orchestrator ownership imports |
| `RunnerCallEventSchema`, `RunnerCallResultSchema` | n/a (new) | `engine/calls/schema.ts` | Source of truth for normalized runner/backend call values crossing parser, provider, persistence, replay, IPC, hooks, OTel, RPC, and explicit `InvokeResult` projections |
| `RunnerRuntime`, `ToolUseInfo`, `ParsedLine`, `InvokeResult` | `core/types/runner.ts` | `engine/runners/types.ts` | Created by the runner factory — runner-domain |
| `SkillMeta` | `core/types/app.ts` | `core/skills/types.ts` | Produced by `engine/skill-discovery.ts`, consumed by stores/features without importing `engine/` |
| `Screen`, `InputMode`, `OverlayType` | `core/types/app.ts` | `core/navigation/types.ts` | Cross-cutting: many consumers across `app/` + `components/` + `core/` + `features/` + `stores/`. Also exports the runtime value `ALL_SCREENS` (tolerated under Case B — a folder `types.ts` co-located with the screaming type) |
| `RuntimeCommandDef`, `RuntimeCommandContext`, `CommandPaletteItem` | `core/types/app.ts` | `core/runtime/commands/types.ts` | Multiple files in one folder |

**Banned anti-patterns:**

- ❌ `src/types.ts` or `src/types/` as a top-level dumping ground — the ban targets first-party `.ts` type buckets, not `.d.ts` ambient declarations (e.g. `src/types/anthropic-agent-sdk.d.ts`, which augments a third-party module with no shipped types, is fine)
- ❌ Feature-scoped types in `src/core/types/`
- ❌ `*-types.ts` suffix when the folder name already implies the domain
- ❌ A `core/types/app.ts` kitchen-sink grouping unrelated types

**Removed in the 2026-04-19 release:**

| Type | Status |
|---|---|
| `TuiEvent` (formerly `features/workflow/types.ts`) | Removed. The workflow store consumes `EngineEvent` directly. Use `EngineEvent` from `engine/events/types.ts`. |
| `OrchestratorEvent`, `OrchestratorEventPayloadMap` (formerly `engine/orchestrator/events.ts` / `core/types/orchestrator-events.ts`) | Removed. Replaced by `EngineEvent`. |

---

## Schemas — `src/core/schemas/`

`core/schemas/` is the home for **cross-cutting** boundary shapes — the validators that many folders consume (`Config`, `Task`, `Session`, `WorkflowState`, and friends). It sits at the top of `core/` and is flat — no subfolders (the folder is itself cohesive: "runtime data shapes"). A narrowly-scoped schema used by exactly one folder may instead colocate with that folder (e.g. `core/sessions/tree/schemas.ts`, `core/config/runtime/overrides.ts`) rather than being hoisted here.

```
src/core/schemas/          # ~29 files — representative subset below (non-exhaustive)
├── config.ts              # ConfigSchema + Config type
├── enums.ts               # PlannerKind, ImplementerKind, Mode enums
├── implementer-config.ts
├── planner-config.ts
├── runner-fields.ts
├── task.ts                # TaskSchema + Task type + TaskIdSchema (branded)
├── tokens.ts
├── workflow.ts
├── session.ts
├── session-log.ts         # SessionLog entries (JSONL)
├── summary.ts
├── question.ts
├── models-dev.ts          # models.dev catalog — remote JSON boundary
└── …                      # analyze, drift, evidence, recovery, snapshot, stats, hooks, … (flat, no subfolders)
```

**Inferred types co-locate with their schema.** Each file exports the schema *and* the inferred type:

```ts
// src/core/schemas/task.ts
import { z } from 'zod';

export const TaskSchema = z.object({
  id: TaskIdSchema,
  description: z.string(),
  tests: z.array(z.string()),
  // ...
});

export type Task = z.infer<typeof TaskSchema>;
```

Consumers import whichever they need (or both). They do **not** import `Task` from one place and `TaskSchema` from another.

**Enforcement — `core/types/` MUST NOT contain `z.infer`.** Inferred types live next to their schema in `core/schemas/`. `core/types/` is only for TS-only types with no runtime schema backing (e.g., `StateAction`, `ProjectContext`, `WorkflowOpts`). Anything derived from a Zod schema via `z.infer<>` belongs in the schema file.

**Why the folder is flat**: schemas are a cohesive cross-cutting concern. Grouping them further (e.g., `schemas/config/` vs `schemas/workflow/`) adds depth without separating unrelated things — every consumer of one schema tends to consume others. Flat beats fake hierarchy.

---

## Import patterns

### Import type vs import

For types that cross module boundaries, prefer `import type` so the import is erased at runtime:

```ts
// ✅ type-only import — does not pull the module into the runtime graph
import type { SkillMeta } from '../../core/skills/types.js';

// ❌ value import — loads a runtime module even if you only need the type
import { SkillMeta } from '../../core/skills/types.js';
```

This matters in this project because:
- The codebase is ESM without a bundler
- Every top-level `import` triggers module evaluation
- Cross-layer boundaries (engine → features type imports) must stay erasable to keep layer discipline at runtime

### When a type crosses a layer boundary

`engine/` is not allowed to import runtime values from `features/` (that would invert the layer). But `import type` from `features/` into `engine/` is allowed — types are erased and do not create a runtime dependency.

Example from this codebase:
```ts
// features/workflow/components/event-cards/operation-status.tsx renders operation state derived from engine events
import type { EngineEvent } from '../../../../engine/events/types.js';
```

This is allowed because:
1. The type is erased — no runtime import
2. The contract is owned by the producer (`engine/events/`) because `EngineEvent` is the single source of truth for workflow events
3. UI conforms to the engine's event shape — the reverse direction (engine importing from features) is banned by the layer rule

If it turns out a value (constant, helper fn) from `features/workflow/` is needed in `engine/`, that's a signal the value should move to a neutral location — `core/` or extracted to a shared module.

---

## Banned file names for types

| Name | Verdict | Reason |
|---|---|---|
| `<folder>/types.ts` | ✅ | Folder context provides the domain |
| `<folder>/types.ts` with `z.infer`d schema types | ❌ | Inferred schema types must live beside their schema owner |
| `<folder>/<name>-types.ts` | ❌ | Suffix duplicates the folder's domain |
| `<folder>/<name>.types.ts` | ❌ | Same as above, different punctuation |
| `src/types.ts` | ❌ | Top-level dumping ground |
| `src/types/<name>.ts` | ❌ | Outside `src/core/types/` (which is reserved for truly cross-cutting types) |
| `src/types/<name>.d.ts` (ambient module declaration) | ✅ | Augments a third-party module with no shipped types |
| Inline into consumer file | ✅ | Case A — one consumer |

---

## Worked examples

**Q: I'm adding a `ReviewAction` type used only by `features/workflow/review-parser.ts`.**
A: Inline into `review-parser.ts` (Case A).

**Q: I'm adding a `PlannerDetection` type produced in `core/discovery/detection.ts` and consumed across `engine/detection/`, `stores/project/`, and `features/runners/`.**
A: Keep it with its producer in `core/discovery/detection.ts`; cross-folder consumers `import type` from there. (Case C — placing the contract in `core/` keeps `engine/`/`stores/`/`features/` from importing each other.)

**Q: I'm adding a `ProviderMetadata` type created by `engine/providers/metadata.ts` and consumed by `engine/providers/registry.ts` + `stores/discovery/model-cache.ts`.**
A: Inline in `engine/providers/metadata.ts` (the producer). Consumers `import type`. (Case C)

**Q: I'm adding a Zod schema for a new config section.**
A: `src/core/schemas/config.ts` (or a new file in `core/schemas/` if the shape is large). Export both `SectionSchema` and `type Section = z.infer<typeof SectionSchema>`.

**Q: I'm adding a 5-arm discriminated union for some new UI event.**
A: Is it persisted (written to session log, IPC, etc.)? → schema, with its `z.infer` alias colocated. Is it in-memory only? → TS type, placed per the three-case rule. Note the engine→UI bus union is *not* in-memory only: `EngineEvent` is the `z.infer` of `EngineEventSchema` (`engine/events/schema.ts`) because engine events cross protected persistence/replay boundaries such as `session.jsonl`, IPC, stdout JSON, and RPC.

**Q: Can I put `type Foo` and `type Bar` (unrelated) in the same `types.ts` because they are both used across my folder?**
A: Yes — that is what `types.ts` is for. The folder is the naming context.

**Q: Should I create `src/types/` for types used by many places?**
A: No. Use `src/core/types/` only for types that clear the exception rule (the cross-cutting bar or a documented carve-out — see "Exception — genuinely cross-cutting types"). Most "shared types" actually have a producer and should live there.

---

## Anti-pattern gallery

### Central `types/` grab-bag

```ts
// ❌ src/core/types/app.ts before the 2026-04 restructure
export type Screen = 'home' | 'workflow' | ...;
export interface RuntimeCommandDef { ... }
export interface SidebarTask { ... }
export interface SkillMeta { ... }
export type CommandPaletteItem = { ... };
// ... six unrelated concepts in one file
```

Fix: split by consumer (see Screaming types table above).

### `*-types.ts` suffix

```
// ❌
src/stores/navigation/
├── router.ts
└── router-types.ts    # suffix is redundant; folder already says navigation

// ✅ — types used only by router.ts go inline
src/stores/navigation/
└── router.ts
```

### Splitting Zod schema from its inferred type

```ts
// ❌
// src/core/schemas/task.ts
export const TaskSchema = z.object({ ... });

// src/core/types/task.ts
import type { TaskSchema } from '../schemas/task.js';
export type Task = z.infer<typeof TaskSchema>;
```

Fix: both in `src/core/schemas/task.ts`.

### Mixing Zod and TS-only in one file

```ts
// ❌ src/core/types/app.ts
export type Screen = 'home' | 'workflow';          // TS-only
export const ScreenSchema = z.enum(['home', ...]); // Zod
export interface SkillMeta { ... }                 // TS-only
export const SkillMetaSchema = z.object({ ... });  // Zod
```

Fix: Zod → `core/schemas/`, TS-only → with producer or in consumer folder.

---

## References

- [LAYERS.md](./LAYERS.md) — runtime code layering
- [STRUCTURE.md](./STRUCTURE.md) — file tree and folder shape
- [NO-BARRELS.md](./NO-BARRELS.md) — why `index.ts` re-exports are banned
- [PRINCIPLES.md](./PRINCIPLES.md) — one-page index of all architectural rules
- [Zod Documentation](https://zod.dev/) — schema library
- [TypeScript — type-only imports](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html#type-only-imports-and-export)
