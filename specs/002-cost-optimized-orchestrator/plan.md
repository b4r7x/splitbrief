# Implementation Plan: diptych v0.1

**Branch**: `002-cost-optimized-orchestrator` | **Date**: 2026-03-25 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-cost-optimized-orchestrator/spec.md`

## Summary

Build an open-source CLI tool (TypeScript + Ink) that orchestrates Claude Code CLI for planning/validation and a local model (via OpenAI-compatible API) for implementation. Split-pane TUI shows Claude Code output on the left and implementer activity on the right. Opus writes detailed specs with atomic tasks; the local model implements them one by one with automated validation, retry, and two-tier escalation. Uses the user's existing Claude Code subscription ($0 extra for planning).

## Technical Context

**Language/Version**: TypeScript 5.9+, Node.js 22+ (native TypeScript stripping via `--experimental-strip-types`)
**Primary Dependencies**: ink 5.x, react 18.x, openai SDK, yaml, simple-git, commander
**Storage**: JSON files (`.diptych/current/state.json`, `events.jsonl`), Markdown files (spec.md, plan.md, tasks.md)
**Testing**: `tsx --test tests/**/*.test.ts` (tsx handles TypeScript + JSX/TSX + ESM)
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool with TUI (terminal user interface)
**Performance Goals**: <2s TUI startup, <1s between task completion and next task start
**Constraints**: <200MB RSS for the orchestrator, task prompts <8K tokens for 7B models
**Scale/Scope**: Single user, single project, TypeScript/JavaScript projects only in v0.1

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Status**: Constitution ratified at v1.0.0 (2026-03-25). See `.specify/memory/constitution.md` for 5 core principles. All design decisions below comply.

**Implicit principles derived from CLAUDE.md and research**:
1. **Zero classes** -- pure functions, module-scoped state
2. **ESM imports** -- always use `.js` extension
3. **Error at boundaries** -- internal functions propagate, callers decide
4. **No unnecessary comments** -- code should be self-explanatory
5. **Local-first implementation** -- minimize cloud API usage for the implementation phase

All design decisions below comply with these implicit principles.

## Architecture

### Data Flow

```
User: "add user auth"
       │
       ▼
┌─────────────────────────────────────────────┐
│           diptych orchestrator             │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │ Planner      │    │ Implementer       │  │
│  │              │    │                   │  │
│  │ claude -p    │    │ openai SDK        │  │
│  │ (subprocess) │    │ → Ollama/LMStudio │  │
│  │              │    │                   │  │
│  │ Research ──┐ │    │ For each task:    │  │
│  │ Spec    ──┤ │    │  1. Build prompt  │  │
│  │ Plan    ──┤ │    │  2. Stream to API │  │
│  │ Tasks   ──┘ │    │  3. Parse output  │  │
│  └──────┬───────┘    │  4. Write file    │  │
│         │            │  5. Validate      │  │
│         │ files      │  6. Commit/Retry  │  │
│         ▼            └────────┬──────────┘  │
│  .diptych/current/         │              │
│  ├── spec.md                 │ escalate     │
│  ├── plan.md                 ▼              │
│  ├── tasks.md         ┌──────────────┐      │
│  ├── state.json       │ Escalator    │      │
│  └── events.jsonl     │ claude -p    │      │
│                       │ (hints/full) │      │
│                       └──────────────┘      │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ TUI (Ink 5.x)                        │   │
│  │ Left: Claude Code output             │   │
│  │ Right: Implementer streaming + diffs │   │
│  │ Bottom: Status bar                   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### Workflow State Machine

```
idle
  │ user runs "diptych start <feature>"
  ▼
researching ──────────────────────┐
  │ claude -p researches codebase │ LEFT PANE
  ▼                               │
specifying                        │
  │ claude -p writes spec.md      │
  ▼                               │
reviewing-spec                    │
  │ user approves (or --auto)     │
  ▼                               │
planning                          │
  │ claude -p writes plan + tasks │
  ▼                               │
reviewing-plan                    │
  │ user approves (or --auto)     │
  ▼                               ┘
implementing ─────────────────────┐
  │ for each task:                │ RIGHT PANE
  │   send prompt to local model  │
  │   parse & write output        │
  ▼                               │
validating-task                   │
  │ tsc → lint → tests            │
  │ pass → commit, next task      │
  │ fail → retry (max 3)          │
  ▼                               │
escalating (if retries exhausted) │
  │ tier 1: hints via claude -p   │ LEFT PANE
  │ tier 2: full via claude -p    │
  ▼                               ┘
final-review
  │ claude -p reviews diff vs spec
  ▼
complete
  │ display summary
  ▼
idle
```

**Any state → idle**: User cancels (q or Ctrl+C), state saved for resume.

### Process Management

**Claude Code subprocess**:
- Spawn via `child_process.spawn('claude', ['-p', prompt, '--output-format', 'stream-json'])`
- Parse `stream-json` events: `{type: 'assistant', content: [{type: 'text', text: '...'}]}` etc.
- Pipe parsed text to left TUI pane
- Session management via `--session-id` for multi-turn planning
- On completion: read generated files from `.diptych/current/`

