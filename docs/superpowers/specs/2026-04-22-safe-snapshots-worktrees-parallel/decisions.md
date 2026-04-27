# Decisions

## ADR-001 — Restore Only When Hash Matches Last Diptych Write

**Status:** accepted

### Decision

Run reject restores a file only if its current hash equals the last hash written by diptych.

### Rationale

The user may edit files while or after a run. A restore feature must not erase those edits.

## ADR-002 — Parallel Execution Means Worktrees, Not Same-Directory Concurrency

**Status:** accepted

### Decision

Diptych continues to allow one active session per project directory. Parallel sessions are supported by creating/running separate git worktrees.

### Rationale

Multiple agents writing one working tree creates conflicts and unclear ownership. Worktrees provide natural filesystem and `.diptych/` isolation.

## ADR-003 — No Git Staging Or Commits

**Status:** accepted

### Decision

Snapshot and worktree features can create branches/worktrees when explicitly requested, but they must not stage or commit.

### Rationale

The repo instructions prohibit staging/committing. User keeps ownership of final git history.
