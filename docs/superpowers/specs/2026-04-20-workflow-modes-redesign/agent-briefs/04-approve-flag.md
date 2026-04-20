# Brief 04 — Orthogonal `--approve` flag

> **You are a fresh AI context.** Read `../spec.md` §4.2 and `../decisions.md` ADR-003 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Extract approval-gate control into a standalone flag (`--approve <spec|plan|none|all>`) and config key (`workflow.approve`). Mode-based gate logic in `runPlanningPhase` is replaced by calls to `resolveApproveLevel`. Legacy `workflow.autoApproveSpec` / `workflow.autoApprovePlan` YAML keys are migrated. `--auto` remains as a legacy alias.

## Dependencies

- Brief 01 (v3 config has `workflow.approve` field and `resolveMode`).

## Files to touch

Write-authoritative:

- `src/core/schemas/config.ts`
- `src/core/schemas/enums.ts` (add `APPROVE_LEVELS`)
- `src/core/config/runtime/resolve.ts` (extend with `resolveApproveLevel`)
- `src/core/config/runtime/overrides.ts`
- `src/core/settings/catalog.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/engine/orchestrator/planning/new.ts`
- `src/engine/orchestrator/planning/speckit.ts` (from brief 03, if landed; no-op if not)
- `src/engine/orchestrator/approval.ts`
- `src/cli/options.ts`
- `src/cli/init-stores.ts`
- `src/core/slash-commands/catalog.ts`
- `docs/CONFIG.md`
- `docs/WORKFLOW.md`

## Step-by-step

### 1. Approve-level enum

File: `src/core/schemas/enums.ts`

Add:

```ts
export const APPROVE_LEVELS = ['none', 'spec', 'plan', 'all', 'default'] as const;
export const ApproveLevelSchema = z.enum(APPROVE_LEVELS);
export type ApproveLevel = z.infer<typeof ApproveLevelSchema>;
```

(This type was referenced as a string alias in brief 02; now tighten it.)

### 2. Config schema

File: `src/core/schemas/config.ts`

Update the `workflow` sub-schema:

```ts
// Before:
workflow: z.object({
  autoApproveSpec: z.boolean(),
  autoApprovePlan: z.boolean(),
  // ...
}),

// After:
workflow: z.object({
  approve: ApproveLevelSchema.default('default'),
  // autoApproveSpec / autoApprovePlan removed from v3 canonical shape;
  // they remain in ConfigSchemaV2 for migration input only.
  maxRetries: z.number().int().min(0),
  mode: WorkflowModeSchema.optional(),
  maxBudget: z.number().positive().optional(),
  persistTranscript: z.boolean().default(true),
  git: z.object({
    commitStrategy: CommitStrategySchema.default('none'),
    createBranch: z.boolean().default(false),
  }).default({ commitStrategy: 'none', createBranch: false }),
  speckit: z.object({
    minCoverage: z.number().min(0).max(1).default(0.9),
  }).default({ minCoverage: 0.9 }),
}),
```

### 3. Resolve function

File: `src/core/config/runtime/resolve.ts`

Append to the file created in brief 01:

```ts
import type { ApproveLevel } from '../../schemas/enums.js';

const MODE_DEFAULT_APPROVE: Record<WorkflowMode, ApproveLevel> = {
  instant: 'none',
  quick: 'none',
  standard: 'spec',
  speckit: 'all',
};

/** Resolve the effective approve level from config + optional CLI override + mode. */
export function resolveApproveLevel(opts: {
  mode: WorkflowMode;
  configApprove: ApproveLevel;
  cliOverride?: ApproveLevel;
  legacyAutoFlag?: boolean; // --auto CLI flag (sets to 'none')
}): ApproveLevel {
  if (opts.legacyAutoFlag) return 'none';
  if (opts.cliOverride && opts.cliOverride !== 'default') return opts.cliOverride;
  if (opts.configApprove && opts.configApprove !== 'default') return opts.configApprove;
  return MODE_DEFAULT_APPROVE[opts.mode];
}

/**
 * Does the current approve level block on the spec gate?
 */
export function blocksSpecGate(level: ApproveLevel): boolean {
  return level === 'spec' || level === 'all';
}

export function blocksPlanGate(level: ApproveLevel): boolean {
  return level === 'plan' || level === 'all';
}
```

Colocated test `resolve.test.ts` — extend with coverage for every mode × cli × config combination.

### 4. CLI option

File: `src/cli/options.ts`

Add:

```ts
.option(
  '--approve <level>',
  'Approval gates: spec, plan, none, all, default (follows mode)',
)
```

Do NOT remove `--auto`. Keep for backward compat.

### 5. CLI override plumbing

