# Implementation Plan: tiny-spec v0.1

**Branch**: `001-tiny-spec-core` | **Date**: 2026-03-24 | **Spec**: [spec.md](spec.md)

## Summary

Build an open-source CLI tool (TypeScript + Ink) that orchestrates two AI coding sessions — Claude Code (Opus) for planning/validation and OpenCode (local model) for implementation. Split-pane TUI shows both sessions. Opus writes detailed specs with atomic tasks; the local model implements them one by one with automated validation and escalation.

## Technical Context

- **Runtime**: Node.js 22+ with native TypeScript stripping (`--experimental-strip-types`)
- **Language**: TypeScript 5.9+, ESM only (`"type": "module"`)
- **TUI**: Ink 5.x (React for CLI) + @inkjs/ui
- **Process Management**: Node.js `child_process.spawn` for Claude Code and OpenCode subprocesses
- **Terminal Splitting**: Ink's `<Box>` layout with flexDirection="row" (not actual tmux)
- **Config**: YAML via `yaml` npm package
- **Git**: `simple-git` npm package for commit operations
- **Testing**: Node.js built-in test runner (`node --test`)
- **Target Platform**: macOS primary, Linux secondary

## Architecture

### Core Modules

```
src/
├── cli.ts                    # CLI entry point (commander or custom arg parsing)
├── app.tsx                   # Root Ink component
├── types.ts                  # All shared types
├── config.ts                 # Load/validate .tiny-spec/config.yaml
├── state.ts                  # Workflow state machine
├── tui/
│   ├── layout.tsx            # Split-pane layout (left/right/status bar)
│   ├── pane.tsx              # Single pane component (scrollable output)
│   ├── status-bar.tsx        # Bottom status bar (phase, progress, model)
│   ├── header.tsx            # Top header bar (project, feature, time)
│   └── prompt.tsx            # User input/approval prompts
├── orchestrator/
│   ├── orchestrator.ts       # Main workflow orchestrator
│   ├── planner.ts            # Drives Claude Code for spec/plan/tasks
│   ├── implementer.ts        # Drives OpenCode for task implementation
│   ├── validator.ts          # Runs validation pipeline (tsc, lint, test)
│   └── escalator.ts          # Handles escalation to Opus
├── spec/
│   ├── parser.ts             # Parse tasks.md into structured task objects
│   ├── templates.ts          # Spec/plan/task prompt templates
│   └── formatter.ts          # Format task into self-contained prompt for local model
└── utils/
    ├── process.ts            # Spawn and manage subprocesses (Claude Code, OpenCode)
    ├── git.ts                # Git operations (commit, diff, status)
    └── fs.ts                 # File system helpers (.tiny-spec/ management)
```

### Data Flow

```
User Input ("add user auth")
       │
       ▼
  ┌─────────┐     spawn claude code
  │ CLI/TUI  │─────────────────────────┐
  │ (Ink)    │                         ▼
  │          │              ┌──────────────────┐
  │ Left     │◄─────────────│ Claude Code      │
  │ Pane     │  stdout      │ (Opus)           │
  │          │              │                  │
  │          │              │ 1. Research      │
  │          │              │ 2. Write spec.md │
  │          │              │ 3. Write plan.md │
  │          │              │ 4. Write tasks.md│
  │          │              └──────────────────┘
  │          │
  │          │  parse tasks.md
  │          │─────────────────────────┐
  │          │                         ▼
  │          │              ┌──────────────────┐
  │ Right    │◄─────────────│ OpenCode         │
  │ Pane     │  stdout      │ (Local Model)    │
  │          │              │                  │
  │          │              │ For each task:   │
  │          │              │ 1. Receive prompt│
  │          │              │ 2. Implement     │
  │          │              │ 3. Validate      │
  │          │              │ 4. Commit/Retry  │
  │          │              └──────────────────┘
  │          │
  │ Status   │  task progress, errors, escalations
  │ Bar      │
  └─────────┘
```

### Process Management Strategy

Both Claude Code and OpenCode are managed as child processes:

**Claude Code**: Run in headless/non-interactive mode via `claude --print` or pipe mode. We send it a structured prompt asking it to generate spec/plan/tasks files. We read the output and the generated files.

**OpenCode**: Run via `opencode run "prompt"` headless mode. For each task, we construct a self-contained prompt and pipe it. We read the output and check the file changes.

**Alternative (simpler MVP)**: Instead of spawning actual Claude Code / OpenCode processes, the orchestrator can:
1. Use Claude API directly (via `@anthropic-ai/sdk`) for the planning phase
2. Use OpenAI-compatible API directly (via `openai` SDK pointing to Ollama) for implementation
3. Show the activity in Ink panes as if they were separate sessions

This avoids the complexity of managing CLI subprocesses while achieving the same result. The TUI still shows two panes — one for "Planner" activity and one for "Implementer" activity.

**Decision**: Start with the API-direct approach (simpler, more reliable). Add CLI subprocess orchestration in v0.2 for users who prefer the real Claude Code / OpenCode experience.

### State Machine

```typescript
type WorkflowState =
  | { phase: 'idle' }
  | { phase: 'researching'; feature: string }
  | { phase: 'specifying'; feature: string }
  | { phase: 'reviewing-spec'; spec: Spec }
  | { phase: 'planning'; spec: Spec }
  | { phase: 'reviewing-plan'; plan: Plan; tasks: Task[] }
  | { phase: 'implementing'; currentTask: Task; attempt: number; tasks: Task[] }
  | { phase: 'validating-task'; task: Task; output: string }
  | { phase: 'escalating'; task: Task; error: string }
  | { phase: 'final-review'; completedTasks: Task[]; escalatedTasks: Task[] }
  | { phase: 'complete'; summary: Summary };
```

### Task Prompt Format (sent to local model)

Each task is formatted as a self-contained prompt:

```markdown
You are implementing a specific task in a TypeScript project.
Follow the instructions exactly. Do not add anything extra.

## Project Context
- Project: {project_name}
- Runtime: Node.js 22+, TypeScript 5.9+, ESM only
- Test command: {test_command}

## Task: {task.title}

### Action: {create|modify|delete}
### File: {task.file}

### Current Code
{only for modify: the exact current content of the relevant section}

### What To Do
{task.description}

### Function Signature
{exact signature with types}

### Tests (must pass after implementation)
{concrete test cases with expected values}

### Constraints
{what NOT to do}

### Pattern to Follow
{optional: similar code from the codebase}

Respond with the complete file content for {task.file}.
Do not include explanations. Only output the code.
```

## Dependencies

### Runtime
- `ink` (^5.2.x) — React-based terminal UI
- `@inkjs/ui` (^2.0.x) — Ink UI components (spinner, select, etc.)
- `react` (^18.3.x) — Required by Ink
- `@anthropic-ai/sdk` (^0.40.x) — Claude API for planning phase
- `openai` (^4.x) — OpenAI-compatible SDK for local model (Ollama/LM Studio)
- `yaml` (^2.x) — YAML config parsing
- `simple-git` (^3.x) — Git operations
- `commander` (^12.x) — CLI argument parsing

### Dev
- `@types/node` (^22.x)
- `@types/react` (^19.x)
- `typescript` (^5.9.x)

## Constraints

- Zero classes — pure functions, module-scoped state
- ESM imports with `.js` extension
- No unnecessary comments
- Dev mode: `node --experimental-strip-types`
- Minimal error handling: propagate internally, handle at boundaries
