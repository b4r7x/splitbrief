# Decisions

## ADR-001 - This Is A Closure Spec, Not A Rewrite

**Status:** accepted

### Context

The audit found mostly-complete modules with specific semantic gaps. Rewriting whole subsystems would increase risk and collide with the existing test suite.

### Decision

Each brief must patch the narrow failing contract in the existing subsystem. New files are allowed only when they isolate a missing contract or make tests simpler.

### Consequences

- Smaller diffs and lower merge risk.
- Existing passing tests remain valuable.
- Agents must read the original spec before changing the corresponding implementation.

---

## ADR-002 - Detached Mode Must Preserve Orchestrator Semantics

**Status:** accepted

### Context

The server-client detach spec explicitly excludes changes to orchestrator semantics. A detached server that auto-approves or auto-answers callbacks is not equivalent to inline mode.

### Decision

The server owns workflow execution, but interactive decisions are represented as pending IPC requests. An attached client answers those requests. If no client is attached, the server waits for interactive workflows and fails fast only for explicitly headless modes.

### Consequences

- Detached workflows behave like inline workflows after attach.
- Budget, approval, external-change, clarification, and continuation prompts use the same policy everywhere.
- A small request/response protocol extension may be needed, but no remote/TCP attach is introduced.

---

## ADR-003 - Approval Gates Run Before Writes

**Status:** accepted

### Context

Post-apply approval cannot protect the worktree. A denial after `applyCode` is too late unless every write is reverted reliably.

### Decision

Implementer write actions must be classified and approved before the write is applied. If a pre-apply gate is impossible for a runner, that runner must use a safe staging/snapshot boundary that can guarantee denial leaves no applied changes.

### Consequences

- The approval gate may need a pre-apply hook in the implementer contract.
- Existing hook ordering is preserved as: tiered approval, then user pre-hooks, then write.
- Tests must prove denied writes do not modify the file.

---

## ADR-004 - Config Merge Is Lossless For Optional User Sections

**Status:** accepted

### Context

New optional config sections are schema-valid, but a lossy default merge can silently drop them.

### Decision

`mergeWithDefaults` must preserve every schema-supported optional top-level section unless a migration intentionally transforms it. Defaults may fill missing values, but loaded user config must not be discarded.

### Consequences

- Palette, approval, snapshots, hooks, otel, codebase, and future optional sections remain available at runtime.
- Config tests must cover unknown-to-default optional sections that are known to the schema.

---

## ADR-005 - TUI Displays Store Data, Not Recomputed Truth

**Status:** accepted

### Context

Cost UI components exist, but production events do not populate real per-phase cost/cache values.

### Decision

Provider usage is normalized in engine/store code. TUI components only subscribe and render. Cost calculation and cache-hit derivation do not live in React components.

### Consequences

- Drilldown and status line show the same values.
- Cache data renders `n/a` when a runner does not expose it.
- UI tests can use store fixtures; engine tests cover provider parsing and aggregation.

---

## ADR-006 - Snapshot Ledger Compatibility

**Status:** accepted

### Context

The older safe-run snapshot spec requested a per-run ledger with durable accept/reject flags. The newer snapshot spec introduced full-tree baseline/delta snapshots.

### Decision

Do not replace the full-tree snapshot system. Add a run ledger compatibility layer that points to snapshot IDs and stores durable `accepted` / `rejected` state plus the required before/after hashes.

### Consequences

- Existing snapshot create/list/restore/diff behavior remains.
- Run acceptance and rejection become durable and independent of snapshot naming.
- The ledger can be tested without rewriting snapshot storage.

---

## ADR-007 - Canonical Artifacts Are Source Of Truth

**Status:** accepted

### Context

MCP and handoff manifests are useful only if they reflect canonical session artifacts.

### Decision

MCP manifest reads canonical `summary.json` and `state.json` when the spec says so. Handoff append mode builds the manifest from the final artifact set, not only files written in the current invocation.

### Consequences

- Missing canonical artifacts produce resource-not-found or clear errors instead of synthetic success.
- Append mode cannot accidentally drop pre-existing task artifacts from `manifest.json`.

---

## ADR-008 - Verification Is Behavior-First

**Status:** accepted

### Context

The project follows behavior tests over implementation details.

### Decision

Every brief must add or update tests at the observable boundary: CLI output, session artifact content, rendered Ink output, store state after public actions, or file-system effects. Avoid private helper spy/call-count tests.

### Consequences

- Refactors remain possible.
- Tests prove the user-facing contract that the specs describe.

