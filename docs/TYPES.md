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
| **Examples** | `Config`, `Task`, `Session`, `WorkflowState`, `ModelsDevCatalog` | `EngineEvent` union, `RunnerRuntime` interface, `OrchestratorCallbacks`, branded `TaskId` nominal type, React prop types |

Zod schemas are the primary source of truth for every data shape that crosses a runtime boundary — anything written to disk, sent over HTTP, parsed from LLM output, or exchanged between subprocess and parent. These are not TypeScript types that happen to have validators; they are schemas, and their TypeScript type is a byproduct of calling `z.infer<typeof X>`.

TypeScript types exist for things that cannot be expressed as runtime-checkable schemas:
- Function types (`(x: T) => Promise<U>`)
- Generics with runtime-impossible constructs (mapped types, conditional types)
- Branded IDs used as nominal types (`type TaskId = string & { __brand: 'TaskId' }`)
- Discriminated unions of React component props
- Type-level utilities used only by inference

**`z.infer<>` types live in the same file as the schema.** Do not split `TaskSchema` and `type Task = z.infer<typeof TaskSchema>` across two files. They are one concept.

---

## Three-case rule — where does a TypeScript type go?

For any TS-only type (not a Zod schema), the placement depends on who uses it.

### Case A — one file uses it

**Inline into that file.**

```ts
// src/stores/navigation/router.ts
type Screen = 'home' | 'workflow' | 'summary' | 'setup';
type InputMode = 'default' | 'review' | 'question';
// ... types used only by this file live here, not in a separate *-types.ts
```

Why: the only consumer holds the contract. Moving it one file away adds indirection for zero benefit.

### Case B — multiple files in the same folder use it

**Create `types.ts` in that folder.**

```
src/core/slash-commands/
├── catalog.ts          # defines available slash commands
├── dispatch.ts         # runs them
├── keybindings.ts      # maps keys to commands
└── types.ts            # SlashCommandDef, CommandContext, CommandPaletteItem
                          — used by catalog.ts, dispatch.ts, keybindings.ts
```

Why: shared intra-folder contract. Folder name provides the naming context (`slash-commands/`) so the file is just `types.ts` — no prefix, no suffix.

**Banned**: `*-types.ts` suffix (e.g., `slash-command-types.ts`) — redundant, the folder already says the domain.

### Case C — cross-folder consumers

**Place the type with its producer** — the file that creates values of this type. Consumers `import type` from there.

```ts
// src/engine/skills/discovery.ts — produces SkillMeta
export interface SkillMeta { id: string; title: string; ... }
export async function discoverSkills(dir: string): Promise<SkillMeta[]> { ... }
```

```ts
// src/stores/project/skills.ts — consumes SkillMeta
import type { SkillMeta } from '../../engine/skills/discovery.js';
```

Why: the producer defines the contract; consumers conform. Putting the type anywhere else creates orphaned contracts.

### Exception — genuinely cross-cutting types

A type stays in `src/core/types/` only if it meets **both** criteria:

- Fan-in > 30 files
- Consumers span ≥3 top-level folders (e.g., `engine/` + `features/` + `stores/`)

Currently three files qualify (TS-only, no Zod schema):

- `core/types/config-options.ts` — `DetectedModel`, `WorkflowOpts`, `PlannerDetection`, `ProviderDetection`, `PlannerTool`
- `core/types/state-actions.ts` — `StateAction`, `TokenBudget`, `CodeContext`, `ProjectContext`
- `core/types/summary.ts` — `ImplementerResult`, `ValidationResult`

Inferred counterparts (`Config`, `Task`, `WorkflowState`, `Summary`, `TokenUsage`, etc.) live beside their Zod schema in `core/schemas/`. `z.infer` is forbidden inside `core/types/`.

Everything else moves to Case A/B/C.

---

## Screaming types

Types should live where their domain meaning is created — not in a central `types/` grab-bag.

| Type | Old home | New home | Why |
|---|---|---|---|
| `EngineEvent` | n/a (new) | `engine/events/types.ts` | Single source of truth for every engine event; workflow sub-stores and all sinks consume it directly |
| `EventBus`, `EventSink` | n/a (new) | `engine/events/types.ts` | Declared alongside `EngineEvent`; ports for `createEventBus()` and sink subscribers |
| `RunnerRuntime`, `ToolUseInfo`, `ParsedLine`, `InvokeResult` | `core/types/runner.ts` | `engine/runners/types.ts` | Created by the runner factory — runner-domain |
| `SkillMeta` | `core/types/app.ts` | `engine/skills/discovery.ts` (inline) | Produced by `discoverSkills`, consumed everywhere |
| `ThemeColors` | `core/types/theme.ts` | `components/theme.tsx` (inline) | Only used by the theme component |
| `SidebarTask` | `core/types/app.ts` | `features/workflow/components/sidebar.tsx` (inline) | Single consumer |
| `Screen`, `InputMode`, `OverlayType` | `core/types/app.ts` | `stores/navigation/router.ts` (inline) | Single consumer |
| `SlashCommandDef`, `CommandContext`, `CommandPaletteItem` | `core/types/app.ts` | `core/slash-commands/types.ts` | Multiple files in one folder |

