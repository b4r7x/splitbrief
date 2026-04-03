---
name: tiny-spec-dev
description: Development context for the tiny-spec cost-optimized AI coding orchestrator. Use when working on tiny-spec source code, implementing features, fixing bugs, or understanding the architecture.
---

# tiny-spec Development Guide

## Purpose
CLI tool that orchestrates expensive AI (Claude Code/Opus) for planning and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs. Two-role architecture with visible collaboration via conversation-flow TUI.

## Architecture

```
src/
  cli.ts                 CLI entry (commander): start, spec, init, status, resume
  app.tsx                Root Ink component — connects orchestrator events to TUI
  router.tsx             Screen router (home → workflow → summary) + overlays
  types.ts               Re-exports from core/types/
  state.ts               Pure function state machine (11 phases, 20 transitions)

  core/                  Shared domain logic
    config.ts            YAML config loading, defaults, validation
    config-validation.ts Config schema validation
    commands.ts          Slash command definitions and handlers
    shortcuts.ts         Keyboard shortcut definitions per screen
    state-persistence.ts State persistence to .tiny-spec/state.json
    theme.ts             Centralized color palette — zero hardcoded colors elsewhere
    types/               All shared types (split by domain)
      config.ts          Config, PlannerTool, OutputFormat, ThemeMode
      events.ts          TuiEvent union type
      summary.ts         RunSummary, CostBreakdown
      tokens.ts          TokenUsage, TaskTokenUsage
      ui.ts              UI-specific types
      workflow.ts        Phase, Task, TaskStatus, WorkflowState

  cli/                   CLI-specific logic (non-React)
    picker.ts            Interactive planner/implementer selection (readline)
    render.ts            Ink/fullscreen rendering setup
    workflow.ts          CLI command handlers

  engine/                Core workflow (zero React/Ink imports)
    orchestrator/        Main loop (decomposed into focused modules)
      index.ts           runWorkflow main loop + re-exports
      cost.ts            Cost breakdown calculations + buildSummary
      escalation.ts      Escalation logic (hints → full planner fix)
      events.ts          Event emission helpers
      helpers.ts         Shared utilities (context, validation helpers)
      tokens.ts          Token usage accounting
      task-runner.ts     Retry/escalation cascade + validateCommitAndAdvance
      task-loop.ts       Per-task iteration (implement, validate, retry)
      planning.ts        Planning phase + approval loops
      final-review.ts    Final review subprocess (Claude CLI)
    planners/            Pluggable planner backends (6 built-in + shell)
    implementer.ts       Implementer routing + OpenAI implementation core
    implementer-utils.ts Shared implementer utilities (extract, apply, diff)
    implementers/        Shell, agent, and OpenAI implementer backends
    validator.ts         tsc → ESLint/Biome → affected tests pipeline
    extractor.ts         Parses LLM responses: fenced blocks, raw code, NL stripping
    context-extractor.ts Function-level code extraction for large files
    providers.ts         Provider abstraction: Ollama/LM Studio/DeepSeek/OpenRouter
    pricing.ts           Cost calculation (known model pricing + $0 local fallback)
    detection.ts         Auto-detect available planners and implementers
    question-parser.ts   Parse <!-- Q:{JSON} --> markers from planner stream
    skills.ts            Skill discovery (frontmatter, .claude/skills scanning)
    spec/                Spec parsing, formatting & prompt generation
      parser.ts          tasks.md → Task[] with YAML frontmatter + topological sort
      templates.ts       Prompt templates for planner
      formatter.ts       Task → prompt for local model (token budgeting, auto-degradation)
      token-budget.ts    Token budget calculation and context fitting
      planning-prompts.ts    Planner prompt generation
      execution-prompts.ts   Implementer prompt generation
      review-prompts.ts      Review prompt generation

  screens/               Top-level screen components (home, workflow, summary)
  ui/                    17 Ink components (all colors from core/theme.ts)
  hooks/                 14 React hooks (colocated tests)
  utils/                 Helpers (no React/Ink deps): diff, format, fs, git, highlight, process, sessions, event-sections
```

All 72 test files are colocated next to their implementations (`foo.test.ts` beside `foo.ts`).

## Key Types

```typescript
type Phase = 'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'planning' |
  'reviewing-plan' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete';

// TUI event model — drives all UI rendering
type TuiEvent =
  | { type: 'planner-status'; phase: string; status: 'running' | 'done'; summary?: string; duration?: number }
  | { type: 'planner-text'; text: string }
  | { type: 'task-start'; taskId: string; title: string; index: number; total: number }
  | { type: 'task-complete'; taskId: string; method: 'local' | 'escalated'; duration: number }
  | { type: 'implementer-generate'; status: 'running' | 'done' | 'failed'; file?: string; diff?: string; linesAdded?: number; duration?: number }
  | { type: 'validate'; results: { tsc: boolean; lint: boolean; test: boolean }; error?: string; duration?: number }
  | { type: 'retry'; attempt: number; maxRetries: number }
  | { type: 'escalate'; tier: 1 | 2; hint?: string }
  | { type: 'git-commit'; message: string }
  | { type: 'error'; message: string }

interface Task {
  id: string; title: string; action: 'create' | 'modify'; file: string;
  dependsOn: string[]; description: string; signature?: string;
  currentCode?: string; tests: string[]; constraints: string[];
  pattern?: string; status: TaskStatus;
  typeDefs: string; implSteps: string[];
}

interface Config {
  planner: { tool: string; command?: string; args?: string[]; outputFormat?: string };
  implementer: { provider: string; model: string; apiBase: string; contextLength: number; temperature: number; type?: 'api' | 'shell' | 'agent' };
  validation: { typecheck: boolean; lint: boolean; test: boolean; testCommand: string };
  workflow: { autoApproveSpec: boolean; autoApprovePlan: boolean; maxRetries: number; commitPerTask: boolean };
}
```

## Coding Conventions

- **Zero classes** — pure functions, module-scoped state only
- **ESM imports** — always `.js` extension (`'./config.js'`, not `'./config'`)
- **No unnecessary comments** — code is self-explanatory
- **Error at boundaries** — internal functions propagate, callers decide
- **JSX for Ink** — `.tsx` for React components, `.ts` for everything else
- **Colocated tests** — `foo.test.ts` next to `foo.ts`

## Testing

```bash
npm test                         # 72 test files (vitest)
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode
```

## Workflow

```
User: "add user auth"
  → Planner (Opus) researches, writes spec/plan/tasks  [conversational cards]
  → User approves (or --auto)
  → For each task:
    → Implementer (local model) implements             [tool-call cards with diff]
    → Validate (tsc/lint/test)                         [result card]
    → Pass → commit, collapse task to 1 line
    → Fail → retry card → escalate card (planner hint)
  → Final Opus review
  → Summary with cost savings
```
