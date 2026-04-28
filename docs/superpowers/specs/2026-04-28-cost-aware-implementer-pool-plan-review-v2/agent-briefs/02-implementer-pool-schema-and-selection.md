# 02 - Implementer Pool Schema And Selection

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

Add backwards-compatible implementer profiles. This brief owns config/schema/profile resolution only. It does not modify task execution or TUI.

## Intent

Existing configs with a single `implementer` must keep working. New configs may define named implementer profiles so later routing can choose the cheapest capable worker per task.

## Scope

**In bounds:**

- `src/core/schemas/config.ts`
- `src/core/schemas/implementer-config.ts`
- `src/core/config/load/*`
- `src/core/config/runtime/*`
- `src/core/config/accessors/*`
- `docs/CONFIGURATION.md`
- colocated tests for schema/loading/resolution.

**Out of bounds:**

- No task-loop changes.
- No routing algorithm.
- No TUI.
- No new runtime dependencies.

## Required Behavior

- Existing `config.implementer` remains required and valid.
- Optional profile config can define named implementers.
- One profile is selected as default when profiles exist.
- Profile entries reuse the existing implementer config schema where possible.
- Profile names are stable strings suitable for events/TUI.
- Invalid profile names, duplicate names, and missing defaults fail clearly.

## Suggested Shape

The exact schema may vary, but prefer a small shape:

```ts
implementerProfiles?: {
  default?: string;
  profiles: Record<string, ImplementerConfig & {
    label?: string;
    costTier?: 'local' | 'cheap' | 'standard' | 'frontier' | 'unknown';
  }>;
}
```

Keep this optional. Do not force users to migrate.

## Validation

Tests should cover:

- old single implementer config parses,
- profiles parse,
- missing default falls back deterministically or errors clearly,
- unknown default errors,
- invalid profile name errors,
- profile accessor returns default and all profiles in stable order.

Run:

```bash
npm test -- src/core/schemas/config.test.ts src/core/config/load/load.test.ts
npm run typecheck
npm run lint
```

## Evidence

- New profile schema documented.
- Existing single implementer tests still pass.
- No task execution behavior changes in this brief.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- validation skipped, with explicit reason;
- remaining risks or follow-up work;
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
