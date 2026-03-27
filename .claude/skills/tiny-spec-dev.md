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
  types.ts               All shared types (Phase, Task, Config, WorkflowState, TuiEvent)
  config.ts              YAML config loading, defaults, validation
  state.ts               Pure function state machine (11 phases, 20 transitions)

  tui/                   Ink 5.x conversation-flow TUI
    layout.tsx           Conversation flow: sticky header + scrollable events + sticky footer
    event-card.tsx       Renders a single TuiEvent as a structured card
    pipeline-bar.tsx     Phase progress: ● res → ● spec → ◉ impl → ○ rev
    diff-view.tsx        Collapsible diff display (summary default, expand on demand)
    header.tsx           Feature name + pipeline bar + elapsed timer
    status-bar.tsx       Cost savings, token count, model, task progress
    prompt.tsx           Approval: Enter/e/$EDITOR/q (inline in flow)
    picker.tsx           Interactive planner/implementer selection
    question-prompt.tsx  Clarification questions with options
    summary.tsx          Final run summary with cost breakdown

  orchestrator/          Core workflow
    orchestrator.ts      Main loop (~700 LOC): emits TuiEvents, retry, escalation, SIGINT
    planners/            Pluggable planner backends (6 built-in + shell)
    implementer.ts       OpenAI SDK streaming → structured events
    implementers/shell.ts  Shell subprocess implementer
    validator.ts         tsc → ESLint/Biome → affected tests pipeline
    escalator.ts         Two-tier: hints (~500 tok) → full Opus implementation
    extractor.ts         Parses LLM responses: fenced blocks, raw code, NL stripping
    context-extractor.ts Function-level code extraction for large files
    providers.ts         Provider abstraction: Ollama/LM Studio/DeepSeek/OpenRouter
    pricing.ts           Cost calculation (known model pricing + $0 local fallback)

  spec/                  Spec generation & formatting
    parser.ts            tasks.md → Task[] with YAML frontmatter + topological sort
    templates.ts         7 prompt templates for Claude Code
    formatter.ts         Task → prompt for local model (token budgeting, auto-degradation)

  utils/
    process.ts           Subprocess spawn, streaming, lifecycle, cleanup
    git.ts               simple-git wrapper: commit, diff, external changes, discard
    fs.ts                .tiny-spec/ directory management, path validation, lock file
    format.ts            Formatting helpers (tokens, cost, time)
```

## Key Types

```typescript
type Phase = 'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'planning' |
  'reviewing-plan' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete';

// TUI event model — replaces raw text lines
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

## Testing

```bash
npm test                         # 227+ tests (tsx --test)
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode
```

Test files: `tests/*.test.ts` — parser, extractor, state, providers, formatter, orchestrator, etc.

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
