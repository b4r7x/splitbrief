# tiny-spec Development Guidelines

Open-source CLI tool that orchestrates expensive AI (Claude Code / Opus) for planning and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs.

## Quick Context

- `specs/002-cost-optimized-orchestrator/spec.md`  -  Full specification (4 user stories, 24 FRs)
- `specs/002-cost-optimized-orchestrator/plan.md`  -  Architecture, state machine, dependencies
- `specs/002-cost-optimized-orchestrator/tasks.md`  -  45 tasks across 7 phases (all complete)
- `specs/002-cost-optimized-orchestrator/research.md`  -  12 research sections from 9 parallel agents
- `specs/002-cost-optimized-orchestrator/data-model.md`  -  Entity definitions and state transitions
- `specs/002-cost-optimized-orchestrator/contracts/cli-commands.md`  -  CLI interface contract
- `specs/002-cost-optimized-orchestrator/quickstart.md`  -  End-to-end usage guide
- `.specify/memory/constitution.md`  -  6 project principles (v1.1.0)

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 5.9+, ESM only (`"type": "module"`)
- **Dev runner**: `tsx` (handles TypeScript + JSX/TSX + ESM, no custom loaders needed)
- **TUI**: Ink 5.x (React for CLI) + @inkjs/ui
- **Planner**: Pluggable — 6 built-in backends (claude-code, codex, opencode, aider, agent-sdk, shell) + any shell command via `planner.tool: shell`
- **Implementer**: `openai` SDK — any OpenAI-compatible endpoint (built-in: Ollama/LM Studio/DeepSeek/OpenRouter; custom: any provider with `apiBase`)
- **Config**: `yaml` package
- **Git**: `simple-git` package
- **CLI**: `commander` package
- **Build**: `tsc` → `dist/` (production)

## Code Conventions

- **Zero classes**  -  Pure functions, module-scoped state
- **ESM imports**  -  Always use `.js` extension in imports (`'./config.js'`, not `'./config'`)
- **No unnecessary comments**  -  Code should be self-explanatory
- **Error at boundaries**  -  Internal functions propagate, callers decide
- **JSX for Ink**  -  `.tsx` files for React components, `.ts` for everything else

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
│   ├── prompt.tsx            # User approval prompts ($EDITOR support)
│   ├── summary.tsx           # Final run summary with cost breakdown
│   ├── picker.tsx            # Interactive planner/implementer selection
│   ├── user-input.tsx        # TextInput wrapper for TUI input
│   └── question-prompt.tsx   # Clarification question display with options
├── orchestrator/             # Workflow logic
│   ├── orchestrator.ts       # Main workflow loop (~550 lines, retry, escalation, SIGINT)
│   ├── planners/             # Pluggable planner backends
│   │   ├── types.ts          # PlannerBackend interface (plan, escalateHint, escalateFull, isAvailable, getPricing)
│   │   ├── factory.ts        # createPlanner(config) — dynamic import by tool name
│   │   ├── claude-code.ts    # Claude Code CLI (stream-json output, session management)
│   │   ├── codex.ts          # OpenAI Codex CLI (jsonl output)
│   │   ├── opencode.ts       # OpenCode CLI
│   │   ├── aider.ts          # Aider CLI (text output, regex token parsing)
│   │   ├── agent-sdk.ts      # Anthropic Agent SDK (programmatic, no subprocess)
│   │   └── shell.ts          # Generic shell — any command via config (stream-json/jsonl/text parsers)
│   ├── implementer.ts        # Local model via OpenAI-compatible API + code application
│   ├── implementers/         # Alternative implementer backends
│   │   └── shell.ts          # Shell subprocess implementer (stdin/stdout)
│   ├── validator.ts          # tsc → lint → test pipeline (stops on first failure)
│   ├── escalator.ts          # Two-tier escalation (tier 1: hints, tier 2: full Opus)
│   ├── extractor.ts          # Code extraction from model responses (fences, explanation stripping)
│   ├── context-extractor.ts  # Function-level code extraction for large files
│   ├── question-parser.ts    # Parse <!-- Q:{JSON} --> markers from planner stream
│   ├── planner-detection.ts  # Auto-detect available planners and implementers
│   ├── pricing.ts            # Cost calculation (known model pricing tables + $0 local fallback)
│   └── providers.ts          # Provider abstraction (known defaults + generic apiBase/apiKey for custom)
├── spec/                     # Spec parsing & formatting
│   ├── parser.ts             # tasks.md → Task[] with topological sort
│   ├── templates.ts          # 7 prompt templates for Claude Code
│   └── formatter.ts          # Task → self-contained prompt for local model
└── utils/                    # Helpers
    ├── process.ts            # Subprocess spawn, streaming, lifecycle, cleanup
    ├── git.ts                # Git operations (commit, diff, status, discard changes)
    ├── fs.ts                 # .tiny-spec/ directory management, archiving
    └── format.ts             # Formatting helpers (tokens, cost, time)