**Local model API**:
- Use `openai` npm package with provider-specific `baseURL`
- Streaming via `client.chat.completions.create({ stream: true })`
- Parse streaming chunks and display in right TUI pane
- On completion: extract code from response, write to file

### Output Parsing (Code Extraction)

The local model's response must be parsed to extract clean code. Strategy:

1. Strip leading/trailing whitespace
2. If response starts with `` ```typescript `` or `` ``` ``: extract content between fences
3. If multiple code blocks: use the longest one
4. If no code blocks: treat entire response as code (minus any lines starting with natural language patterns like "Here is", "I'll", "This code")
5. Validate: the extracted content must parse as valid TypeScript (quick syntax check)
6. If extraction fails: retry with explicit format reminder

### Provider Abstraction

```typescript
// ~20 lines -- all providers speak OpenAI-compatible API
const PROVIDERS = {
  ollama: { baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' },
  'lm-studio': { baseURL: 'http://localhost:1234/v1', apiKey: 'lm-studio' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1', apiKey: env.DEEPSEEK_API_KEY },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY },
};
```

### Validation Pipeline

Per-task (fast, stops on first failure):
1. `tsc --noEmit` (~0.1-2s)
2. Lint: auto-detect ESLint or Biome (~0.5-1s)
3. Affected tests: match `src/X.ts` → `tests/X.test.ts` (~5-30s)

End-of-pipeline:
4. Full test suite (~30-120s)
5. Opus final review via `claude -p` (spec vs diff)

### Task Prompt Template

```markdown
You are a TypeScript code generator. You write clean, working TypeScript code.

Rules:
- Output ONLY the complete file contents
- Do NOT include markdown code fences
- Do NOT include explanations
- Use ESM imports with .js extensions
- Follow the exact function signatures provided

## Project: {project_name}
## Runtime: Node.js 22+, TypeScript 5.9+, ESM only

## Task: {task.title}
### Action: {create|modify}
### File: {task.file}

### Current Code (for modify only)
{current file contents}

### What To Do
{task.description}

### Function Signature
{exact signature with types}

### Tests (must pass after implementation)
{concrete input/output pairs}

### Constraints
{what NOT to do}
```

## Project Structure

### Documentation (this feature)

```text
specs/002-cost-optimized-orchestrator/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── cli-commands.md  # CLI command interface
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── cli.ts                    # CLI entry point (commander)
├── app.tsx                   # Root Ink component
├── types.ts                  # Shared types (Phase, WorkflowState, Task, Config, Summary)
├── config.ts                 # Config loading, model detection, defaults
├── state.ts                  # State machine, persistence, event logging
├── tui/
│   ├── layout.tsx            # Split-pane layout (left/right/header/status)
│   ├── pane.tsx              # Scrollable output pane (windowed rendering)
│   ├── status-bar.tsx        # Bottom status bar (phase, progress, model)
│   ├── header.tsx            # Top header (project, feature, time)
│   └── prompt.tsx            # Approval prompts (spec/plan review)
├── orchestrator/
│   ├── orchestrator.ts       # Main workflow loop
│   ├── planner.ts            # Claude Code CLI subprocess management
│   ├── implementer.ts        # Local model API integration
│   ├── validator.ts          # tsc/lint/test pipeline
│   ├── escalator.ts          # Two-tier escalation (hints → full)
│   └── extractor.ts          # Code extraction from model responses
├── spec/
│   ├── parser.ts             # tasks.md → Task[] parser
│   ├── templates.ts          # Prompt templates for Claude Code
│   └── formatter.ts          # Task → self-contained prompt for local model
└── utils/
    ├── process.ts            # Subprocess spawn, streaming, lifecycle
    ├── git.ts                # Git operations (commit, diff, status, external change detection)
    └── fs.ts                 # .diptych/ directory management

tests/
├── parser.test.ts
├── formatter.test.ts
├── state.test.ts
├── extractor.test.ts
├── validator.test.ts
└── providers.test.ts

ts-loader.mjs                # ESM loader for .js → .ts resolution (from Prain pattern)
```

**Structure Decision**: Single-project CLI structure. Domain-grouped modules (`tui/`, `orchestrator/`, `spec/`, `utils/`) following Prain's proven pattern. Key addition vs original spec: `extractor.ts` for code parsing from model responses (critical missing piece identified in research).

## Dependencies

### Runtime
- `ink` (^5.2.x) -- React-based terminal UI
- `@inkjs/ui` (^2.0.x) -- Ink UI components (spinner, select)
- `react` (^18.3.x) -- Required by Ink
- `openai` (^4.x) -- OpenAI-compatible SDK for local model (Ollama/LM Studio/DeepSeek)
- `yaml` (^2.x) -- YAML config parsing
- `simple-git` (^3.x) -- Git operations
- `commander` (^12.x) -- CLI argument parsing

### Dev
- `@types/node` (^22.x)
- `@types/react` (^18.x)
- `typescript` (^5.9.x)

**Note**: No `@anthropic-ai/sdk` needed -- Claude Code CLI handles all Opus interactions using the user's existing subscription.

## Complexity Tracking

No constitution violations to justify (constitution not yet ratified).
