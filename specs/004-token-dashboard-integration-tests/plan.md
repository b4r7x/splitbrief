# Implementation Plan: Pluggable Orchestrator, Token Dashboard & Integration Tests

**Branch**: `004-token-dashboard-integration-tests` | **Date**: 2026-03-26 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/004-token-dashboard-integration-tests/spec.md`

## Summary

Transform diptych from a hardcoded Claude Code + Ollama tool into a pluggable orchestrator supporting multiple planner backends (Claude Code, Codex, OpenCode, Aider, Agent SDK) and multiple implementers. Add a rich token usage dashboard with cost savings display, live token counter in the status bar, and a comprehensive integration test suite validating the full workflow end-to-end.

## Technical Context

**Language/Version**: TypeScript 5.9+ (upgrading to 6.0), ESM only
**Primary Dependencies**: ink 5.x, react 18.x, openai ^6.0.0, yaml, simple-git, commander ^14.0.0
**Storage**: JSON files (state.json, events.jsonl), Markdown files
**Testing**: `tsx --test` (Node.js native test runner), 132 existing tests
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool
**Performance Goals**: <2s TUI startup, <1s between tasks, summary render <1s
**Constraints**: <200MB RSS, task prompts <8K tokens for 7B models
**Scale/Scope**: Single-user CLI, 10-15 tasks per feature, 5 planner backends

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | ✅ PASS | Extends cost optimization with dynamic pricing, pluggable backends, and visible savings dashboard |
| II. Spec-Driven Development | ✅ PASS | Full speckit workflow followed (specify → clarify → plan) |
| III. Local-First Implementation | ✅ PASS | Local implementers remain default; planner backends are configurable |
| IV. Functional Purity | ⚠️ VIOLATION | Planner interface uses object with function properties, not classes. See Complexity Tracking. |
| V. Validate Before Commit | ✅ PASS | Validation pipeline unchanged |

**Constitution constraint requiring justification**: "Planner: Claude Code CLI (claude -p) as subprocess" — we're expanding this to support multiple planner backends. This extends the principle rather than violating it. Claude Code remains the default.

**Post-Phase 1 re-check**: ✅ All gates pass. Interface pattern uses factory functions returning plain objects, staying within "zero classes" constraint.

## Project Structure

### Documentation (this feature)

```text
specs/004-token-dashboard-integration-tests/
├── spec.md
├── plan.md              # This file
├── research.md          # 8-agent research findings
├── data-model.md        # Entity definitions
├── quickstart.md        # Usage guide
├── contracts/
│   └── cli-commands.md  # CLI interface updates
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── cli.ts                          # CLI entry (add --planner flags)
├── app.tsx                         # Root Ink (add screen switching)
├── types.ts                        # Add PlannerBackend, TaskTokenUsage, CostBreakdown, expand Config
├── config.ts                       # Accept multiple planner tools, pricing config
├── state.ts                        # (minimal changes)
├── orchestrator/
│   ├── orchestrator.ts             # Dynamic pricing, token callbacks, task breakdown tracking
│   ├── planner.ts                  # Refactor: extract interface, keep as Claude Code backend
│   ├── implementer.ts              # (unchanged)
│   ├── validator.ts                # (unchanged)
│   ├── escalator.ts                # Route through planner backend
│   ├── extractor.ts                # (unchanged)
│   ├── claude-stream.ts            # (unchanged — used by Claude Code backend)
│   ├── providers.ts                # (unchanged)
│   ├── pricing.ts                  # NEW: pricing table lookup
│   └── planners/                   # NEW: planner backend implementations
│       ├── types.ts                # PlannerBackend interface
│       ├── factory.ts              # createPlanner() factory
│       ├── claude-code.ts          # Current planner.ts logic extracted
│       ├── codex.ts                # Codex CLI subprocess
│       ├── opencode.ts             # OpenCode subprocess
│       ├── aider.ts                # Aider subprocess
│       └── agent-sdk.ts            # Anthropic Agent SDK
├── tui/
│   ├── layout.tsx                  # (unchanged)
│   ├── pane.tsx                    # (unchanged)
│   ├── status-bar.tsx              # Add planner name + live token counter
│   ├── header.tsx                  # (unchanged)
│   ├── prompt.tsx                  # (unchanged)
│   └── summary.tsx                 # NEW: full-screen completion dashboard
├── spec/
│   ├── parser.ts                   # (unchanged)
│   ├── templates.ts                # Generalize "Opus" references
│   └── formatter.ts                # (unchanged)
└── utils/
    ├── process.ts                  # (unchanged)
    ├── git.ts                      # (unchanged)
    ├── fs.ts                       # (unchanged)
    └── format.ts                   # NEW: formatTokens(), formatCost(), formatTime()

tests/
├── (existing unit tests)           # Update pricing-related tests
├── pricing.test.ts                 # NEW: pricing table tests
├── planners.test.ts                # NEW: planner factory + interface tests
├── summary.test.ts                 # NEW: cost breakdown calculation tests
├── integration/
│   ├── fixtures.ts                 # Fixture file content constants
│   ├── helpers.ts                  # createFixtureProject(), cleanup
│   ├── connectivity.ts             # Service availability checks
│   ├── guard.ts                    # Env var + connectivity guard
│   ├── claude.integration.test.ts  # Claude Code planner test
│   ├── ollama.integration.test.ts  # Ollama implementer test
│   ├── validation.integration.test.ts # Validation pipeline test
│   ├── tokens.integration.test.ts  # Token accumulation test
│   ├── retry.integration.test.ts   # Retry pipeline test
│   └── resume.integration.test.ts  # Workflow resume test
```

**Structure Decision**: Single project structure (Option 1). New code goes into `src/orchestrator/planners/` for backend implementations and `tests/integration/` for integration tests. No new top-level directories needed.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| PlannerBackend interface (object with functions) | Need polymorphic dispatch across 5 backends | A simple `switch` statement in orchestrator.ts would create a 500+ line function mixing 5 backend protocols. Factory function returning typed object keeps each backend isolated in its own module. |
| Expanding `planner.tool` beyond `'claude-code'` | Constitution says "Planner: Claude Code CLI" | Claude Code remains the default. The constitution constraint was written for v0.1 scope. Expanding to other tools extends the principle (cost optimization via multiple planners) rather than violating it. |
| Pricing table as static data | Need pricing for cost calculations across providers | Dynamic pricing API queries would add latency and network dependency. Static table is updatable in one file. |
