# Cleanup Plan

## Purpose

Cleanup should make diptych easier to understand as a cost-aware planner-to-cheap-implementer orchestrator. It should not randomly delete advanced code that still provides safety.

## Accepted Cleanup

### Product language

Update docs that make diptych sound like:

- a plan archive,
- a kanban tool,
- a separate plan-management system,
- a generic interop hub,
- a multi-agent coordinator.

Replace with:

- expensive planner,
- self-contained Task Briefs,
- cheap implementer workers,
- checkpoints,
- validation,
- drift/evidence,
- durable workflow sessions,
- escalation.

Session history is core: resume, previous-session browsing/filtering/search, and artifacts such as `spec.md`, `plan.md`, `tasks.md`, `summary.json`, `review.md`, evidence, and drift. That history must be framed as workflow records, not as a plan archive, kanban board, or cross-plan orchestration system.

### Config drift

Fix stale examples that use old keys such as:

- `planner.tool`,
- `implementer.provider`,
- `api_base`,
- `context_length`,
- `commit_per_task`,
- `auto_approve_*`.

Current docs should use the current config schema and camelCase fields.

### Commit language

This repository forbids agent staging and commits. Docs should not tell implementation agents to commit after tasks. Product-level support for commits, if kept, must be documented separately from this repo's agent workflow.

### Task Contract framing

`docs/TASK-CONTRACT.md` can mention external consumers, but it should not lead with Kanban/Jira/exporter use cases. The main use case is internal executable handoff to cheap implementers.

### MCP boundary

Keep MCP docs clear:

- read-only resources,
- localhost,
- external tools may read session artifacts,
- no MCP tools/mutations in this roadmap.

### Test policy

Remove or rewrite tests only when they are touched by this work and fail the behavior test:

- trivial hook wrapper tests,
- no-crash snapshots,
- private helper call-count assertions,
- duplicated assertions already covered by integration behavior.

Keep tests for:

- task routing decisions,
- context-fit classification,
- plan save parse/quality gate,
- user-edit conflict blocking,
- snapshot/hash safety,
- validation and final artifacts.

## Candidates To Demote From Primary Docs

These surfaces may remain implemented, but should not be presented as the main product path:

- handoff packs,
- MCP server,
- snapshots CLI,
- worktree management,
- attach/detach/ps,
- plan editor advanced actions,
- exhaustive docs/superpowers historical packs.

## Do Not Remove Blindly

### Snapshots

Snapshots are adjacent to undo/versioning, but checkpoint safety is important to the agreed direction. Do not delete before the checkpoint UX is settled.

### Worktrees

Worktrees can become the safe boundary for future isolated parallel execution. Demote from primary product story if needed, but do not delete just because same-checkout parallel writes are out of scope. Do not describe same-checkout parallel writes as acceptable or near-term.

### Handoff packs

Handoff packs can be useful for users who want another tool to execute a compiled Task Brief. They should not become the main product identity.

### MCP

Read-only MCP resources are a useful way for Claude Code/Codex/Cursor to inspect diptych artifacts. Do not add write tools in this roadmap.

### Plan editor

The plan editor is complex, but it supports the key user need: manual changes before cheap execution. Simplify its purpose before removing it.

## Specific Audit Notes To Review During Implementation

- `src/engine/orchestrator/task-commit.ts` and `src/lib/git.ts` contain commit/stage helpers. Do not call these from new work.
- `docs/FEATURES.md` is broad and may need a core/advanced split.
- `docs/CONCEPTS.md` and `docs/TASK-CONTRACT.md` should be checked for plan/archive/export-first language.
- `README.md` has stale config examples and should be refreshed.
- `docs/ARCHITECTURE.md` generated inventory counts can drift; consider removing generated counts or regenerating them mechanically.
- `src/features/workflow/hooks/use-ipc-client.test.tsx`, command palette tests, MCP/snapshot/worktree tests, and task commit tests should be judged by whether their surfaces remain core or advanced.

## Cleanup Done Criteria

- A new reader understands the product from docs without reading historical spec packs.
- Advanced features are labeled as advanced or experimental when they are not part of the core loop.
- Session history is preserved as core workflow surface and distinguished from a plan archive.
- No docs tell implementation agents to stage or commit.
- Test count may go down if low-value tests are removed, but confidence around routing/conflict/plan-save behavior goes up.