tests/
├── parser.test.ts            # Task parser: YAML frontmatter, topo sort, edge cases
├── extractor.test.ts         # Code extraction: fences, raw code, NL stripping
├── state.test.ts             # State machine: all transitions, full workflow chain
├── providers.test.ts         # Provider config: known + custom providers
├── planners.test.ts          # Planner factory: all 6 backends + shell + unknown tool
├── pricing.test.ts           # Pricing: known models, planners, unknown fallback
├── formatter.test.ts         # Prompt formatting: create/modify, retry variants
├── config.test.ts            # Config loading and validation
├── orchestrator.test.ts      # Orchestrator workflow logic
├── format.test.ts            # Formatting helpers (tokens, cost, time)
├── summary.test.ts           # Summary component rendering
├── question-parser.test.ts   # Question marker parsing from planner stream
├── planner-detection.test.ts # Auto-detection of planners and implementers
├── shell-implementer.test.ts # Shell subprocess implementer
├── claude-stream.test.ts     # Claude Code stream-json parsing
├── implementer.test.ts       # Implementer API integration
├── validator.test.ts         # Validation pipeline
└── integration/              # Integration tests (require running services)
    ├── claude.integration.test.ts
    ├── ollama.integration.test.ts
    ├── resume.integration.test.ts
    ├── retry.integration.test.ts
    ├── tokens.integration.test.ts
    └── validation.integration.test.ts
```

## Commands

```bash
npm run dev -- --help            # Show CLI help
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode (no implementation)
npm run dev -- init              # Create config (auto-detect models)
npm run dev -- status            # Show workflow state
npm run dev -- resume            # Resume interrupted workflow
npm test                         # Run unit tests
npm run build                    # tsc → dist/
```

## Prerequisites

- **Planner** — one of: Claude Code (default), Codex, OpenCode, Aider, Agent SDK, or any shell command
- **Implementer** — Ollama (default), LM Studio, DeepSeek, OpenRouter, or any OpenAI-compatible endpoint
- **Node.js 22+**
- **Git** initialized in the target project

## How It Works

```
User: "add user auth"
  → Planner (any backend) researches codebase, writes spec/plan/tasks  [LEFT PANE]
  → Planner may ask clarifying questions (answered in TUI)
  → User approves spec and plan (approve, edit, comment, or quit)
  → For each task:
    → Implementer (any provider) implements the code                   [RIGHT PANE]
    → Validation: tsc → lint → tests
    → Pass → commit, next task
    → Fail → retry (max 3, varied approach)
    → Still fail → escalate to planner (hints first, then full impl)
  → Planner reviews full diff against original spec
  → Summary: tasks done, escalated, time, cost savings
```

## Task Prompt Optimization (v0.2)

### Token Budget (8K minimum context)

| Component | Typical tokens | Notes |
|-----------|---------------|-------|
| System preamble + few-shot | ~500 | Fixed: rules + 13-line example |
| Task body (desc, sig, tests, constraints) | ~600 | Variable per task |
| Type definitions (inlined) | ~300 | Opus generates per task |
| Implementation steps | ~150 | 3-5 steps from Opus |
| Code context | auto-scaled | Whole-file or function-level |
| Output reserve (25%) | 2048 (8K) | Reserved for model output |

### Auto-Degradation Cascade

When code context doesn't fit in the token budget:
1. **Whole-file** — include entire file (files ≤~300 LOC at 8K)
2. **Function-level** — imports + target function + 5 lines context
3. **Truncate** — middle-out truncation with visible marker
4. **Error** — task too large for configured context window

### Task Fields (v0.2)

- `typeDefs: string` — inlined TypeScript type definitions (all types referenced in signature/tests)
- `implSteps: string[]` — 3-5 implementation steps describing HOW to implement

### Retry Strategy (v0.2)

All retry attempts preserve full context (signature, types, tests, constraints, impl steps).
Varies by framing text and temperature only (+0.1 per attempt).

## Provider-Agnostic Configuration

Both planner and implementer are fully pluggable:

```yaml
# Custom shell planner (any command that reads stdin, writes stdout)
planner:
  tool: shell
  command: claude-zai           # or any CLI tool
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json     # stream-json | jsonl | text

# Custom implementer (any OpenAI-compatible endpoint)
implementer:
  provider: custom-ollama       # any string — known providers have defaults
  model: minimax-m2.7
  apiBase: http://my-server:11434/v1   # required for unknown providers
  apiKey: ""                    # optional, falls back to <PROVIDER>_API_KEY env var
```

Built-in planner tools: `claude-code`, `codex`, `opencode`, `aider`, `agent-sdk`, `shell`
Known implementer providers (with defaults): `ollama`, `lm-studio`, `deepseek`, `openrouter`

## Implementation Status

All 45 tasks from `specs/002-cost-optimized-orchestrator/tasks.md` are complete.
Unit tests + integration tests (integration tests require running services).

### Known Limitations

- `s` (skip task) and `Esc` (manual escalate) keyboard shortcuts not yet implemented
- Prompt size limits (8K/16K) not enforced in formatter
- TypeScript/JavaScript projects only (multi-language future)

See `specs/002-cost-optimized-orchestrator/research.md` for all architectural decisions and rationale.

## Active Technologies
- TypeScript 5.9+, Node.js 22+, ESM only
- Ink 5.x, React 18.x, @inkjs/ui
- openai ^6.0.0, yaml, simple-git, commander ^14.0.0
- JSON files (state.json, events.jsonl), Markdown files (spec.md, plan.md, tasks.md)
- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 5.x, @inkjs/ui, openai ^6.0.0, yaml, simple-git, commander ^14.0.0 (007-agent-mode-hardening)

## Recent Changes
- 007-agent-mode-hardening: Added TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 5.x, @inkjs/ui, openai ^6.0.0, yaml, simple-git, commander ^14.0.0
