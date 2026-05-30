# SOTA Quality Remediation — 2026-05-29

Remediation spec for the unbiased Opus quality audit
[`docs/audits/sota-quality-audit-opus-2026-05-28.md`](../../../audits/sota-quality-audit-opus-2026-05-28.md).

## Goal

Close **every finding enumerated in that audit** — all ~190 distinct findings
(1 critical, ~50 high, ~95 medium, ~45 low) — with surgical, behavior-preserving
edits. No new features. No scope creep. The audit's own
[Highest-leverage refactors](../../../audits/sota-quality-audit-opus-2026-05-28.md)
section (meta-fixes first, then file splits, then DRY) sets the spine of the plan.

## Scope boundary (what "everything" means)

"Everything" = **every finding listed in the 2026-05-28 audit document.** The
audit explicitly reports it is **NOT converged** (it was capped mid-stream, still
finding +12 new locations in its last round). We therefore bound this spec to the
*enumerated* findings so coverage is finite and checkable. New findings a future
audit surfaces are out of scope for this round and belong to a follow-up spec.

[`traceability.md`](./traceability.md) enumerates all ~190 findings with a stable
ID, severity, `file:line`, the owning brief, and a status box. It is the **spine**:
a finding is "covered" only when its row is checked AND its owning brief's
unbiased validator confirms it in the actual diff.

## Execution model

Two hard rules drive the whole design:

1. **One implementation, then immediately an unbiased validation.** After each
   brief is implemented, a *separate* agent — fresh context, did **not** see the
   implementer's reasoning — re-derives from the code whether every finding in
   that brief was actually addressed, whether anything regressed, and whether new
   slop was introduced. This is the user's binding requirement: *nothing gets
   silently dropped.* It is also Constitution Principle V (validate before
   checkpoint; final review compares diff vs spec).

2. **Writes are serialized.** All briefs edit one shared working tree. They are
   executed **one at a time** in dependency order. There are no parallel writers,
   so there are no write collisions; the only cross-brief concern is **ordering**
   (producers before consumers, formatter first, tests last) and **not reverting**
   a prior brief's edit. The collision map in
   [`agent-briefs/00-coordinator.md`](./agent-briefs/00-coordinator.md) documents
   every shared-file touch.

"Split for subagents / separate workflows to not bloat main context" is realized
by: **(a)** self-contained briefs — each implementer subagent reads only its one
brief file (findings inlined, per Constitution II), never the whole audit; and
**(b)** one workflow per wave — each returns only a compact summary to the main
loop, so orchestrating all 9 waves never loads brief bodies or diffs into the
main context.

### Per-brief loop (run by the wave workflow)

```
implement (opus)  →  validate (opus, unbiased)  →  gaps?
                                                     ├─ yes → fix gaps (opus) → re-validate  (≤2 rounds)
                                                     └─ no  → run gate (typecheck+lint+affected tests) → next brief
```

Implementers and validators are **opus** agents (audit was opus; meta-fixes and
parameter-object refactors need strong reasoning). Validators are deliberately
*unbiased*: spawned fresh, handed the brief + the audit rows + the git diff, told
to assume nothing the implementer claimed.

## Waves (dependency-ordered)

| Wave | Briefs | Theme | Why here |
|---|---|---|---|
| 1 | B01 | Formatting sweep (**solo**) | `biome format --write` reflows nearly every file; nothing may run concurrent with it. Lands first so all later edits are in formatted files. |
| 1 | B02 | Type-safety enforcement & exhaustiveness | `noImplicitReturns` + re-enabled assertion lints surface fixes across files later briefs also touch; set the rules before code is added. |
| 1 | B03 | Schema & enum single-sourcing | Produces the const-tuple enums / `z.infer` types consumed downstream. |
| 2 | B04 | Promote shared helpers to `core/`/`utils/` | **Producer.** `pluralize`/`clamp`/`formatPercent`/`isTerminalPhase`/… must exist before the DRY briefs adopt them. |
| 3 | B05 | Critical path-confinement + secure writes + error handling | The 1 critical lives here; independent of the refactors. |
| 4 | B06 | Orchestrator parameter objects (`WorkflowContext`) | The dominant category (~26 high). |
| 4 | B07 | Providers / planners / runners parameter objects | " |
| 4 | B08 | Core / CLI / features parameter objects | " |
| 5 | B09 | Layer relocations & facades | Moves `core/layout` (deletes the `LayoutEvent` mirror), adds the routing-preview facade, fixes the RPC rewind event. |
| 6 | B10 | Engine SRP file splits | After signatures settle in wave 4. |
| 6 | B11 | CLI / features / core SRP file splits | " |
| 7 | B12 | Engine DRY extractions & adoption | After helpers (B04) exist and splits (B10) land. |
| 7 | B13 | CLI / features / core DRY extractions & adoption | " |
| 8 | B14 | Dead-code removal (+ knip/ts-prune gate) | Delete before tests so test changes account for removals. |
| 9 | B15 | Test-behavior fixes | **Last** — they assert on behavior the earlier waves changed. |
| 9 | B16 | Remaining nits (KISS / anti-slop / YAGNI / over-eng / patterns / naming / perf) | Mop-up; lowest risk. |

A full `npm run test-ci` gate runs at the end of every wave. The whole run is
green-gated: a wave does not start until the previous wave's gate passes.

## Files in this spec

| File | Purpose |
|---|---|
| `README.md` | This overview. |
| [`decisions.md`](./decisions.md) | The design decisions a single owner must make so parallel implementers don't freelance them (contract choices, facade keep/delete, error policies). Briefs reference these; they do not re-decide. |
| [`traceability.md`](./traceability.md) | All ~190 findings → ID, severity, `file:line`, brief, status. The coverage spine. |
| [`agent-briefs/00-coordinator.md`](./agent-briefs/00-coordinator.md) | Wave plan, ordering rationale, collision map, the per-brief loop, and the verification gates. |
| `agent-briefs/B01..B16-*.md` | Self-contained implementer briefs. Each inlines its findings, file ownership, required changes, acceptance criteria, and test commands. |
| [`validation/validator-protocol.md`](./validation/validator-protocol.md) | The unbiased-validator contract: inputs, what to re-derive, the structured verdict it must return. |
| [`execute-prompt.md`](./execute-prompt.md) | Copy-paste kickoff prompt + the repository hard rules. |

## Hard repository rules (every agent)

- **NEVER** run `git add`, `git stage`, `git commit`, or `git stash`. The
  `.claude/hooks/block-git-commits.sh` PreToolUse hook blocks them. The owner
  reviews and commits manually. (CLAUDE.md; Constitution V.)
- Never revert another brief's edits or the user's working-tree changes.
- ESM with `.js` import extensions. Zero runtime classes (Error subclasses are the
  one sanctioned exception — see `decisions.md`). Zero barrels (no `index.ts`).
  Zero `useMemo`/`useCallback`/`React.memo`/`forwardRef`. Colocated tests.
- Tests verify behavior, not implementation.
- `src/engine/` must not import `ink`/`react`/`src/features`/`src/components`/`src/hooks`.
