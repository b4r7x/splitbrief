# tiny-spec Development Guidelines

Open-source CLI tool that orchestrates expensive AI (Claude Code / Opus) for planning and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs.

## Quick Context

- `specs/002-cost-optimized-orchestrator/spec.md` — Full specification (4 user stories, 24 FRs)
- `specs/002-cost-optimized-orchestrator/plan.md` — Architecture, state machine, dependencies
- `specs/002-cost-optimized-orchestrator/tasks.md` — 45 tasks across 7 phases (all complete)
- `specs/002-cost-optimized-orchestrator/research.md` — 12 research sections from 9 parallel agents
- `specs/002-cost-optimized-orchestrator/data-model.md` — Entity definitions and state transitions
- `specs/002-cost-optimized-orchestrator/contracts/cli-commands.md` — CLI interface contract
- `specs/002-cost-optimized-orchestrator/quickstart.md` — End-to-end usage guide
- `.specify/memory/constitution.md` — 5 project principles (v1.0.0)

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 5.9+, ESM only (`"type": "module"`)
- **Dev runner**: `tsx` (handles TypeScript + JSX/TSX + ESM, no custom loaders needed)
- **TUI**: Ink 5.x (React for CLI) + @inkjs/ui
- **Planner**: Claude Code CLI (`claude -p --output-format stream-json`) as subprocess — uses existing subscription, $0 extra
- **Implementer**: `openai` SDK (OpenAI-compatible API for Ollama/LM Studio/DeepSeek/OpenRouter)
- **Config**: `yaml` package
- **Git**: `simple-git` package
- **CLI**: `commander` package
- **Build**: `tsc` → `dist/` (production)

## Code Conventions

- **Zero classes** — Pure functions, module-scoped state
- **ESM imports** — Always use `.js` extension in imports (`'./config.js'`, not `'./config'`)
- **No unnecessary comments** — Code should be self-explanatory
- **Error at boundaries** — Internal functions propagate, callers decide
- **JSX for Ink** — `.tsx` files for React components, `.ts` for everything else

## Project Structure

```
src/
├── cli.ts                    # CLI entry point (5 commands: start, spec, init, status, resume)
├── app.tsx                   # Root Ink component
├── types.ts                  # All shared types (Phase, Task, Config, WorkflowState, etc.)
├── config.ts                 # Config loading (.tiny-spec/config.yaml), defaults, YAML↔TS conversion
├── state.ts                  # Workflow state machine (11 phases, 20 transitions, persistence)
├── tui/                      # Ink UI components
│   ├── layout.tsx            # Split-pane layout (left: planner, right: implementer)
│   ├── pane.tsx              # Scrollable output pane (windowed rendering)
│   ├── status-bar.tsx        # Bottom status bar (phase, progress, model, retries)
│   ├── header.tsx            # Top header (feature name, elapsed time)
│   └── prompt.tsx            # User approval prompts ($EDITOR support)
├── orchestrator/             # Workflow logic
│   ├── orchestrator.ts       # Main workflow loop (~550 lines, retry, escalation, SIGINT)
│   ├── planner.ts            # Claude Code CLI subprocess management (4-phase planning)
│   ├── implementer.ts        # Local model via OpenAI-compatible API + code application
│   ├── validator.ts          # tsc → lint → test pipeline (stops on first failure)
│   ├── escalator.ts          # Two-tier escalation (tier 1: hints, tier 2: full Opus)
│   ├── extractor.ts          # Code extraction from model responses (fences, explanation stripping)
│   └── providers.ts          # Provider abstraction (Ollama/LM Studio/DeepSeek/OpenRouter)
├── spec/                     # Spec parsing & formatting
│   ├── parser.ts             # tasks.md → Task[] with topological sort
│   ├── templates.ts          # 7 prompt templates for Claude Code
│   └── formatter.ts          # Task → self-contained prompt for local model
└── utils/                    # Helpers
    ├── process.ts            # Subprocess spawn, streaming, lifecycle, cleanup
    ├── git.ts                # Git operations (commit, diff, status, discard changes)
    └── fs.ts                 # .tiny-spec/ directory management, archiving

tests/
├── parser.test.ts            # Task parser: YAML frontmatter, topo sort, edge cases (7 tests)
├── extractor.test.ts         # Code extraction: fences, raw code, NL stripping (19 tests)
├── state.test.ts             # State machine: all transitions, full workflow chain (18 tests)
├── providers.test.ts         # Provider config: baseURL per provider (5 tests)
└── formatter.test.ts         # Prompt formatting: create/modify, retry variants (10 tests)
```

## Commands

```bash
npm run dev -- --help            # Show CLI help
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode (no implementation)
npm run dev -- init              # Create config (auto-detect models)
npm run dev -- status            # Show workflow state
npm run dev -- resume            # Resume interrupted workflow
npm test                         # Run tests (59 tests)
npm run build                    # tsc → dist/
```

## Prerequisites

- **Claude Code** installed and authenticated (Max 5x or higher plan)
- **Ollama** running with a coding model (e.g., `ollama pull qwen2.5-coder:7b`)
- **Node.js 22+**
- **Git** initialized in the target project

## How It Works

```
User: "add user auth"
  → Claude Code (Opus) researches codebase, writes spec/plan/tasks    [LEFT PANE]
  → User approves spec and plan (or --auto)
  → For each task:
    → Local model (Qwen 7B via Ollama) implements the code            [RIGHT PANE]
    → Validation: tsc → lint → tests
    → Pass → commit, next task
    → Fail → retry (max 3, varied approach)
    → Still fail → escalate to Opus (hints first, then full impl)
  → Opus reviews full diff against original spec
  → Summary: tasks done, escalated, time, cost savings
```

## Implementation Status

All 45 tasks from `specs/002-cost-optimized-orchestrator/tasks.md` are complete.
59 tests passing, 0 TypeScript errors.

### Known Limitations (v0.1)

- Token usage counters not yet wired (summary shows $0.00 savings)
- `s` (skip task) and `Esc` (manual escalate) keyboard shortcuts not yet implemented
- Prompt size limits (8K/16K) not enforced in formatter
- `detectCapabilities()` defined but not called at startup
- TypeScript/JavaScript projects only (multi-language in v0.2)

See `specs/002-cost-optimized-orchestrator/research.md` for all architectural decisions and rationale.
