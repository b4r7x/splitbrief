# Decisions

## ADR-001 - Append-Only Tree, Not Mutable Log

**Status:** accepted
**Date:** 2026-05-01

### Context

The current `session.jsonl` is a flat append-only log. Entries are never edited or deleted. Recovery retries currently discard the failed attempt's context entirely because there is no structural way to represent "this sequence was abandoned, a new sequence starts from this earlier point."

### Decision

Keep the append-only invariant. Entries are never mutated or deleted after write. Branching is expressed structurally via `parentId` pointers, not by rewriting history. A mutable `leafId` pointer in a separate metadata record tracks which leaf is the current active tip.

### Consequences

- No entry is ever lost. Failed branches remain queryable.
- The file format remains crash-safe (append + fsync).
- `leafId` is the only mutable pointer; it lives in a small sidecar file (`tree-meta.json`), not inline in the JSONL.
- Replaying the tree requires reading all entries and reconstructing parent-child relationships in memory.

## ADR-002 - JSONL Not SQLite For Entry Persistence

**Status:** accepted
**Date:** 2026-05-01

### Context

SQLite would give indexed queries, transactions, and efficient subtree reads. However:

- The project already uses JSONL for session logs (`session.jsonl`).
- Adding `better-sqlite3` creates a native dependency with build/platform complexity.
- Session trees are bounded in size (hundreds to low thousands of entries per session, not millions).
- The append-only write pattern maps perfectly to JSONL (one JSON object per line, append, fsync).
- Zod validation on read provides schema safety without a query layer.

### Decision

Use JSONL (`session-tree.jsonl`) for entry persistence. One JSON object per line. Read the full file into memory on session resume, reconstruct the tree in-memory. Write new entries by appending lines.

### Consequences

- No native dependency added.
- Consistent with existing `session.jsonl` pattern.
- Tree queries (path-to-root, subtree, siblings) are in-memory operations on a `Map<EntryId, TreeEntry>`.
- If sessions grow very large (>10k entries), a future migration to SQLite or indexed format can be considered, but current workflow sizes (tens of tasks, few recovery branches) make this unlikely.

## ADR-003 - Tree Not Graph

**Status:** accepted
**Date:** 2026-05-01

### Context

A general DAG would allow entries to have multiple parents (merge commits, join points). This adds complexity to traversal, active-path semantics, and rendering.

### Decision

Enforce single-parent constraint: every entry has exactly one `parentId` (or `null` for the root). The data structure is a rooted tree, not a DAG.

### Consequences

- Path from any entry to root is unique and unambiguous.
- Active path is a simple leaf-to-root chain.
- No merge semantics needed.
- If future work needs convergent branches (e.g., "merge learnings from two parallel attempts"), it can be modeled as a new entry that references prior entries in its payload, without changing the tree topology.

## ADR-004 - Summarize Failed Branch, Not Carry Full Context

**Status:** accepted
**Date:** 2026-05-01

### Context

When recovery branches, the retry needs to know what was tried and why it failed. Two options:

1. **Carry full context:** include all entries from the failed branch in the retry's LLM prompt. This is expensive (tokens), potentially exceeds context windows, and includes noise (intermediate outputs, validation logs).
2. **Summarize:** call the planner LLM to produce a structured summary of the failed branch, then inject only that summary into the retry context.

### Decision

Summarize the failed branch into a structured format (Goal / Progress / Decisions / Constraints / Next Steps). Inject the summary as a `branch-summary` entry at the start of the new branch. The summary is typically 200-500 tokens vs potentially thousands for full context.

### Consequences

- Retry context stays bounded regardless of failed branch length.
- Structured summary format gives the retry LLM actionable information, not raw noise.
- Summary generation adds one LLM call per recovery branch (cheap planner call, not implementer).
- The full failed branch remains in the tree for human inspection; only the summary is injected into the retry prompt.
- If the planner is unavailable or summarization fails, fall back to a mechanical summary (entry count, last error, elapsed time).

## ADR-005 - Entry Type Is A String Discriminant, Not A Zod Discriminated Union At Storage Level

**Status:** accepted
**Date:** 2026-05-01

### Context

The `EngineEvent` type uses a TypeScript union with `type` as the discriminant. This works well for a closed set of known events. However, session tree entries need to be extensible (new entry types added without schema migration) and the payload shapes vary significantly.

### Decision

Store entries with a `type: string` field and a `payload: unknown` field in the JSONL. On read, validate the envelope (`id`, `parentId`, `type`, `timestamp`) strictly, and validate `payload` per-type using a registry of Zod schemas. Unknown types are preserved as opaque entries (not rejected).

### Consequences

- New entry types can be added without migrating existing JSONL files.
- Old readers encountering new types skip payload validation but preserve the entry.
- Type-safe access requires passing through the registry: `parseEntry(raw)` returns a typed result or an opaque fallback.
- The registry pattern is similar to how `EngineEvent` works but with runtime extensibility rather than compile-time exhaustiveness.

## ADR-006 - leafId Lives In A Sidecar File, Not Inline In JSONL

**Status:** accepted
**Date:** 2026-05-01

### Context

The `leafId` pointer changes on every append and on every branch operation. If stored inline in the JSONL, it would either require rewriting the last line (violating append-only) or appending pointer-update entries (cluttering the log with meta-noise).

### Decision

Store `leafId` (and minimal tree metadata like entry count and branch count) in a separate `tree-meta.json` file alongside `session-tree.jsonl`. This file is overwritten atomically on each pointer update.

### Consequences

- JSONL remains pure append-only entries.
- `tree-meta.json` is small (< 200 bytes) and can be written atomically (write-to-temp + rename).
- On crash without clean shutdown, `leafId` can be reconstructed by finding the last-appended entry.
- Resume logic reads `tree-meta.json` first, then streams `session-tree.jsonl` for full reconstruction.
