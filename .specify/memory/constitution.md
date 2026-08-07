<!--
Sync Impact Report
- Version change: 1.3.3 → 2.0.0 (MAJOR: principles I, III and VI redefined)
- Modified principles:
  - I. Cost-Optimal Orchestration → I. Two-Tool Orchestration (ADR-3: the
    identity is orchestrating two coding tools; lower cost is a consequence,
    not the headline promise. ADR-1: the mandate to delegate implementation
    "via the OpenAI-compatible API" is dropped. The discipline of not
    spending the strong model on mechanical work survives unchanged)
  - III. Local-First Implementation → III. Weaker-Model Implementation
    (ADR-1: the implementer is a weaker model, reachable either as a CLI tool
    driving a cheaper model or as an API model — both first-class, user's
    choice. Local inference stays supported but stops being mandated)
  - V. Validate Before Checkpoint (ADR-2: correctness is owned by the smarter
    side — SPLITBRIEF's deterministic pipeline plus the planner's review;
    implementer self-verification is a bonus, not a requirement. Final review
    attributed to the planner, not to Opus specifically. The stop rule is
    qualified to the first failure *attributable to the task*, matching the
    owner-accepted glossary amendment and the baseline-relative pipeline in
    `src/engine/orchestrator/validation/run.ts`: a stage already red at the
    run's baseline continues instead of stopping, so the stages behind it
    still get a verdict)
  - VI. Identity & Anti-Goals (ADR-3: identity restated as two-tool
    orchestration. The anti-goal "tool call support for implementer models"
    expires — 2026 local coders are credible tool callers. The other two
    anti-goals stand. `writesFiles: direct` restated as first-class)
- Updated sections:
  - Principle II (task context is inlined for the implementer, which is not
    necessarily a local model — ADR-1)
  - Technical Constraints (implementer transport per ADR-1)
  - Development Workflow (ADR-4: git worktree per run is the default isolation
    for an implementer that writes files directly; promotion into the user's
    real project directory is non-negotiable; a worktree is not a security
    boundary)
- Removed sections: none
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ compatible (generic Constitution Check gate)
  - .specify/templates/spec-template.md ✅ compatible (no principle-specific sections)
  - .specify/templates/tasks-template.md ✅ compatible (story-based organization)
- Follow-up TODOs: none
-->

# SPLITBRIEF Constitution

## Core Principles

### I. Two-Tool Orchestration

SPLITBRIEF orchestrates two coding tools. The stronger one researches the
codebase, compiles Task Briefs, answers escalations, and reviews the
result; the weaker one executes one brief at a time. SPLITBRIEF holds
everything between them: the contract, validation, retry, escalation,
and evidence.

The stronger tool MUST NOT be spent on mechanical work. Research,
specification writing, planning, review, and escalation are its jobs;
typing out the edit is not. Every architectural decision MUST be
evaluated against strong-model token cost, and features that raise that
cost without proportional quality improvement MUST be rejected or
deferred.

Lower cost is a consequence of the split, not the promise. Savings MAY
be reported as measured fact; they MUST NOT be the headline claim, and
a saving alone MUST NOT justify a feature.

Where the user already pays for a coding tool subscription, that
subscription MUST be usable as the planner — planning MUST NOT require
a separate API key.

### II. Spec-Driven Development

No code is written without a specification. The workflow MUST follow:
research → spec → plan → tasks → implement → validate → review.

Each implementation task MUST be self-contained: all context needed
by the implementer (function signatures, types, current code, test
expectations, constraints) MUST be inlined in the task prompt. Tasks
MUST NOT reference external files or assume the model has access to
the broader codebase.

Task prompts for models under 15B parameters MUST target a single
function per task. Total prompt size MUST stay under 8K tokens for
7B models and under 16K tokens for 27B models.

### III. Weaker-Model Implementation

The implementer is a weaker **model**, not a weaker **transport**. Two
paths are first-class and MUST be held to the same maturity in prompt,
isolation, validation, and documentation:
- a runner that writes the files itself, such as a CLI tool driving a
  cheaper model (`cli`, `agent`, `agent-sdk` — `writesFiles: direct`)
- a runner that returns file contents as text, which SPLITBRIEF then
  writes, such as an API model (`api`, `shell` —
  `writesFiles: extracted-code`)

The user chooses. SPLITBRIEF MUST NOT favour one transport over the
other in defaults, prompts, isolation, or documentation.

Local inference (Ollama, LM Studio) MUST remain supported, and the
implementation phase MUST work without internet access when a local
model is used. Local inference is no longer the mandated default.

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

### V. Validate Before Checkpoint

