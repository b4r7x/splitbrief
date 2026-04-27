# 07 - Tool/MCP Boundary And Test Cleanup

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Never stage or commit.

## Identity

Final docs/test cleanup pass after implementation APIs settle.

## Intent

Ensure the repo says the right product story and remove low-value tests introduced or exposed by this work.

## Scope

**In bounds:**

- `docs/CONFIGURATION.md`
- `docs/FEATURES.md`
- `docs/WORKFLOW.md`
- `docs/TASK-CONTRACT.md`
- `docs/MCP*` if added later, or MCP sections in existing docs.
- Tests touched by this feature.

**Out of bounds:**

- No source behavior changes unless needed to fix docs/test mismatch.
- No deletion of entire advanced surfaces without separate approval.

## Required Documentation Outcomes

- Tool calls belong to underlying runners.
- Diptych MCP is read-only resources.
- Implementer pool is not a swarm.
- Same-directory parallel writes are out of scope.
- Checkpoints protect users; commits are not part of this repo's agent workflow.
- Plan Review v2 is session-scoped execution review, not plan archive.

## Test Cleanup Rules

Remove or rewrite tests only when they are low value by the project's testing policy:

- private helper call-count tests,
- tests that only prove a hook forwards state,
- no-crash render tests without observable behavior,
- duplicated tests covered by a stronger integration test.

Keep or add tests for:

- routing decisions,
- context-fit blocking,
- user edit conflicts,
- plan save/quality gate,
- rendered task metadata,
- read-only MCP behavior if docs are touched.

## Validation

Run:

```bash
npm run typecheck
npm run lint
npm test
```

Then run the docs grep from `verification.md` and inspect every hit.

## Evidence

- Docs and tests match implemented behavior.
- No new low-value hook tests were added.
- Core product story is clear to a fresh reader.
