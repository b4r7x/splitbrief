# Decisions

## ADR-001 - This Spec Patches Semantics, Not Surface Area

The existing modules are mostly present and the test suite passes. The remediation must patch incorrect contracts instead of rewriting subsystems.

**Decision:** make narrow, behavior-focused fixes in the existing architecture. Add files only when they isolate a missing contract or improve testability.

## ADR-002 - Pre-Apply Approval Means No Mutation Before Consent

Post-apply approval plus rollback is not equivalent to approval. It can lose user edits and it violates the safety specs.

**Decision:** write-producing runners must expose intended changes before mutation, write into a safe staging boundary, or otherwise guarantee denial leaves the worktree unchanged.

## ADR-003 - Detached Mode Uses The Same Prompt Contract As Inline Mode

Detached workflows must not auto-approve, auto-continue, or answer empty strings just because no TUI is attached.

**Decision:** detached server callbacks become pending IPC prompt requests. Attached clients answer them. Headless mode fails closed when it cannot prompt.

## ADR-004 - Snapshot Safety Beats Convenience

Snapshots exist to protect user work. Any restore/reject operation that cannot prove current content is safe to overwrite must conflict and remain retryable.

**Decision:** conflicts and missing blobs do not mark run rejection complete. Stored blobs are verified before restore.

## ADR-005 - Current MCP Compliance Is The Target

The current implementation is a simple JSON-RPC POST endpoint. The product docs present it as an MCP resource server.

**Decision:** implement current Streamable HTTP MCP behavior for the supported subset: initialize, initialized notification, resources/list, resources/read, protocol-version handling, GET behavior, Origin validation for local security, and correct notification status codes.

## ADR-006 - Tests Prove User Contracts

Many gaps survived because tests asserted wiring or fake sockets rather than real behavior.

**Decision:** every fix must include a behavior test that would have failed before the fix.

