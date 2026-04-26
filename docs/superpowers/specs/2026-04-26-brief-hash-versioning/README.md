# Brief Hash Versioning — 2026-04-26

> **Status:** draft spec.
> **Scope:** introduce `briefHash` — a stable sha256 fingerprint of the compiled Task Brief — and propagate it through the evidence ledger, drift report, and (as a forward reference) the handoff pack manifest.
> **Out of scope:** handoff pack rendering, handoff manifest schema creation (that belongs to the handoff-packs spec), MCP/live mode, Task Brief regeneration UI.

## Purpose

When the planner compiles a Task Brief, downstream artifacts (evidence entries, drift reports, handoff packs) must be able to prove they describe the same brief and detect when a mid-run regeneration created a new one. Without a hash, silent invalidation is possible: old evidence silently references a brief that has since been replaced.

The product invariant added by this spec is:

> Every evidence ledger entry and drift report carries the `briefHash` of the brief that was active when it was written. External tooling can compare hashes to detect stale artifacts.

This spec is a prerequisite of the handoff packs spec (`2026-04-22-external-agent-handoff-packs`). ADR-008 in that spec's `decisions.md` is the originating decision for this work.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview. |
| 2 | `decisions.md` | Architecture decisions (ADR-001 through ADR-006). |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and dependencies across briefs. |
| 4 | `agent-briefs/01-canonical-json-and-hash.md` | Pure utility: canonical JSON serializer + sha256 hashing function. |
| 5 | `agent-briefs/03-task-schema-and-tests.md` | Extend `EvidenceTask` schema with `briefHash` field. Run this before brief 02. |
| 6 | `agent-briefs/02-evidence-and-drift-integration.md` | Wire `briefHash` into evidence ledger and drift report at runtime. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Canonical JSON and Hash | Pure `canonicalJSON` utility in `src/utils/` + domain `hashTaskBrief` in `src/core/`. Tests for edge cases. |
| 02 | Evidence and Drift Integration | Thread `briefHash` through `createEvidenceLedger`, all `record*` helpers, and `analyzeBriefDrift`. |
| 03 | Task Schema and Tests | Extend `EvidenceLedgerSchema` and `EvidenceTaskSchema` with `briefHash: z.string().nullable().optional()`. Tests covering regeneration scenario. |

**Implementation order: 01 → 03 → 02.** Brief 02 calls into code produced by 01 and 03; 03 must compile before 02 can typecheck. See `00-coordinator.md`.

## Dependencies

- **Prerequisite for:** `docs/superpowers/specs/2026-04-22-external-agent-handoff-packs/` (handoff manifest requires `briefHash` per ADR-008 in that spec).
- **Depends on:** `docs/superpowers/specs/2026-04-22-task-brief-evidence-contract/` — evidence ledger and drift report must already exist (`evidence.json`, `drift-report.json`, `src/core/schemas/evidence.ts`, `src/engine/orchestrator/evidence.ts`, `src/engine/orchestrator/drift.ts`).

## Done Criteria

- `src/utils/canonical-json.ts` produces deterministic, RFC-8785-style key-sorted JSON.
- `src/core/brief-hash.ts` exports `hashTaskBrief(tasks: Task[]): string` producing a hex sha256.
- `EvidenceTaskSchema` carries `briefHash: z.string().nullable().optional()`.
- `EvidenceLedgerSchema` carries a top-level `briefHash: z.string().nullable().optional()`.
- `DriftReport` type carries `briefHash: string | null`.
- All `record*` and `createEvidenceLedger` helpers in `evidence.ts` accept `briefHash` and propagate it.
- `analyzeBriefDrift` accepts and includes `briefHash` in the returned report.
- Sessions written before this spec is implemented load without crashing (field is absent → treated as `null`).
- `npm run test-ci` passes (typecheck → lint → test).

## Quality Bar For Implementing Agents

- No new runtime dependencies. Use Node's built-in `node:crypto` for sha256.
- `canonicalJSON` is a generic pure utility: no tiny-spec strings, no `Task` import.
- `hashTaskBrief` strips only fields that actually appear on the `Task` schema and are mutable: `status`. No other fields exist on `Task` to strip.
- `briefHash` is always written as a string or `null`, never omitted from new artifacts.
- Old session files may have the field absent — readers tolerate both absent and `null`.
- Do not add `briefHash` to `src/core/schemas/task.ts` or `tasks.md` transport — those are the source; the hash is derived.
- Evidence and drift functions return new values; they do not mutate.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript 6.x, ESM-only (`.js` import suffixes required).
- Tests: Vitest 4, colocated.
- No classes anywhere in `src/`.
- No barrel `index.ts` files.
- Never run `git add`, `git stage`, or `git commit`.
- All new file names: kebab-case.
