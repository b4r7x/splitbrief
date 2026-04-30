# 05 - Profile Doctor Readiness

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Make readiness checks useful without annoying normal users.

Normal start should show blockers only. Warnings should live in `doctor`, JSON, trace/explain, or explicit details.

## Required Skills

Use these skills:

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `typescript`

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

1. `CLAUDE.md`
2. `docs/CONFIGURATION.md`
3. `src/core/readiness/checks.ts`
4. `src/core/readiness/types.ts`
5. `src/core/readiness/format.ts`
6. `src/cli/commands/doctor.ts`
7. `src/cli/commands/start.ts`
8. `src/core/config/load/validate.ts`
9. readiness/config validation tests.

## Owned Files

Primary ownership:

- `src/core/readiness/checks.ts`
- `src/core/readiness/types.ts`
- `src/core/readiness/format.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/start.ts`
- `src/core/config/load/validate.ts`
- readiness/config validation tests.

Do not edit:

- deterministic estimate output,
- summary UI,
- task review UI,
- planner prompt code.

## Functional Requirements

### PDR-001 - Normal Start Shows Blockers Only

Interactive normal start should not show warning popups or warning blocks.

If no blocker exists, continue.

### PDR-002 - Doctor Shows Full Detail

`diptych doctor` should show:

- blockers,
- warnings,
- info,
- ok checks.

`diptych doctor --json` should preserve machine-readable severities and relevant metadata.

### PDR-003 - Missing Optional Metadata Is Not Fatal

These are warning/info, not blockers:

- missing `contextLength`,
- missing `costTier`,
- inferred `writesFiles`,
- unknown price,
- unused profile missing credentials.

### PDR-004 - No Usable Implementer Is Fatal

These are blockers:

- selected/default implementer cannot run and no fallback exists,
- only usable implementer is missing required credentials,
- config is invalid enough that routing cannot choose any implementer.

Unknown custom API providers without catalog env-var metadata must be deterministic too. If a custom API provider has no explicit `apiKey`, classify it as credential-missing unless a future explicit config such as `auth: none` or `apiKeyEnv` exists.

### PDR-005 - No Network By Default

Doctor/readiness should not call providers or probe models by default.

A future `--probe` feature is out of scope.

## Desired UX

Normal start:

```text
Blocker: no usable implementer profile.
```

Doctor:

```text
Warning: profile local-small has no contextLength; using conservative fallback.
Info: writesFiles inferred from runner kind.
```

The exact format should follow existing formatter style.

## Implementation Steps

1. Inspect how readiness report is built and formatted.
2. Find where normal start prints readiness.
3. Make normal start filter to blockers only.
4. Keep doctor detailed.
5. Adjust config validation if optional profile issues currently throw too early.
6. Add classification tests.

## Test Requirements

Required behavior tests:

- normal start hides warnings,
- doctor shows warnings,
- doctor JSON includes warning/info severity,
- missing context length is non-blocking,
- missing cost tier is non-blocking,
- unused profile missing API key is non-blocking,
- no usable implementer blocks.

Do not test formatter internals unless they are public CLI output.

## Validation

Run targeted readiness/config tests.

Then run:

```bash
npm run typecheck
npm run lint
```

## Anti-Slop Checks

Before finishing:

- no second doctor system,
- no network probe,
- no noisy normal warning UX,
- no breaking optional metadata,
- no broad config rewrite.

## Agent Prompt

```text
Implement spec 05 Profile Doctor Readiness from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/05-profile-doctor-readiness/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
Normal start shows blockers only. Doctor shows full detail. Use behavior tests only.
Report changed files, validation, skipped validation, risks, and git confirmation.
```
