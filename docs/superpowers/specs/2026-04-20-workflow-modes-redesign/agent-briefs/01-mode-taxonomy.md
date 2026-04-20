# Brief 01 — Mode taxonomy: rename `full` → `speckit`, add `instant`

> **You are a fresh AI context.** Read `../spec.md` §4.1 before starting. This brief implements ONLY the taxonomy shift and the backward-compat glue. New behaviour for `instant` lives in brief 02; speckit phases live in brief 03. This brief lands as unstaged changes — do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Change the workflow-mode enum from `'quick' | 'standard' | 'full'` to `'instant' | 'quick' | 'standard' | 'speckit'`, migrate config v2 → v3, preserve CLI backward compatibility for `--mode full`, and lay the foundation for briefs 02 / 03 / 04 / 08.

## Dependencies

- None.

## Files to touch

Write-authoritative:

- `src/core/schemas/enums.ts`
- `src/core/schemas/config.ts`
- `src/core/config/load/load.ts`
- `src/core/config/load/migrate.ts`
- `src/core/config/runtime/overrides.ts`
- `src/core/config/runtime/resolve.ts` (NEW)
- `src/features/settings/mode-selector.tsx`
- `src/cli/options.ts`
- `src/cli/init-stores.ts`
- `docs/WORKFLOW.md`
- `docs/CONFIG.md`
- `CLAUDE.md`

Read-only for reference:

- `src/engine/orchestrator/planning/run.ts` — to understand current dispatch (do NOT change here; brief 02 handles it)
- `../spec.md`
- `../migration.md`

## Step-by-step

### 1. Extend `WORKFLOW_MODES`

File: `src/core/schemas/enums.ts:51-53`

Before:

```ts
export const WORKFLOW_MODES = ['quick', 'standard', 'full'] as const;
export const WorkflowModeSchema = z.enum(WORKFLOW_MODES);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;
```

After:

```ts
export const WORKFLOW_MODES = ['instant', 'quick', 'standard', 'speckit'] as const;
export const WorkflowModeSchema = z.enum(WORKFLOW_MODES);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

/**
 * Legacy mode names accepted for backward compatibility on input only.
 * Aliased in {@link normalizeLegacyMode} → canonical WorkflowMode.
 * These aliases are NOT part of the type union and never appear in memory as config values.
 */
export const LEGACY_WORKFLOW_MODE_ALIASES = { full: 'speckit' } as const;
export type LegacyWorkflowMode = keyof typeof LEGACY_WORKFLOW_MODE_ALIASES;
```

Add helper below the export:

```ts
export function normalizeLegacyMode(input: string): WorkflowMode | null {
  if ((WORKFLOW_MODES as readonly string[]).includes(input)) return input as WorkflowMode;
  if (input in LEGACY_WORKFLOW_MODE_ALIASES) {
    return LEGACY_WORKFLOW_MODE_ALIASES[input as LegacyWorkflowMode];
  }
  return null;
}
```

### 2. Bump config version

File: `src/core/schemas/config.ts:15-43`

Before:

```ts
export const ConfigSchema = z.object({
  version: z.literal(2),
  // ...
```

After:

```ts
export const ConfigSchema = z.object({
  version: z.literal(3),
  // ...
```

Export the v2 schema shape as a separate type for the migrator (at bottom of file):

```ts
/** Frozen v2 shape, used only by the v2→v3 migrator. Do NOT reference from application code. */
export const ConfigSchemaV2 = z.object({
  version: z.literal(2),
  // ... (copy of the v2 shape before this brief)
});
export type ConfigV2 = z.infer<typeof ConfigSchemaV2>;
```

Keep all v2 nested schemas inline inside `ConfigSchemaV2` so it is self-contained; the v3 schema continues to use the named sub-schemas.

### 3. Update default mode reference

File: `src/core/schemas/config.ts:47`

No change to `DEFAULT_WORKFLOW_MODE = 'standard'`. Keep as is.

### 4. Write the v2→v3 migrator

File: `src/core/config/load/migrate.ts`

Add a new function `migrateV2ToV3` alongside the existing `migrateV1ToV2`. Modify `migrateConfig` to run v1→v2→v3 chain.

