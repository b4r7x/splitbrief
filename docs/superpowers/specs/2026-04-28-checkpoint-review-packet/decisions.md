# Decisions

## ADR-001 - Use "Checkpoint" As UX Language Over Snapshot Storage

**Status:** accepted
**Date:** 2026-04-28

### Context

The codebase already has snapshots with baseline/delta storage, hash-guarded restore, diff, and auto-trigger support. Users think in terms of "safe points" during a run, not storage internals.

### Decision

Use **checkpoint** in user-facing run and review UX. Keep **snapshot** as the engine, schema, and CLI noun unless a separate rename is explicitly scoped.

### Consequences

- Existing `diptych snapshot ...` commands remain valid.
- Summary and review packet can label meaningful snapshots as checkpoints.
- Future code should avoid duplicating snapshot storage logic for checkpoint UX.

## ADR-002 - Review Packet Is A Session Artifact, Not A Plan Archive

**Status:** accepted
**Date:** 2026-04-28

### Context

Durable sessions are core to diptych. A final review packet can look like a plan-management feature if it becomes cross-session, searchable, editable, or reusable as a backlog.

### Decision

Store the packet only inside the current session directory:

```text
.diptych/sessions/{sessionId}/review-packet.json
.diptych/sessions/{sessionId}/review-packet.md
```

It is an execution record for one run.

### Consequences

- No saved-plan library.
- No searchable saved-plan or backlog objects.
- No kanban.
- No cross-plan dependencies.
- No plan cloning or plan archive semantics.
- Session browsing and session-history search may show the packet as a run artifact, alongside other execution artifacts.
- Search over session history is allowed and core to durable sessions; reusable plan/backlog search is out of scope.

## ADR-003 - JSON Is Canonical, Markdown Is Human-Facing

**Status:** accepted
**Date:** 2026-04-28

### Context

The TUI and future read-only resources need structured data. Humans and PR reviewers need a Markdown artifact that can be skimmed.

### Decision

Write both:

- `review-packet.json`: canonical, versioned, schema-validated data.
- `review-packet.md`: rendered human packet.

### Consequences

- TUI should read summary rollups or JSON, not parse Markdown.
- Markdown rendering can change without breaking machine consumers.
- Tests should assert JSON shape and key Markdown headings/checklist items.

## ADR-004 - Packet Aggregates Existing Evidence Before Adding New Signals

**Status:** accepted
**Date:** 2026-04-28

### Context

Diptych already writes `summary.json`, `review.md`, `evidence.json`, `drift-report.json`, snapshot manifests, and event logs. The trust gap is discoverability, not lack of raw data.

### Decision

The first implementation should aggregate existing artifacts and derive compact rollups. Add new event/schema fields only where an existing signal cannot be reconstructed safely.

### Consequences

- Smaller implementation surface.
- Lower risk of contradictory status.
- Missing artifacts are represented explicitly in `missingArtifacts`.

## ADR-005 - Restore Remains Explicit And Hash-Guarded

**Status:** accepted
**Date:** 2026-04-28

### Context

Restore can overwrite user work. The existing snapshot restore behavior skips conflicted files unless `--force` is passed.

### Decision

Checkpoint UX must explain restore and point to exact commands, but it must not perform restore implicitly.

### Consequences

- No automatic restore after failed final review.
- No hidden run rollback.
- `--force` remains explicit and visually marked as destructive.
- Partial restore with conflicts is treated as expected behavior.

## ADR-006 - Summary TUI Is An Index, Not A Diff Viewer

**Status:** accepted
**Date:** 2026-04-28

### Context

The summary screen already carries cost, evidence, drift, timing, and task rows. Rendering full diffs or full planner reviews would make it noisy and brittle in small terminals.

### Decision

Summary TUI renders compact checkpoint and packet sections with artifact paths, status, counts, and commands. Detailed review stays in files and CLI diff output.

### Consequences

- Better terminal ergonomics.
- No large diff rendering in Ink.
- The review packet Markdown becomes the durable human artifact.

## ADR-007 - No MCP Writes Or Same-Checkout Parallelism

**Status:** accepted
**Date:** 2026-04-28

### Context

This feature touches trust, recovery, and review. Adding write-capable MCP tools or parallel workers would blur ownership and safety semantics.

### Decision

Do not add MCP write tools. Do not add hidden worker fan-out or parallel same-checkout writes.

### Consequences

- Existing read-only MCP resources may later expose packet artifacts, but that is optional and must stay read-only.
- Checkpoint, evidence, drift, and review attribution stays one-run and one-writer-at-a-time.
