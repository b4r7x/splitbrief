<!--
Sync Impact Report
- Version change: (new) → 1.0.0
- Added principles: I. Cost-Optimal Orchestration, II. Spec-Driven Development,
  III. Local-First Implementation, IV. Functional Purity, V. Validate Before Commit
- Added sections: Technical Constraints, Development Workflow
- Removed sections: none (initial ratification)
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ compatible (generic Constitution Check gate)
  - .specify/templates/spec-template.md ✅ compatible (no principle-specific sections)
  - .specify/templates/tasks-template.md ✅ compatible (story-based organization)
- Follow-up TODOs: none
-->

# tiny-spec Constitution

## Core Principles

### I. Cost-Optimal Orchestration

Expensive AI (Claude Opus) MUST be used only for tasks where its quality
materially impacts outcomes: codebase research, specification writing,
planning, validation, and escalation. Implementation MUST be delegated
to cheap or local models via the OpenAI-compatible API.

Every architectural decision MUST be evaluated against token cost.
Features that increase Opus token consumption without proportional
quality improvement MUST be rejected or deferred.

The user's existing Claude Code subscription MUST be the primary
interface to Opus -- no separate API keys or additional costs for
the planning phase.

### II. Spec-Driven Development

No code is written without a specification. The workflow MUST follow:
research → spec → plan → tasks → implement → validate → review.

Each implementation task MUST be self-contained: all context needed
by the local model (function signatures, types, current code, test
expectations, constraints) MUST be inlined in the task prompt. Tasks
MUST NOT reference external files or assume the model has access to
the broader codebase.

Task prompts for models under 15B parameters MUST target a single
function per task. Total prompt size MUST stay under 8K tokens for
7B models and under 16K tokens for 27B models.

### III. Local-First Implementation

The implementation phase MUST default to local model inference
(Ollama, LM Studio) with zero cloud API cost. Cloud API providers
(DeepSeek, OpenRouter) are supported as opt-in alternatives.

The tool MUST work without internet access during the implementation
phase when using local models. Only the planning phase (Claude Code)
and optional cloud providers require network connectivity.

Provider abstraction MUST be thin (baseURL swap via the `openai`
npm package). Adding a new OpenAI-compatible provider MUST NOT
require architectural changes.

### IV. Functional Purity

Zero classes. All modules MUST use pure functions and module-scoped
state only. No class hierarchies, no `this` binding, no inheritance.

ESM imports MUST use `.js` extensions for compatibility with both
`--experimental-strip-types` (dev) and `tsc` output (production).

Error handling follows boundaries: internal functions propagate
errors, boundary functions (CLI, orchestrator callbacks) catch and
handle them. No defensive try/catch in interior modules.

No unnecessary comments. Code MUST be self-explanatory. Comments
are permitted only where the logic is genuinely non-obvious.

### V. Validate Before Commit

Every task implementation MUST pass the validation pipeline before
being committed. The pipeline runs in order of speed and cost:
1. TypeScript typecheck (`tsc --noEmit`)
2. Lint (ESLint or Biome, auto-detected)
3. Affected tests (matched by file naming convention)

Validation MUST stop on first failure. Failed tasks MUST NOT be
committed. Retry prompts MUST include the exact error message,
line number, and relevant code context.

After all tasks complete, a final Opus review MUST compare the
full diff against the original specification before the workflow
is marked complete.

## Technical Constraints

- **Runtime**: Node.js 22+ with native TypeScript stripping
- **Language**: TypeScript 5.9+, ESM only (`"type": "module"`)
- **TUI**: Ink 5.x (React for CLI)
- **Target**: macOS (primary), Linux (secondary)
- **v0.1 scope**: TypeScript/JavaScript projects only
- **Planner**: Claude Code CLI (`claude -p`) as subprocess
- **Implementer**: OpenAI-compatible API (no subprocess tools)
- **Edit format**: Whole-file replacement for files under 200 lines,
  search/replace blocks for larger files

## Development Workflow

- Features MUST be specified using SpecKit (`/speckit.specify` →
  `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`)
- Tasks MUST be organized by user story, not by technical layer,
  to enable incremental delivery and independent testing
- Each commit MUST correspond to one completed task
- Git worktrees for parallel execution are deferred to v0.2;
  v0.1 executes tasks sequentially
- Tests are written alongside or after implementation (not TDD)
  unless explicitly requested for a specific feature

## Governance

This constitution supersedes all other development practices for
the tiny-spec project. All implementation decisions, code reviews,
and architectural choices MUST be evaluated against these principles.

**Amendment procedure**:
1. Propose changes via `/speckit.constitution` with rationale
2. Verify no existing features are broken by the amendment
3. Update version per semantic versioning (see below)
4. Propagate changes to dependent templates and documentation

**Versioning**: MAJOR for principle removals/redefinitions,
MINOR for new principles or material expansions, PATCH for
clarifications and wording improvements.

**Complexity justification**: Any deviation from these principles
MUST be documented in the plan.md Complexity Tracking table with:
the violation, why it is needed, and why the simpler alternative
was rejected.

**Version**: 1.0.0 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-03-25