```ts
import { ConfigSchemaV2, type ConfigV2 } from '../../schemas/config.js';
import { normalizeLegacyMode } from '../../schemas/enums.js';

// ... (existing migrateV1ToV2 stays)

export function migrateV2ToV3(v2: ConfigV2): unknown {
  const mode = v2.workflow.mode;
  const canonicalMode = mode ? normalizeLegacyMode(mode) ?? mode : undefined;
  const deprecationNotice =
    mode === 'full'
      ? 'workflow.mode: "full" renamed to "speckit" in config v3'
      : null;

  const approve = deriveApproveLevel(
    v2.workflow.autoApproveSpec,
    v2.workflow.autoApprovePlan,
  );

  const commitStrategy = v2.workflow.commitStrategy ?? 'none';

  const v3 = {
    version: 3 as const,
    planner: v2.planner,
    implementer: v2.implementer,
    validation: v2.validation,
    workflow: {
      approve,
      maxRetries: v2.workflow.maxRetries,
      mode: canonicalMode,
      maxBudget: v2.workflow.maxBudget,
      persistTranscript: v2.workflow.persistTranscript,
      git: {
        commitStrategy,
        createBranch: false,
      },
      speckit: { minCoverage: 0.9 },
    },
    theme: v2.theme,
    shikiTheme: v2.shikiTheme,
    sessions: v2.sessions,
    escalation: v2.escalation,
    codebase: v2.codebase,
    hooks: v2.hooks,
    otel: v2.otel,
  };

  return { v3, deprecationNotice };
}

type ApproveLevel = 'spec' | 'plan' | 'none' | 'all' | 'default';

export function deriveApproveLevel(
  autoApproveSpec: boolean,
  autoApprovePlan: boolean,
): ApproveLevel {
  if (autoApproveSpec && autoApprovePlan) return 'none';
  if (autoApproveSpec && !autoApprovePlan) return 'plan';
  if (!autoApproveSpec && autoApprovePlan) return 'spec';
  return 'default';
}
```

Update `migrateConfig` (existing function) to:

```ts
export function migrateConfig(raw: unknown): {
  config: unknown;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Resolve version once.
  const version = (raw as { version?: number | string })?.version ?? 1;

  let current = raw;

  if (version === 1 || version === '1' || version === undefined) {
    current = migrateV1ToV2(current);
    warnings.push('config migrated v1 → v2');
  }

  // Re-parse current as v2 to normalize.
  const v2Parse = ConfigSchemaV2.safeParse(current);
  if (!v2Parse.success) {
    throw new Error(`config v2 schema validation failed: ${v2Parse.error.message}`);
  }

  const { v3, deprecationNotice } = migrateV2ToV3(v2Parse.data);
  if (deprecationNotice) warnings.push(deprecationNotice);

  return { config: v3, warnings };
}
```

### 5. Wire migration warnings into load

File: `src/core/config/load/load.ts` — in the `loadConfig` function, after calling `migrateConfig`, ensure warnings propagate to the existing `warnings: string[]` return. Confirm the existing pattern already does this (per explore-report §1 it does). No code change beyond the migrator plug-in.

### 6. Create `resolveMode` helper

File: `src/core/config/runtime/resolve.ts` (NEW)

This is the single source of truth for mode resolution. Every other brief uses it.

```ts
import type { Config } from '../../schemas/config.js';
import type { WorkflowMode } from '../../schemas/enums.js';
import { DEFAULT_WORKFLOW_MODE } from '../../schemas/config.js';

/** Resolve the effective workflow mode from config + optional CLI override. */
export function resolveMode(opts: {
  config: Config;
  cliOverride?: WorkflowMode;
}): WorkflowMode {
  if (opts.cliOverride) return opts.cliOverride;
  return opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;
}
```

