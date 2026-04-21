# Migration — Workflow Modes Redesign

## Overview

Config schema moves from `version: 2` to `version: 3`. All changes are backward-compatible at runtime: old `version: 2` YAML files load without error, are migrated in memory, and re-saved as `version: 3` only when the user explicitly edits config via the `/settings` overlay or runs `diptych migrate`.

## Config v2 → v3

### 2.1 Key changes

| v2 key | v3 key | Transform |
|---|---|---|
| `workflow.mode: 'full'` | `workflow.mode: 'speckit'` | rename; emit one-time deprecation notice |
| `workflow.autoApproveSpec`, `workflow.autoApprovePlan` | `workflow.approve` | derive: both-true → `'none'`; only spec → `'plan'`; only plan → `'spec'`; neither → `'default'` |
| `workflow.commitStrategy` | `workflow.git.commitStrategy` | move under `git` subtree; same value |
| *(new)* | `workflow.git.createBranch` | default `false` |
| *(new)* | `workflow.approve` | see above |
| *(new)* | `planner.effort` | optional, no default |
| *(new)* | `workflow.speckit.minCoverage` | default `0.9` |

### 2.2 Migration function

File: `src/core/config/load/migrate.ts` — extend `migrateConfig()` with a v2→v3 path. Existing v1→v2 path stays untouched.

```ts
function migrateV2ToV3(v2: ConfigV2): ConfigV3 {
  const approve = deriveApproveLevel(
    v2.workflow.autoApproveSpec,
    v2.workflow.autoApprovePlan,
  );

  const mode = v2.workflow.mode === 'full' ? 'speckit' : v2.workflow.mode;
  if (v2.workflow.mode === 'full') {
    emitWarning('workflow.mode: full → speckit (renamed in config v3)');
  }

  const git = {
    commitStrategy: v2.workflow.commitStrategy ?? 'none',
    createBranch: false,
  };

  return {
    version: 3,
    planner: v2.planner,
    implementer: v2.implementer,
    validation: v2.validation,
    workflow: {
      approve,
      maxRetries: v2.workflow.maxRetries,
      mode,
      maxBudget: v2.workflow.maxBudget,
      persistTranscript: v2.workflow.persistTranscript,
      git,
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
}

function deriveApproveLevel(
  autoApproveSpec: boolean,
  autoApprovePlan: boolean,
): ApproveLevel {
  if (autoApproveSpec && autoApprovePlan) return 'none';
  if (autoApproveSpec && !autoApprovePlan) return 'plan';
  if (!autoApproveSpec && autoApprovePlan) return 'spec';
  return 'default';
}
```

### 2.3 Backward-compat reads

For at least one release, v3 schema still accepts the v2 keys as input. `applyMigrationsIfNeeded()` reads both shapes and canonicalises to v3 in memory. Writes are always v3.

`src/core/config/load/validate.ts` accepts either shape via `z.union([ConfigSchemaV2, ConfigSchemaV3])` at load time. The migration runs after the load, before the config hits the store.

### 2.4 Write-back policy

We do **not** automatically rewrite `config.yaml` on load. Users keep their v2 file until they explicitly edit settings or run `diptych migrate`. This is deliberate — we do not surprise users with file rewrites.

When the user runs `diptych migrate`, we:

1. Back up the old file to `.diptych/config.yaml.backup-v2-<timestamp>`.
2. Write v3 canonical YAML to `.diptych/config.yaml`.
3. Print the diff so the user sees what changed.

### 2.5 CLI flags — backward compatibility

| Old flag | Status | Behaviour |
|---|---|---|
| `--mode full` | deprecated alias | parses as `--mode speckit`; prints a one-time notice on first use per session |
| `--auto` | retained | parses as `--approve none` |
| `--mode quick` / `--mode standard` | unchanged | |
| `--mode instant` (new) | added | |
| `--mode speckit` (new) | added | |
| `--approve spec\|plan\|none\|all\|default` (new) | added | |
| `--planner-effort low\|medium\|high\|xhigh` (new) | added | |

The deprecation notice for `--mode full` is printed to stderr once per session, not per command. Suppressed by `DIPTYCH_QUIET=1` env var.

## In-flight session migration

### 3.1 `state.json` changes

The `Phase` enum gains three new entries (`constitution-check`, `clarifying`, `analyzing`). Existing `state.json` files cannot contain these values, so nothing to migrate on read.

The `Task` shape is unchanged. Existing tasks deserialise as-is.

### 3.2 `session.jsonl` changes

Append-only log. New event types are additive. Old sessions replay fine — an older diptych build would skip unknown event types; the current build tolerates missing new events.

### 3.3 `summary.json` changes

Adds three optional fields:

- `summary.mode: Mode` — records which mode was used
- `summary.approveLevel: ApproveLevel` — records effective approve level
- `summary.effort: EffortLevel | undefined` — records effort hint if any

These are written on every run from v3 onwards. Sessions started on v2 that are resumed on v3 fill these fields from current config at resume time.

### 3.4 Resume compatibility

A session started on v2 (modes `quick|standard|full`) can be resumed on v3. The resume path:

1. Loads `state.json`. If `mode: 'full'`, rewrites it in memory to `'speckit'` before continuing.
2. Checks `phase`. Since v2 cannot have the new phases, the resume always enters a legacy phase. No special handling.
3. Checks `summary.json` on complete. If it lacks the new fields, they are backfilled from current config.

No `stateVersion` bump is required — the schema is a superset of v2.

## Deprecations timeline

| Item | Deprecated in | Removed in |
|---|---|---|
| `workflow.mode: 'full'` YAML value | v3 | v5 |
| `--mode full` CLI flag | v3 | v5 |
| `workflow.autoApproveSpec` / `workflow.autoApprovePlan` YAML keys | v3 | v5 |
| `workflow.commitStrategy` at root (not under `git`) | v3 | v5 |

Two config-version gap before removal (v3 → v4 → v5) gives users two release cycles to update.

## Tests

Add to `src/core/config/load/migrate.test.ts`:

- v2 config with `mode: full` → v3 with `mode: speckit` + deprecation warning.
- v2 config with `autoApproveSpec: true, autoApprovePlan: true` → v3 with `approve: 'none'`.
- v2 config with `autoApproveSpec: true, autoApprovePlan: false` → v3 with `approve: 'plan'`.
- v2 config with `autoApproveSpec: false, autoApprovePlan: false` → v3 with `approve: 'default'`.
- v2 config with `commitStrategy: 'per-task'` → v3 with `git.commitStrategy: 'per-task'`, `git.createBranch: false`.
- v3 config (already migrated) → passes through unchanged.
- v1 config (existing migration path) → still produces v2-shaped output which then migrates to v3.

Add to `src/cli/options.test.ts` (or new file):

- `--mode full` warns once and sets mode to `speckit`.
- `--auto` sets `workflow.approve` to `'none'` via CLI overrides.
- `--approve spec` sets the level directly.
- `--approve invalid-value` exits with non-zero + error message.

Add to `src/cli/commands/migrate.test.ts`:

- Migrate command writes v3 YAML, creates `.backup-v2-<ts>` file, prints diff, exits 0.
- Migrate command on already-v3 config is a no-op that exits 0 with "already current" message.
