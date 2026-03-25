---
name: tiny-spec-dev
description: Development context for the tiny-spec cost-optimized AI coding orchestrator. Use when working on tiny-spec source code, implementing features, fixing bugs, or understanding the architecture.
---

# tiny-spec Development Guide

## Purpose
CLI tool that orchestrates expensive AI (Claude Code/Opus) for planning and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs.

## Architecture

```
src/
  cli.ts                 CLI entry (commander): start, spec, init, status, resume
  app.tsx                Root Ink component — connects orchestrator to TUI
  types.ts               All shared types (Phase, Task, Config, WorkflowState, TokenBudget, CodeContext)
  config.ts              YAML config loading, defaults, validation
  state.ts               Pure function state machine (11 phases, 20 transitions)

  tui/                   Ink 5.x split-pane TUI
    layout.tsx           Two-column layout (planner left, implementer right)
    pane.tsx             Scrollable windowed rendering
    header.tsx           Feature name + elapsed timer
    status-bar.tsx       Phase/task/model/retries, color-coded
    prompt.tsx           Approval: Enter/e/$EDITOR/q

  orchestrator/          Core workflow
    orchestrator.ts      Main loop (~650 LOC): retry, escalation, SIGINT, cost tracking
    planner.ts           Spawns claude -p for 4-phase planning
    implementer.ts       OpenAI SDK streaming, code extraction, file write
    validator.ts         tsc → ESLint/Biome → affected tests pipeline
    escalator.ts         Two-tier: hints (~500 tok) → full Opus implementation
    extractor.ts         Parses LLM responses: fenced blocks, raw code, NL stripping
    context-extractor.ts Function-level code extraction for large files
    providers.ts         Provider abstraction: Ollama/LM Studio/DeepSeek/OpenRouter
    claude-stream.ts     Parser for Claude Code CLI stream-json format

  spec/                  Spec generation & formatting
    parser.ts            tasks.md → Task[] with YAML frontmatter + topological sort
    templates.ts         7 prompt templates for Claude Code
    formatter.ts         Task → prompt for local model (token budgeting, auto-degradation)

  utils/
    process.ts           Subprocess spawn, streaming, lifecycle, cleanup
    git.ts               simple-git wrapper: commit, diff, external changes, discard
    fs.ts                .tiny-spec/ directory management, path validation, lock file
```

## Key Types

```typescript
type Phase = 'idle' | 'researching' | 'specifying' | 'reviewing-spec' | 'planning' |
  'reviewing-plan' | 'implementing' | 'validating-task' | 'escalating' | 'final-review' | 'complete';

interface Task {
  id: string; title: string; action: 'create' | 'modify'; file: string;
  dependsOn: string[]; description: string; signature?: string;
  currentCode?: string; tests: string[]; constraints: string[];
  pattern?: string; status: TaskStatus;
  typeDefs: string;      // inlined type definitions for small models
  implSteps: string[];   // 3-5 implementation steps
}

interface Config {
  planner: { tool: 'claude-code' };
  implementer: { provider: string; model: string; apiBase: string; contextLength: number; temperature: number };
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

## Task Prompt Format (for local models)

Token budget per task (8K minimum context):
- System preamble + few-shot: ~500 tok
- Task body (desc, sig, tests, constraints): ~600 tok
- Type definitions: ~300 tok
- Implementation steps: ~150 tok
- Code context: auto-scaled (whole-file → function-level → truncate)
- Output reserve: 25% of contextLength

Auto-degradation cascade:
1. Whole-file (if fits)
2. Function-level (imports + target function + 5 lines context)
3. Truncate middle with marker
4. Error: task too large

## Testing

```bash
npm test                         # 132+ tests (tsx --test)
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode
```

Test files: `tests/*.test.ts` — parser, extractor, state, providers, formatter, context-extractor.

## Workflow

```
User: "add user auth"
  → Claude Code (Opus) researches, writes spec/plan/tasks
  → User approves (or --auto)
  → For each task: local model implements → validate (tsc/lint/test) → commit
  → Fail → retry (max 3) → escalate (hints → full Opus)
  → Opus final review of diff vs spec
```