Colocated test file: `src/core/config/runtime/resolve.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { resolveMode } from './resolve.js';
import type { Config } from '../../schemas/config.js';

const baseConfig = (mode?: 'instant' | 'quick' | 'standard' | 'speckit'): Config => ({
  version: 3,
  planner: { kind: 'cli', tool: 'claude-code' },
  implementer: {
    kind: 'api',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    apiBase: 'http://localhost:11434/v1',
    contextLength: 32768,
    temperature: 0.3,
  },
  validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
  workflow: {
    approve: 'default',
    maxRetries: 3,
    mode,
    persistTranscript: true,
    git: { commitStrategy: 'none', createBranch: false },
    speckit: { minCoverage: 0.9 },
  },
});

describe('resolveMode', () => {
  it('returns CLI override when present', () => {
    expect(resolveMode({ config: baseConfig('standard'), cliOverride: 'instant' })).toBe('instant');
  });
  it('returns config mode when no override', () => {
    expect(resolveMode({ config: baseConfig('speckit') })).toBe('speckit');
  });
  it('falls back to DEFAULT_WORKFLOW_MODE when config has no mode', () => {
    expect(resolveMode({ config: baseConfig() })).toBe('standard');
  });
});
```

### 7. CLI override normalisation

File: `src/cli/init-stores.ts`

Current code (explore-report §4):

```ts
mode: opts.mode,
```

Change to route through the legacy normaliser:

```ts
// at top of file, alongside other imports:
import { normalizeLegacyMode } from '../core/schemas/enums.js';

// ... inside the overrides assembly:
mode: opts.mode ? normalizeLegacyMode(opts.mode) ?? undefined : undefined,
```

If `opts.mode` is `'full'`, this translates to `'speckit'`. If it is invalid, `normalizeLegacyMode` returns `null`, which becomes `undefined`, which is handled downstream.

Emit a one-shot deprecation notice in `src/cli/options.ts` or `src/cli/init-stores.ts` at the first use of the legacy value:

```ts
// in init-stores.ts, after the mode resolution:
if (opts.mode === 'full') {
  if (process.env.DIPTYCH_QUIET !== '1') {
    console.warn('[diptych] --mode full is deprecated; use --mode speckit');
  }
}
```

### 8. CLI option help text

File: `src/cli/options.ts:17`

Before:

```ts
.option('--mode <mode>', 'Workflow mode: quick, standard, or full')
```

After:

```ts
.option('--mode <mode>', 'Workflow mode: instant, quick, standard, or speckit (full=speckit alias)')
```

No parsing change; commander just stores the raw string. Validation happens downstream in the Zod layer.

### 9. Override schema

File: `src/core/config/runtime/overrides.ts`

The `CLIOverrides.mode` field is currently `string | undefined`. After normalisation in step 7, it is `WorkflowMode | undefined`. Update the type signature:

Before:

```ts
export type CLIOverrides = {
  // ...
  mode?: string;
};
```

After:

```ts
import type { WorkflowMode } from '../../schemas/enums.js';

export type CLIOverrides = {
  // ...
  mode?: WorkflowMode;
};
```

Update `applyCLIOverrides`:

```ts
if (overrides.mode) {
  config.workflow.mode = overrides.mode;
}
```

(If the current code validates the mode string against `WORKFLOW_MODES` here, delete that check — it is redundant after normalisation in init-stores.ts.)

### 10. Mode selector UI

File: `src/features/settings/mode-selector.tsx`

The current component (per explore-report §4 UI) lists three modes at lines 17-22. Replace with four:

```tsx
const MODE_OPTIONS: Array<{
  mode: WorkflowMode;
  title: string;
  subtitle: string;
  plannerCalls: string;
  gates: string;
}> = [
  {
    mode: 'instant',
    title: 'Instant',
    subtitle: 'just do it — no spec, no plan, no gates',
    plannerCalls: '1',
    gates: 'none',
  },
  {
    mode: 'quick',
    title: 'Quick',
    subtitle: 'one planner call, tasks shown before run',
    plannerCalls: '1',
    gates: 'none',
  },
  {
    mode: 'standard',
    title: 'Standard',
    subtitle: 'research + spec + plan + tasks, spec gate',
    plannerCalls: '4',
    gates: 'spec',
  },
  {
    mode: 'speckit',
    title: 'Speckit',
    subtitle: 'spec-kit workflow: constitution, clarify, analyze',
    plannerCalls: '6–7',
    gates: 'spec + plan',
  },
];
```

