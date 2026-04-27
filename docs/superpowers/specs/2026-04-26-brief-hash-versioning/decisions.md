# Decisions

> Originating decision: ADR-008 in `docs/superpowers/specs/2026-04-22-external-agent-handoff-packs/decisions.md`. This spec implements what ADR-008 mandated. Read that ADR first.

## ADR-001 — Hash Algorithm: sha256 of Canonical JSON of Immutable Task Fields

**Status:** accepted

### Context

We need a deterministic, stable fingerprint of a compiled Task Brief (`Task[]`). The fingerprint must:
- be identical for two arrays with the same semantic content regardless of JS object key insertion order,
- change when the planner changes any immutable field (title, file, description, tests, constraints, etc.),
- not change when the orchestrator mutates runtime-only state (task `status`).

### Decision

`briefHash = hex(sha256(canonicalJSON(immutableSlices)))` where:
- `canonicalJSON` is a recursive RFC-8785-style serializer: sorts object keys lexicographically at every level, preserves array order, omits `undefined` properties.
- `immutableSlices` is `tasks.map(stripMutableFields)` where `stripMutableFields` removes `status` (the only mutable field on `Task`).
- `sha256` uses Node's built-in `node:crypto` (`createHash('sha256').update(str).digest('hex')`).

### Rationale

- SHA-256 is universally available in Node (no dependency).
- Canonical JSON avoids false mismatches from key-order differences across JS engines or serializers.
- Hashing the whole array (not per-task) gives handoff consumers a single value to compare; per-task hashes are redundant since the packs already name tasks by ID.
- Stripping only `status` is correct because it is the only field on `Task` modified by the orchestrator at runtime. Retry counts and timestamps live on `WorkflowState`, not on `Task` itself.

### Rejected alternatives

- **Use git commit hash.** Brief regeneration does not always produce a commit. A brief can be regenerated mid-run without any commit occurring.
- **Per-task hash only.** Handoff packs need a single aggregate hash to identify the whole pack.
- **md5.** Shorter but deprecated in security contexts; sha256 costs nothing extra.
- **Stable JSON (no key sort).** V8's key order is insertion-order stable, but relying on engine behaviour is fragile across Node versions.

## ADR-002 — Mutable Fields Excluded From Hash Input

**Status:** accepted

### Context

`Task` schema fields as of `src/core/schemas/task.ts`: `id`, `title`, `action`, `file`, `dependsOn`, `description`, `signature`, `currentCode`, `tests`, `constraints`, `pattern`, `typeDefs`, `implementationSteps`, `scope`, `escalation`, `evidence`, `status`.

Only `status` changes during a run (transitions through `pending → in_progress → done/failed/escalated/skipped`). All other fields are written once by the planner and never modified by the orchestrator.

### Decision

Strip exactly `status` before computing the canonical JSON. No other fields are excluded.

### Rationale

There are no retry-count or timestamp fields on `Task`. Those values live at `WorkflowState.attempt` and `WorkflowState.startedAt`, which are not hashed at all. Adding speculative exclusions to cover fields that do not exist would be confusing and would silently weaken the hash (two briefs that differ in, say, `description` would produce the same hash if `description` were also excluded).

### Rejected alternatives

- **Strip more fields (e.g., `currentCode`, `evidence`) "just in case."** These are planner-authored. Stripping them would allow silent brief drift without a hash change.
- **Include `status` in the hash.** Would cause the hash to change on every task status transition, making it useless as a brief-identity marker.

## ADR-003 — Mid-Run Regeneration: Old Evidence Keeps Old Hash

**Status:** accepted

### Context

If the user triggers a re-plan or `/redo` mid-run, the planner produces a new `Task[]`. The hash changes. Evidence entries already written for completed tasks must not be silently invalidated.

### Decision

When a brief is regenerated:
- `hashTaskBrief(newTasks)` produces a new hash.
- All `record*` calls after regeneration pass the new hash; entries written from that point carry the new hash.
- Entries written before regeneration retain the old hash; they are not rewritten.
- The `DriftReport` carries the hash that was current when `analyzeBriefDrift` was called (end-of-run).
- External tooling can detect a mid-run regeneration by observing two distinct `briefHash` values across `EvidenceTask` entries in the same ledger.

### Rationale

- Rewriting old evidence entries would destroy forensic traceability.
- The hash on an evidence entry answers: "what brief was the implementer working from when this task completed?"
- Keeping old entries immutable preserves that answer correctly.

### Rejected alternatives

- **Rewrite all evidence entries to the new hash on regeneration.** Loses the record of what the implementer was actually told. Breaks forensic correlation.
- **Reject regeneration if evidence already exists.** Too restrictive; re-plans after failed tasks are a normal workflow.

## ADR-004 — Storage Locations for `briefHash`

**Status:** accepted

### Context

