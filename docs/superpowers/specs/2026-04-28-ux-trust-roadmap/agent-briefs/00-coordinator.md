# Coordinator Brief - UX Trust Roadmap

Guard: historical roadmap coordination prompt. Do not re-run it unless intentionally changing or re-planning the roadmap.

You are coordinating the UX/trust roadmap under:

```text
docs/superpowers/specs/2026-04-28-ux-trust-roadmap/
```

## Read First

1. `CLAUDE.md`
2. `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
3. `docs/FEATURES.md` sections for workflow, plan review, cost telemetry, sessions, snapshots, evidence, drift, MCP, and worktrees.
4. `docs/superpowers/specs/2026-04-28-cost-aware-implementer-pool-plan-review-v2/README.md`
5. `docs/superpowers/specs/2026-04-28-cost-aware-implementer-pool-plan-review-v2/decisions.md`
6. `docs/superpowers/specs/2026-04-28-ux-trust-roadmap/README.md`
7. `docs/superpowers/specs/2026-04-28-ux-trust-roadmap/decisions.md`
8. `docs/superpowers/specs/2026-04-28-ux-trust-roadmap/tasks.md`
9. `docs/superpowers/specs/2026-04-28-ux-trust-roadmap/verification.md`

## Mission

Audit and coordinate the existing four child packs in this order:

1. `2026-04-28-run-readiness-doctor`
2. `2026-04-28-plan-review-trust`
3. `2026-04-28-recovery-flow`
4. `2026-04-28-checkpoint-review-packet`

Each child pack should be concise, actionable, and scoped to its user moment. Review and coordinate the packs that already exist; do not create, regenerate, overwrite, or replace child pack files unless the user explicitly asks for that specific change. Leave runtime implementation details, file ownership, detailed test cases, and agent task briefs to the child pack where they belong.

## Product Boundary

Preserve this identity in every child pack:

```text
expensive planner -> self-contained Task Briefs -> cheap/local implementer per task -> checkpoints/validation/evidence/escalation
```

Keep durable session history as core: resume, browse/filter/search previous sessions, and inspect session artifacts.

Do not build or imply:

- kanban,
- plan archive or plan management,
- MCP write tools,
- full multi-agent manager,
- same-checkout parallel writes,
- near-term parallel fan-out.

If parallel execution is mentioned, it must be future-only and require isolated worktrees or equivalent sandboxes.

## Coordination Rules

- Review and coordinate child packs in roadmap order.
- After each child pack, verify it against `verification.md`.
- Keep terminology consistent across packs.
- Prefer references to existing features over redefining them.
- Treat user edits as source-of-truth changes that must not be overwritten silently.
- Keep checkpoints and restore flows hash-guarded.
- Keep Plan Review scoped to current-session execution readiness.
- Keep `diptych doctor` read-only; only `diptych start` may persist compact readiness evidence in the active execution session before model calls.
- Keep MCP read-only unless a separate future ADR explicitly changes the product boundary.

## Synthesis Output

After all child packs are audited, write a short synthesis that lists:

- audit status for each reviewed child pack,
- cross-pack terminology decisions,
- any deferred questions,
- any detected conflicts with roadmap ADRs,
- recommended next implementation order.

## Expected Final Report

Your final report must list:

- files reviewed and files changed,
- validation commands run,
- remaining risks or deferred questions,
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
- confirmation that you did not revert user changes.

Do not run `git add`, `git stage`, `git commit`, or `git stash`. Do not revert user changes.