Render unchanged (four-item list, existing `useStaticSelector` loop). Update the column labels if the component exposes them ("Planner calls", "Gates"). Keep the accessibility affordances (selected checkmark at line 76, etc.) as-is.

### 11. CLAUDE.md update

File: `CLAUDE.md`

Find the "Workflow modes" section (grep for `## Workflow modes`) and replace the table. Before:

```md
| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `quick` | 1 | 0 | Small: "add endpoint", "fix bug" |
| `standard` (default) | 4 | 1 (spec) | Medium features |
| `full` | 4 | 2 (spec + plan) | Large features, team handoffs |
```

After:

```md
| Mode | Planner calls | Approval gates | Best for |
|---|:---:|:---:|---|
| `instant` | 1 | none | Trivial: "typo", "rename foo", "add null check" |
| `quick` | 1 | none | Small: "add endpoint", "fix bug" |
| `standard` (default) | 4 | spec | Medium features |
| `speckit` | 6–7 | spec + plan | Large features, team handoffs, compliance (includes constitution check, clarify, analyze) |
```

Nothing else in CLAUDE.md should change for this brief.

### 12. `docs/WORKFLOW.md` update

File: `docs/WORKFLOW.md`

Find §1.2 Mode dispatch. Replace the bullet list with:

```md
- `instant` — one planner call, no spec/plan/research artifacts. Writes `tasks.md` + `session.jsonl` + `summary.json`. No approval gates. `START_INSTANT` transitions straight into the task loop.
- `quick` — one planner call (`planner.quickPlan(...)`) that emits `tasks.md` only. No spec / plan files, no approval gates. `START_QUICK` transitions straight into the task loop.
- `standard` — four planner calls (research, spec, plan, tasks). One approval gate on the spec. The plan gate (`reviewing-plan`) is entered but auto-advanced.
- `speckit` — seven planner calls: research → spec → clarify → constitution-check → plan → analyze → tasks. Both gates active. Fast-fails on constitution-check violations.
```

Do not add the speckit phase details here — that is brief 03's concern. This brief only lists the four modes by name.

### 13. `docs/CONFIG.md` update

File: `docs/CONFIG.md`

Find the `workflow` config reference. Replace the mode entry with:

```md
- `workflow.mode` — one of `instant | quick | standard | speckit`. Default: `standard`. The legacy value `full` is accepted on input and silently migrated to `speckit` with a one-time deprecation notice.
```

### 14. Tests