Correctness is owned by the smarter side of the split: SPLITBRIEF's
deterministic pipeline and the planner's review. The implementer's
ability to run anything itself is a bonus that improves first-pass rate,
never a substitute for either. A task MUST NOT be accepted because the
implementer reports success.

Every task implementation MUST pass the validation pipeline before being
accepted as complete. The pipeline runs in the user's real project
directory, after the changes are promoted there, in order of speed and
cost:
1. TypeScript typecheck (`tsc --noEmit`)
2. Lint (ESLint or Biome, auto-detected)
3. Affected tests (matched by file naming convention)

Validation MUST stop on the first failure attributable to the task. A
stage already red at the run's baseline does not stop the pipeline and
does not block acceptance when its evidence names none of the task's
changed files. Failed tasks MUST NOT be accepted, checkpointed, or
committed. Retry prompts MUST include the exact error message, line
number, and relevant code context.

Product-level git commit strategies are optional run-safety and review
features. Agents working in this repository MUST NOT stage or commit;
the owner reviews and commits manually.

After all tasks complete, a final planner review MUST compare the
full diff against the original specification before the workflow
is marked complete.

### VI. Identity & Anti-Goals

SPLITBRIEF is an **orchestrator of two coding tools** (planner +
implementer). One plans and reviews, the other executes, and SPLITBRIEF
holds the contract, validation, retry, escalation, and evidence between
them. Running the two sides on models from different labs is part of the
value: a reviewer that did not write the code does not repeat its own
blind spots. Lower cost follows from the split — it is not the identity.

The collaboration between planner and implementer MUST be **visible,
understandable, and satisfying to use**. Beautiful visualization of the
orchestration is part of the product identity — not scope creep. The TUI
MUST expose the planner/implementer dialog, cost savings, validation
results, and escalation flow so users see and feel the value.

SPLITBRIEF is NOT:
- A universal AI connector that "connects any AI to any AI"
- A multi-agent coordinator (Claude Squad, Overstory, Agent Orchestrator)
- A generic orchestration framework with N dynamic agents

Features and proposals MUST be evaluated against this identity. Additions
that push SPLITBRIEF toward generic multi-agent orchestration MUST be
rejected unless they directly serve the two-tool split.

Explicit anti-goals that MUST NOT be implemented:
- Generic agent-wrapping-agent patterns with dynamic agent counts
- Features that blur the planner/implementer boundary

**Permitted exceptions**:
1. Delegating file writes to the implementer (`writesFiles: direct`) is a
   first-class path, not a concession, as long as SPLITBRIEF retains
   ownership of validation (tsc/lint/test), retry, escalation,
   checkpoints, and the overall workflow.
2. Rich visualization of the two-role orchestration (structured event
   cards, diff views, pipeline progress, cost tracking) is encouraged
   as product differentiation, not multi-agent coordination.

## Technical Constraints

- **Runtime**: Node.js 22+; development runs through `tsx`, production runs compiled `tsc` output from `dist/`
- **Language**: TypeScript 6.x, ESM only (`"type": "module"`)
- **TUI**: Ink 6.x (React 19 for CLI), conversation flow layout with structured event cards
- **Target**: macOS (primary), Linux (secondary)
- **Project languages**: TypeScript and JavaScript are the primary stack; command-based
  validation is also resolved for configured or detected Python, Go, and Rust pipelines
- **Planner**: Pluggable runner kinds via config: `cli`, `api`, `shell`, `agent`, and `agent-sdk`
- **Implementer**: The same five runner kinds as planner. Runners that write files themselves (`cli`, `agent`, `agent-sdk` — for example a CLI tool driving a cheaper model) and runners that return file contents as text for SPLITBRIEF to write (`api`, `shell` — for example an API model) are equally supported; the user picks, and the write mode follows from the kind
- **Edit format**: Whole-file replacement for files under 200 lines,
  search/replace blocks for larger files

## Development Workflow

- Features MUST be specified using SpecKit (`/speckit.specify` →
  `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`)
- Tasks MUST be organized by user story, not by technical layer,
  to enable incremental delivery and independent testing
- When product-level commits are enabled, each commit MUST correspond
  to one completed task or checkpoint
- An implementer that writes files directly works in a git worktree
  created once per run, with the project's dependencies made available
  inside it so validation can run there; changes are promoted back into
  the user's real project directory, guarded against clobbering edits
  made in the meantime. A worktree isolates files — not runtime, not
  security: it shares hooks and config with the repository.
  Same-directory parallel writes remain out of scope
- Tests are written alongside or after implementation (not TDD)
  unless explicitly requested for a specific feature

## Governance

This constitution supersedes all other development practices for
the SPLITBRIEF project. All implementation decisions, code reviews,
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

**Version**: 2.0.0 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-08-04