**Banned anti-patterns:**

- ❌ `src/types.ts` or `src/types/` as a top-level dumping ground
- ❌ Feature-scoped types in `src/core/types/`
- ❌ `*-types.ts` suffix when the folder name already implies the domain
- ❌ A `core/types/app.ts` kitchen-sink grouping unrelated types

**Removed in the 2026-04-19 uplift:**

| Type | Status |
|---|---|
| `TuiEvent` (formerly `features/workflow/types.ts`) | Removed. The workflow store consumes `EngineEvent` directly. Use `EngineEvent` from `engine/events/types.ts`. |
| `OrchestratorEvent`, `OrchestratorEventPayloadMap` (formerly `engine/orchestrator/events.ts` / `core/types/orchestrator-events.ts`) | Removed. Replaced by `EngineEvent`. |

---

## Schemas — `src/core/schemas/`

All Zod validators live in this folder at the top of `core/`. Flat — no subfolders (the folder is itself cohesive: "runtime data shapes").

```
src/core/schemas/
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
└── models-dev.ts          # models.dev catalog — remote JSON boundary
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
import type { SkillMeta } from '../../engine/skills/discovery.js';

// ❌ value import — loads discovery.ts at runtime even if you only need the type
import { SkillMeta } from '../../engine/skills/discovery.js';
```

This matters in this project because:
- The codebase is ESM without a bundler
- Every top-level `import` triggers module evaluation
- Cross-layer boundaries (engine → features type imports) must stay erasable to keep layer discipline at runtime

### When a type crosses a layer boundary

`engine/` is not allowed to import runtime values from `features/` (that would invert the layer). But `import type` from `features/` into `engine/` is allowed — types are erased and do not create a runtime dependency.

Example from this codebase:
```ts
// features/workflow/components/event-cards/event-card.tsx renders engine events
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
| `<folder>/types.ts` with two files `z.infer`d from a schema | ✅ | Accept — the schema's inferred type is still allowed to live elsewhere if the folder genuinely owns the type |
| `<folder>/<name>-types.ts` | ❌ | Suffix duplicates the folder's domain |
| `<folder>/<name>.types.ts` | ❌ | Same as above, different punctuation |
| `src/types.ts` | ❌ | Top-level dumping ground |
| `src/types/<name>.ts` | ❌ | Outside `src/core/types/` (which is reserved for truly cross-cutting types) |
| Inline into consumer file | ✅ | Case A — one consumer |

---

## Worked examples

**Q: I'm adding a `ReviewAction` type used only by `features/workflow/review-parser.ts`.**
A: Inline into `review-parser.ts` (Case A).

**Q: I'm adding a `PlannerDetection` type used by three files inside `engine/detection/`.**
A: `engine/detection/types.ts` (Case B).

**Q: I'm adding a `ProviderMetadata` type created by `engine/providers/metadata.ts` and consumed by `engine/catalog/registry.ts` + `stores/discovery/model-cache.ts`.**
A: Inline in `engine/providers/metadata.ts` (the producer). Consumers `import type`. (Case C)

**Q: I'm adding a Zod schema for a new config section.**
A: `src/core/schemas/config.ts` (or a new file in `core/schemas/` if the shape is large). Export both `SectionSchema` and `type Section = z.infer<typeof SectionSchema>`.

**Q: I'm adding a 5-arm discriminated union for some new UI event.**
A: Is it persisted (written to session log, IPC, etc.)? → schema (`core/schemas/`). Is it in-memory only (engine → UI bus)? → TS type. Place per three-case rule.

**Q: Can I put `type Foo` and `type Bar` (unrelated) in the same `types.ts` because they are both used across my folder?**
A: Yes — that is what `types.ts` is for. The folder is the naming context.

**Q: Should I create `src/types/` for types used by many places?**
A: No. Use `src/core/types/` only for types meeting the exception threshold (fan-in > 30, ≥3 top-level folders). Most "shared types" actually have a producer and should live there.

---

## Anti-pattern gallery

### Central `types/` grab-bag

```ts
// ❌ src/core/types/app.ts before the 2026-04 restructure
export type Screen = 'home' | 'workflow' | ...;
export interface SlashCommandDef { ... }
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