Add a new test file: `src/core/schemas/enums.test.ts` (if it doesn't already exist — check first; if it does, append):

```ts
import { describe, it, expect } from 'vitest';
import { WorkflowModeSchema, WORKFLOW_MODES, normalizeLegacyMode } from './enums.js';

describe('WORKFLOW_MODES', () => {
  it('includes all four canonical modes', () => {
    expect(WORKFLOW_MODES).toEqual(['instant', 'quick', 'standard', 'speckit']);
  });
  it('does not include legacy "full"', () => {
    expect((WORKFLOW_MODES as readonly string[]).includes('full')).toBe(false);
  });
  it('WorkflowModeSchema rejects "full"', () => {
    expect(WorkflowModeSchema.safeParse('full').success).toBe(false);
  });
});

describe('normalizeLegacyMode', () => {
  it.each([
    ['instant', 'instant'],
    ['quick', 'quick'],
    ['standard', 'standard'],
    ['speckit', 'speckit'],
    ['full', 'speckit'],
  ])('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizeLegacyMode(input)).toBe(expected);
  });
  it('returns null for unknown values', () => {
    expect(normalizeLegacyMode('bogus')).toBeNull();
    expect(normalizeLegacyMode('')).toBeNull();
  });
});
```

Add to `src/core/config/load/migrate.test.ts` (existing file; append a new `describe` block):

```ts
import { migrateV2ToV3, deriveApproveLevel } from './migrate.js';

describe('migrateV2ToV3', () => {
  const baseV2 = {
    version: 2 as const,
    planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    implementer: {
      kind: 'api' as const,
      provider: 'ollama' as const,
      model: 'qwen2.5-coder:7b',
      apiBase: 'http://localhost:11434/v1',
      contextLength: 32768,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      maxRetries: 3,
      commitStrategy: 'none' as const,
      mode: undefined,
      persistTranscript: true,
    },
  };

  it('renames mode "full" → "speckit" with notice', () => {
    const { v3, deprecationNotice } = migrateV2ToV3({
      ...baseV2,
      workflow: { ...baseV2.workflow, mode: 'full' },
    });
    expect(v3.workflow.mode).toBe('speckit');
    expect(deprecationNotice).toMatch(/full.*speckit/);
  });

  it('preserves canonical mode unchanged', () => {
    const { v3, deprecationNotice } = migrateV2ToV3({
      ...baseV2,
      workflow: { ...baseV2.workflow, mode: 'quick' },
    });
    expect(v3.workflow.mode).toBe('quick');
    expect(deprecationNotice).toBeNull();
  });

  it('moves commitStrategy under git', () => {
    const { v3 } = migrateV2ToV3({
      ...baseV2,
      workflow: { ...baseV2.workflow, commitStrategy: 'per-task' },
    });
    expect(v3.workflow.git.commitStrategy).toBe('per-task');
    expect(v3.workflow.git.createBranch).toBe(false);
  });

  it('defaults speckit.minCoverage', () => {
    const { v3 } = migrateV2ToV3(baseV2);
    expect(v3.workflow.speckit.minCoverage).toBe(0.9);
  });
});

describe('deriveApproveLevel', () => {
  it.each([
    [true, true, 'none'],
    [true, false, 'plan'],
    [false, true, 'spec'],
    [false, false, 'default'],
  ])('autoApproveSpec=%s autoApprovePlan=%s → %s', (s, p, expected) => {
    expect(deriveApproveLevel(s, p)).toBe(expected);
  });
});
```

If an existing `options.test.ts` exists for the CLI, add:

```ts
it('accepts --mode full and normalises to speckit', () => {
  const overrides = parseCliOverrides(['--mode', 'full']);
  expect(overrides.mode).toBe('speckit');
});

it('rejects --mode invalid', () => {
  // exact assertion depends on existing parser error-handling style
});
```

### 15. Run the verification gate

```bash
npm run typecheck
npm run lint
npm test
```

All three must pass. If any fails, fix inside this brief; do NOT leave partial work.

## Checkpoint

After this brief:

- Config v2 files load and migrate to v3 in memory.
- `full` as a mode name is gone from `WORKFLOW_MODES` but accepted via alias.
- No other brief's work is started.
- `instant` is parseable as a mode but has no dispatch yet (brief 02).
- `speckit` is parseable but has no phase logic yet (brief 03).
- `workflow.approve` field exists but no CLI flag yet (brief 04).

The workflow still runs end-to-end using the existing dispatcher in `runPlanningPhase()` because v3 migration preserves the old per-mode behaviour via the `approve` field derivation. `quick` dispatches to `runQuickPlanning`. `standard` / `speckit` dispatch to `runFullPlanning` with gate skipping decided by the (new) `resolveApproveLevel` — which brief 04 implements. Until brief 04 lands, leave `runPlanningPhase()` using the old `skipPlanApproval = mode === 'standard'` logic so existing behaviour is preserved.

`instant` mode, if selected, currently routes through `runQuickPlanning` (because `mode === 'instant'` is not `'quick'`, but the current dispatcher only has a `quick` branch and a default `runFullPlanning` branch). This is wrong for `instant` but only observable if the user explicitly selects it. **Add a guard at the top of `runPlanningPhase()`** that throws a clear error for `mode === 'instant'`:

```ts
if (mode === 'instant') {
  throw new Error('instant mode requires brief 02 to be landed');
}
```

Brief 02 replaces this guard with the real implementation.

## Rollback

`git checkout HEAD -- src/core/schemas/enums.ts src/core/schemas/config.ts src/core/config/load/migrate.ts src/core/config/load/load.ts src/core/config/runtime/overrides.ts src/features/settings/mode-selector.tsx src/cli/options.ts src/cli/init-stores.ts docs/WORKFLOW.md docs/CONFIG.md CLAUDE.md` and `git clean -f -- src/core/config/runtime/resolve.ts src/core/config/runtime/resolve.test.ts src/core/schemas/enums.test.ts`.
