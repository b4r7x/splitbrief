# 05 — MRU Store + Custom Actions Config

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 05 of 5** — Command Palette spec, 2026-04-26.
Can run in parallel with Briefs 01 and 02. Brief 03 (palette component) depends on this brief's output.

## Intent

1. Create an in-memory MRU store at `src/stores/ui/palette-mru.ts` that Brief 03 reads and writes.
2. Extend `ConfigSchema` in `src/core/schemas/config.ts` to accept optional `palette.customActions`.
3. Extend `CommandContext` in `src/core/slash-commands/types.ts` if needed for custom action config access — only if Brief 03 needs it through the context object.

## Scope

**In bounds:**
- `src/stores/ui/palette-mru.ts` (new file)
- `src/stores/ui/palette-mru.test.ts` (new file)
- `src/core/schemas/config.ts` — add `PaletteCustomActionSchema`, `PaletteConfigSchema`, extend `ConfigSchema`

**Out of bounds:**
- Do not touch the palette component (Brief 03).
- Do not touch `src/core/paths.ts` (no new file paths — MRU is in-memory only, ADR-005).
- Do not add disk I/O for MRU.
- Do not change `CommandContext` unless Brief 03's implementation requires it. The component reads config directly from `configStore` for custom actions — the context object is not needed.
- Do not add npm dependencies.

## Code Context

Read before writing:

- `src/stores/ui/input-history.ts` — model for a simple in-memory list store with a `push` function (pattern to follow)
- `src/stores/create-store.ts` — understand `createStore` and `storeBase`
- `src/stores/use-stores.ts` — understand `useStores`
- `src/core/schemas/config.ts` — full file; understand existing optional top-level keys (`hooks`, `otel`, `codebase`) and how they follow the `z.object({...}).optional()` pattern

## Implementation Plan

### Part A — MRU Store

```ts
// src/stores/ui/palette-mru.ts

export const MAX_PALETTE_MRU = 20;

interface PaletteMruState {
  ids: string[];  // most-recently-used first
}

// record(id) prepends id to the list, deduplicates, and trims to MAX_PALETTE_MRU
// getRank(id) returns 1-based index in ids, or 0 if not present
```

Model after `input-history.ts`:

- `record(id: string): void` — prepend `id`, deduplicate (remove any existing occurrence), trim to `MAX_PALETTE_MRU`.
- `getRank(id: string): number` — returns `ids.indexOf(id) + 1`, or `0` if not found.
- `__testReset(): void` — test escape hatch (see `input-history.ts` pattern).

Export:

```ts
export const paletteMruStore = {
  ...storeBase(store),
  record,
  getRank,
  __testReset,
};
```

### Part B — Config Schema Extension

Add to `src/core/schemas/config.ts` (inside the module, before `ConfigSchema`):

```ts
const PaletteCustomActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  command: z.string().startsWith('/'),
});

const PaletteConfigSchema = z.object({
  customActions: z.array(PaletteCustomActionSchema).optional(),
});

export type PaletteCustomAction = z.infer<typeof PaletteCustomActionSchema>;
export type PaletteConfig = z.infer<typeof PaletteConfigSchema>;
```

Extend `ConfigSchema` with an optional `palette` field:

```ts
// Inside the ConfigSchema z.object({...}), add:
palette: PaletteConfigSchema.optional(),
```

The `Config` type is re-inferred from `ConfigSchema`, so `Config['palette']` becomes `PaletteConfig | undefined` automatically.

### YAML example (for docs/CONFIG.md — do not edit that file; this is reference only)

```yaml
palette:
  customActions:
    - id: "redo-t001"
      label: "Redo T001"
      description: "Re-run the first task"
      command: "/redo-task T001"
    - id: "speckit-mode"
      label: "Speckit mode"
      command: "/mode speckit"
```

### Part C — CommandContext (no change expected)

The palette component reads `config.palette?.customActions` directly from `configStore.useConfig()`. No changes to `CommandContext` are needed. If Brief 03's implementation requires a new method on `CommandContext`, add it here — but do not add speculatively.

## Validation

### Tests for MRU store (`src/stores/ui/palette-mru.test.ts`)

- `record('a')` → `ids = ['a']`
- `record('b')` then `record('a')` → `ids = ['a', 'b']` (most recent first)
- `record('a')` three times → `ids = ['a']` (deduplicated)
- Record 21 items → list capped at `MAX_PALETTE_MRU` (20)
- `getRank('a')` returns 1 when `'a'` is first in list
- `getRank('z')` returns 0 when `'z'` not in list
- `__testReset()` empties the list
- `use(s => s.ids)` in a React hook returns reactive updates (use Ink render test)

### Tests for config schema (`src/core/schemas/config.ts` — add to existing config test file if present)

Find and check for an existing config schema test:

```bash
find src -name "config.test.ts" | head -3
```

If one exists, add cases to it. If not, create `src/core/schemas/config.test.ts`:

- `ConfigSchema.parse(validConfig)` succeeds with `palette: undefined` (field omitted).
- `ConfigSchema.parse({ ...validConfig, palette: { customActions: [{ id: 'x', label: 'X', command: '/help' }] } })` succeeds.
- `ConfigSchema.parse({ ...validConfig, palette: { customActions: [{ id: '', label: 'X', command: '/help' }] } })` throws (id too short).
- `ConfigSchema.parse({ ...validConfig, palette: { customActions: [{ id: 'x', label: 'X', command: 'no-slash' }] } })` throws (command must start with `/`).
- Parsed type: `config.palette?.customActions?.[0]?.command` is typed as `string`.

## Constraints

- MRU is in-memory only — no file I/O, no paths in `src/core/paths.ts`.
- No `class` keyword.
- No barrel exports.
- ESM `.js` import suffixes.
- `PaletteConfigSchema` and `PaletteCustomActionSchema` are not exported as the main schema exports — only `PaletteCustomAction` and `PaletteConfig` types are exported (the schemas are module-internal Zod objects).
- `ConfigSchema` is backward-compatible: `palette` field is optional with no default.

## Escalation

If adding `palette` to `ConfigSchema` causes config migration tests to fail, it is because the migration logic does not carry the new optional field. Optional fields with no default require no migration — the field simply remains absent on old configs. If a migration test fails, it is a test-setup issue (the test fixture lacks the `palette` field, which is fine because it's optional). Fix the test, not the schema.

## Evidence Requirements

- `npm test -- src/stores/ui/palette-mru.test.ts` passes.
- Config schema tests (new or added to existing) pass.
- `npm run typecheck` passes.
- `npm run lint` passes.