File: `src/cli/init-stores.ts`

Extend overrides:

```ts
configStore.load(projectDir, {
  // ... existing fields ...
  approve: opts.approve as ApproveLevel | undefined,
  autoApprove: opts.auto,  // retained for legacy path
});
```

File: `src/core/config/runtime/overrides.ts`

Add to `CLIOverrides`:

```ts
approve?: ApproveLevel;
autoApprove?: boolean;  // legacy
```

In `applyCLIOverrides`:

```ts
if (overrides.approve) {
  const parsed = ApproveLevelSchema.safeParse(overrides.approve);
  if (!parsed.success) {
    throw new Error(`invalid --approve value: ${overrides.approve}; expected one of ${APPROVE_LEVELS.join(', ')}`);
  }
  config.workflow.approve = parsed.data;
}
if (overrides.autoApprove) {
  // Legacy: --auto wins over --approve for bwd compat; user scripts rely on this.
  config.workflow.approve = 'none';
}
```

### 6. Orchestrator wiring

File: `src/engine/orchestrator/planning/run.ts`

After brief 02 there is:

```ts
const mode = config.workflow.mode ?? DEFAULT_WORKFLOW_MODE;
// ...
const skipPlanApproval = mode === 'standard';
```

Replace with:

```ts
const mode = resolveMode({ config });
const approveLevel = resolveApproveLevel({
  mode,
  configApprove: config.workflow.approve,
});

bus.publish({
  type: 'mode_resolved',
  phase: state.phase,
  ts: Date.now(),
  mode,
  approve: approveLevel,
});

// ...downstream:
if (mode === 'instant') return runInstantPlanning(optsWithContext);
if (mode === 'quick') return runQuickPlanning(optsWithContext);
if (mode === 'speckit') return runSpeckitPlanning({ ...optsWithContext, approveLevel });
// standard
return runFullPlanning({ ...optsWithContext, approveLevel });
```

Thread `approveLevel` into `runFullPlanning` and `runSpeckitPlanning`. Inside those functions, replace any `config.workflow.autoApproveSpec` / `config.workflow.autoApprovePlan` reads with:

```ts
import { blocksSpecGate, blocksPlanGate } from '../../../core/config/runtime/resolve.js';

const blockSpec = blocksSpecGate(approveLevel);
const blockPlan = blocksPlanGate(approveLevel);
```

File: `src/engine/orchestrator/planning/new.ts` (line ~80-87 per explore-report)

Before:

```ts
const needsSpecApproval = !config.workflow.autoApproveSpec;
if (needsSpecApproval) { /* run approval loop */ }
```

After:

```ts
if (blocksSpecGate(approveLevel)) { /* run approval loop */ }
```

Same for plan gate (line ~97-106).

### 7. Approval callback resolution

File: `src/engine/orchestrator/approval.ts`

No logic change here — it accepts `type: 'spec' | 'plan'` and asks the user. Whether it is called or skipped is decided upstream by `blocksSpecGate` / `blocksPlanGate`. Confirm no residual `autoApprove*` reads exist here (grep the file).

### 8. Degrade `all` on `instant`

Per verification §2 Brief 04, `--mode instant --approve all` should degrade to `none` (since instant has no gates to block) and log a one-shot event.

In `runInstantPlanning` (added in brief 02), add at the top:

```ts
if (approveLevel === 'all' || approveLevel === 'spec' || approveLevel === 'plan') {
  bus.publish({
    type: 'warning',
    phase: state.phase,
    ts: Date.now(),
    message: `approve level "${approveLevel}" has no effect in instant mode`,
  });
}
```

Pass `approveLevel` into `runInstantPlanning` via `PlanningPhaseOptions` (add the field to that type).

### 9. Settings catalog

File: `src/core/settings/catalog.ts`

Add a new `SettingDef`:

```ts
{
  id: 'workflow.approve',
  label: 'Approval gates',
  section: 'workflow',
  description: 'Which approval gates are active. "default" follows the mode preset.',
  kind: 'enum',
  values: APPROVE_LEVELS,
  readValue: (config) => config.workflow.approve,
  writeValue: (config, value) => { config.workflow.approve = value; return config; },
},
```

Remove the two existing entries for `workflow.autoApproveSpec` / `workflow.autoApprovePlan` (they should no longer exist on v3 shape).

### 10. Slash command

File: `src/core/slash-commands/catalog.ts`

Add:

