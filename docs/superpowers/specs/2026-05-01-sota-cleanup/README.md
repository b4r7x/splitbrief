# SOTA Audit: Codebase Cleanup - 2026-05-01

> **Status:** Ready for execution.
> **Scope:** Fix bugs, DRY violations, type safety issues, testing gaps identified by 9-agent Opus audit.
> **Write scope:** `src/` only. No new features, no TUI changes, no architecture changes.
> **Out of scope:** UX improvements, session model redesign, extension system, TUI rewrite.

## Problem

A 9-agent SOTA audit compared diptych against pi-mono (benchmark project). Technically the codebase scores 4.0/5 overall — clean conventions, good layering. But specific measurable issues prevent 5/5:

- 1 layer inversion (events imports from orchestrator)
- 1 god-function (488-line `runSingleTask`)
- 1 dead field rendered in UI
- 1 performance bug (full-state selector re-renders everything)
- 5 DRY violations
- 4 type safety issues
- 3 dead code items
- 6 test files needing deletion/rewrite
- Missing behavioral test infrastructure (faux provider)

## Decisions

See `decisions.md` for architectural choices and rationale.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals |
| 2 | `decisions.md` | Why each change, what NOT to do |
| 3 | `execute-prompt.md` | Copy-paste prompt for opencode coordinator |
| 4 | `agent-briefs/01-layer-fix.md` | Move workflow-events.ts |
| 5 | `agent-briefs/02-bugs-and-dry.md` | Fix bugs + DRY extraction |
| 6 | `agent-briefs/03-type-safety.md` | OTel casts, selectors, consistency |
| 7 | `agent-briefs/04-test-infra.md` | Faux provider + test cleanup |

## Non-Goals

- Do not add new features or UX changes.
- Do not refactor TUI components.
- Do not build extension/plugin system.
- Do not remove IPC subsystem (ps/attach/detach depends on it).
- Do not rewrite `runWorkflow` closure pattern (deferred — risk of subtle bugs).
- Do not unify truncation functions (deferred — domain markers make it non-trivial).