ADR-008 in the handoff-packs spec lists four storage locations for `briefHash`. This spec implements two of them (evidence + drift) and forward-references the other two (manifest + task frontmatter in handoff packs).

### Decision

**In scope for this spec:**
1. Per-`EvidenceTask` entry in `evidence.json` — `briefHash: string | null`. Each entry carries the hash that was active when the task completed.
2. Top-level on `EvidenceLedger` in `evidence.json` — `briefHash: string | null`. Reflects the hash at ledger-creation time; may differ from some entries if regeneration occurred.
3. `DriftReport` in `drift-report.json` — `briefHash: string | null`. The hash at the time drift analysis ran.

**Forward reference only (implemented by handoff-packs spec):**
4. `manifest.json` at the pack root — `briefHash: string`. Required by ADR-005 in the handoff-packs spec.
5. YAML frontmatter in each `tasks/T0NN.md` file — referenced in ADR-008.

### Rationale

- Evidence and drift are session-internal artifacts; this spec owns them.
- Manifest and task frontmatter are handoff artifacts; adding them here would couple two independent specs.
- Two locations in `evidence.json` (top-level + per-entry) serve different queries: top-level answers "what brief was this session compiled from?" and per-entry answers "what brief was this task working from?"

### Rejected alternatives

- **Only per-entry, no top-level.** Makes it harder to query the nominal session brief without scanning all entries.
- **Only top-level, no per-entry.** Cannot detect mid-run regeneration.

## ADR-005 — Backwards Compatibility: Absent Field Treated As Null

**Status:** accepted

### Context

Sessions written before this spec is implemented do not have `briefHash` in their `evidence.json` or `drift-report.json`. Readers must not crash on old files.

### Decision

- `EvidenceTaskSchema`: `briefHash: z.string().nullable().optional()`.
- `EvidenceLedgerSchema`: `briefHash: z.string().nullable().optional()`.
- `DriftReport` TypeScript type: `briefHash: string | null | undefined`.
- Writers always emit the field (never omit), writing `null` when no hash is available. This ensures new artifacts are unambiguously distinguishable from legacy ones.
- Readers tolerate absent (undefined) and `null` identically — both mean "hash not available."

### Rationale

- Zod `.optional()` handles the absent (legacy) case.
- `.nullable()` handles the explicit `null` case from writers that have the hash infrastructure but computed a null (e.g., empty task list).
- Making writers always emit the field prevents a new reader from needing to distinguish "written by new code, hash is null" from "written by old code, field absent."

### Rejected alternatives

- **Hard-required field.** Old sessions break immediately. Rejected.
- **Omit field when null.** Makes new artifacts indistinguishable from legacy ones; complicates consumer logic.

## ADR-006 — Canonical JSON Utility Location

**Status:** accepted

### Context

The `canonicalJSON` serializer is a pure, domain-agnostic function (no tiny-spec strings, no `Task` import). `hashTaskBrief` is domain-aware: it imports `Task` and knows to strip `status`. These have different layer constraints per `docs/LAYERS.md`.

### Decision

- `src/utils/canonical-json.ts` — exports `canonicalJSON(value: unknown): string`. Pure, generic, no tiny-spec domain knowledge. Placement: `utils/` (could be published as an npm package with no changes).
- `src/core/brief-hash.ts` — exports `hashTaskBrief(tasks: Task[]): string`. Imports `Task` from `core/schemas/task.ts` and `canonicalJSON` from `utils/canonical-json.ts`. Placement: top-level `core/`, sibling to `paths.ts`. Not under `core/schemas/` (that folder is for Zod schemas and their inferred types only, per LAYERS.md).

### Rationale

- `utils/` acceptance criteria: "pure function or small stateless module, no tiny-spec string literals, reusable across unrelated projects." `canonicalJSON` qualifies.
- `core/` acceptance criteria: "knows tiny-spec concepts, no React, no subprocess spawning." `hashTaskBrief` qualifies; it names `Task` (a tiny-spec domain type).
- `core/schemas/` is reserved for Zod runtime schemas + `z.infer<>` types. A pure hash function that happens to take `Task` as input does not belong there.

### Rejected alternatives

- **Both in `src/utils/`.** `hashTaskBrief` imports `Task` (a domain type) — that violates `utils/` acceptance criteria ("no tiny-spec string literals or domain imports").
- **Both in `src/core/schemas/`.** `canonicalJSON` has no domain knowledge; placing it in `schemas/` suggests a Zod schema relationship that does not exist.
- **Both in `src/engine/`.** The hash is needed by the evidence/drift modules but also by future handoff-pack writers and any code that needs brief identity. Engine is not the right layer for a domain primitive used across layers.
- **Single file in `src/core/`.** Would require importing `Task` into a file that is nominally a generic utility, or keeping the domain split clear with a bit more code. Two small files is better than one that mixes layers.