```ts
{
  name: '/approve',
  kind: 'arg',
  validScreens: ['workflow'],
  argChoices: ['none', 'spec', 'plan', 'all', 'default'],
  handler: async (ctx, arg) => {
    if (!arg) {
      ctx.openOverlay('settings', { focus: 'workflow.approve' });
      return;
    }
    const parsed = ApproveLevelSchema.safeParse(arg);
    if (!parsed.success) {
      ctx.setFeedbackMessage(`invalid approve level: ${arg}; expected one of: none, spec, plan, all, default`, 'error');
      return;
    }
    await ctx.updateConfig((c) => { c.workflow.approve = parsed.data; return c; });
    ctx.setFeedbackMessage(`approve: ${parsed.data}`, 'success');
  },
  help: 'Set approval gate level for the current session.',
},
```

### 11. Migrate stored sessions

A session's `state.json` may have been captured while v2 was in effect. The resume path loads the config fresh from disk; since brief 01 migrates v2 → v3 in memory, resumed sessions pick up the new `workflow.approve` field automatically.

However, the `state.json` file itself does not carry approval settings — only the config does. No per-session migration is needed.

### 12. Tests

Extend `src/core/config/runtime/resolve.test.ts` (from brief 01):

```ts
describe('resolveApproveLevel', () => {
  it.each([
    ['instant', 'default', 'none'],
    ['quick', 'default', 'none'],
    ['standard', 'default', 'spec'],
    ['speckit', 'default', 'all'],
    ['standard', 'none', 'none'],
    ['instant', 'all', 'all'],  // caller should degrade; this function returns 'all' faithfully
  ])('mode=%s config=%s → %s', (mode, cfg, expected) => {
    expect(resolveApproveLevel({ mode, configApprove: cfg })).toBe(expected);
  });

  it('legacyAutoFlag overrides everything', () => {
    expect(resolveApproveLevel({ mode: 'speckit', configApprove: 'all', legacyAutoFlag: true })).toBe('none');
  });

  it('cli override takes precedence over config', () => {
    expect(resolveApproveLevel({ mode: 'standard', configApprove: 'spec', cliOverride: 'none' })).toBe('none');
  });

  it('"default" cli value falls through to config/mode default', () => {
    expect(resolveApproveLevel({ mode: 'standard', configApprove: 'default', cliOverride: 'default' })).toBe('spec');
  });
});

describe('blocksSpecGate / blocksPlanGate', () => {
  it.each([
    ['none', false, false],
    ['spec', true, false],
    ['plan', false, true],
    ['all', true, true],
    ['default', false, false], // 'default' means unresolved; callers should always resolve first
  ])('%s → spec=%s plan=%s', (level, spec, plan) => {
    expect(blocksSpecGate(level)).toBe(spec);
    expect(blocksPlanGate(level)).toBe(plan);
  });
});
```

Add a new integration test file `src/engine/orchestrator/planning/approve.integration.test.ts`:

```ts
describe.each([
  ['instant', 'default', 0, 0],
  ['quick', 'default', 0, 0],
  ['standard', 'default', 1, 0],
  ['speckit', 'default', 1, 1],
  ['standard', 'none', 0, 0],
  ['standard', 'all', 1, 1],
  ['speckit', 'spec', 1, 0],
])('mode=%s approve=%s', (mode, approve, expectSpecGate, expectPlanGate) => {
  it(`calls onApprovalNeeded ${expectSpecGate + expectPlanGate} times`, async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
    const ctx = createTestWorkflowContext({ mode, config: { workflow: { approve } }, onApprovalNeeded });
    await runWorkflow(ctx);
    const specCalls = onApprovalNeeded.mock.calls.filter(c => c[0] === 'spec').length;
    const planCalls = onApprovalNeeded.mock.calls.filter(c => c[0] === 'plan').length;
    expect(specCalls).toBe(expectSpecGate);
    expect(planCalls).toBe(expectPlanGate);
  });
});
```

### 13. Docs

File: `docs/CONFIG.md`

Under `workflow`, add:

```md
- `workflow.approve` — `'none' | 'spec' | 'plan' | 'all' | 'default'`. Which approval gates block the workflow. Default: `'default'` (follows the mode preset). CLI equivalent: `--approve`. The legacy keys `workflow.autoApproveSpec` / `workflow.autoApprovePlan` are accepted on input for one more release; use `approve` going forward.
```

File: `docs/WORKFLOW.md`

Update §1.2 to mention the orthogonal flag.

### 14. Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

## Rollback

Revert the listed files. Restore `config.workflow.autoApproveSpec / autoApprovePlan` in the schema. Reverse the migrator changes in `migrate.ts` (it lives in brief 01, so technically you only need to revert the consumers here).

## Checkpoint

- `--approve` works.
- `--auto` still works.
- `/approve <level>` slash command works.
- `/settings` overlay shows the new setting.
- Every combination of mode × approve behaves per the table in `../spec.md` §4.2.
- All previous tests still pass.
