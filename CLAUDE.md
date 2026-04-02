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
- `.specify/memory/constitution.md`  -  6 project principles (v1.3.1)
- `docs/VISION.md`  -  Strategic direction, competitive analysis, design decisions
- `docs/NEXT.md`  -  Current priorities and TUI redesign decisions

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 5.9+, ESM only (`"type": "module"`)
- **Dev runner**: `tsx` (handles TypeScript + JSX/TSX + ESM, no custom loaders needed)
- **TUI**: Ink 6.x (React 19 for CLI) + @inkjs/ui 2.x — conversation flow layout with structured event cards
- **Syntax highlighting**: Shiki 4.x (WASM-based, async)
- **Terminal styling**: ansis (ANSI escape codes)
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
├── commands.ts               # Slash command definitions and handlers
├── router.tsx                # Screen router (home → workflow → summary) + overlay rendering
├── shortcuts.ts              # Keyboard shortcut definitions per screen
├── types.ts                  # All shared types (Phase, Task, Config, WorkflowState, TuiEvent, etc.)
├── config.ts                 # Config loading (.tiny-spec/config.yaml), defaults, YAML↔TS conversion
├── state.ts                  # Workflow state machine (11 phases, 20 transitions, persistence)
├── theme.ts                  # Centralized color palette — zero hardcoded colors elsewhere
├── engine/                   # Workflow logic (zero React/Ink imports)
│   ├── orchestrator/         # Main workflow loop (decomposed into focused modules)
│   │   ├── index.ts          # runWorkflow main loop + re-exports
│   │   ├── cost.ts           # Cost breakdown calculations + buildSummary
│   │   ├── events.ts         # Event emission helpers (emit, emitValidationStart, etc.)
│   │   ├── helpers.ts        # Shared utilities (context, validation helpers)
│   │   ├── tokens.ts         # Token usage accounting (planner/implementer/escalation)
│   │   ├── task-runner.ts    # Retry/escalation cascade + validateCommitAndAdvance
│   │   ├── task-loop.ts      # Per-task iteration (implement, validate, retry)
│   │   ├── planning.ts       # Planning phase + approval loops
│   │   └── final-review.ts   # Final review subprocess (Claude CLI)
│   ├── planners/             # Pluggable planner backends
│   │   ├── base.ts           # Shared planner factory (createPlannerBase, buildProjectContext)
│   │   ├── context.ts        # Project context builder (package.json, README, config)
│   │   ├── spawn.ts          # Shared subprocess spawning for planner backends
│   │   ├── types.ts          # PlannerBackend interface
│   │   ├── factory.ts        # createPlanner(config) — dynamic import by tool name
│   │   ├── claude-code.ts    # Claude Code CLI (stream-json, session chaining)
│   │   ├── codex.ts          # OpenAI Codex CLI (jsonl output)
│   │   ├── opencode.ts       # OpenCode CLI
│   │   ├── aider.ts          # Aider CLI (text output, regex token parsing)
│   │   ├── agent-sdk.ts      # Anthropic Agent SDK (programmatic, no subprocess)
│   │   └── shell.ts          # Generic shell — any command via config
│   ├── apply.ts              # Code application (whole-file write + search/replace markers)
│   ├── openai-stream.ts      # OpenAI-compatible streaming client (timeout, error handling)
│   ├── output-parsers.ts     # Unified output format parsers (text, stream-json, jsonl)
│   ├── implementer.ts        # Implementer routing + OpenAI implementation core
│   ├── implementers/         # Alternative implementer backends
│   │   ├── shell.ts          # Shell subprocess implementer (stdin/stdout)
│   │   └── agent.ts          # Agent subprocess implementer
│   ├── validator.ts          # tsc → lint → test pipeline (stops on first failure)
│   ├── extractor.ts          # Code extraction from model responses (fences, explanation stripping)
│   ├── context-extractor.ts  # Function-level code extraction for large files
│   ├── highlight.ts          # Shiki-based syntax highlighting (async, WASM)
│   ├── claude-stream.ts      # Claude Code stream-json parsing
│   ├── question-parser.ts    # Parse <!-- Q:{JSON} --> markers from planner stream
│   ├── detection.ts          # Auto-detect available planners and implementers
│   ├── pricing.ts            # Cost calculation (known model pricing tables + $0 local fallback)
│   ├── providers.ts          # Provider abstraction (known defaults + generic apiBase/apiKey)
│   ├── skills.ts             # Skill discovery (frontmatter parsing, .claude/skills scanning)
│   └── spec/                 # Spec parsing & formatting
│       ├── parser.ts         # tasks.md → Task[] with topological sort
│       ├── templates.ts      # Prompt templates for planner
│       └── formatter.ts      # Task → self-contained prompt for local model
├── screens/                  # Top-level screen components
│   ├── home.tsx              # Home screen (banner, session list, input)
│   ├── workflow.tsx          # Workflow screen (header, events, footer, input)
│   └── summary.tsx           # Post-run summary screen
├── ui/                       # Ink UI components (all colors from theme.ts)
│   ├── command-palette.tsx   # Ctrl+K command palette overlay
│   ├── conversation-flow.tsx # Scrollable event card list with auto-follow + virtual scroll
│   ├── markdown.tsx          # Shared markdown rendering (parseBlocks, renderMarkdownLine, HighlightedCode)
│   ├── event-card.tsx        # Renders single TuiEvent as visual card (switch on type)
│   ├── pipeline-bar.tsx      # Phase progress: ● res ● spec ◉ impl ○ rev
│   ├── cost-footer.tsx       # Real-time cost savings: Task N/M │ Local: X% │ Saved: ~$X
│   ├── diff-view.tsx         # Collapsible syntax-highlighted diff
│   ├── task-summary.tsx      # Collapsed completed task: ✓ T1 title — local, 12s
│   ├── header.tsx            # Top header (feature name, pipeline bar, elapsed time)
│   ├── help-overlay.tsx      # Keyboard shortcut help overlay
│   ├── input-bar.tsx         # Multiline input with slash command suggestions
│   ├── picker.tsx            # Interactive planner/implementer selection
│   ├── picker-utils.ts       # Shared picker helpers (scroll offset, truncation)
│   ├── review-view.tsx       # Spec/plan review display (markdown file viewer)
│   ├── sidebar.tsx           # Task list sidebar (progress, status)
│   ├── skills-picker.tsx     # Skill selection overlay
│   ├── slash-suggestions.tsx # Slash command autocomplete dropdown
│   └── summary.tsx           # Final run summary with cost breakdown
├── hooks/                    # React hooks (shared across UI components)
│   ├── use-config.ts         # Config loading hook
│   ├── use-ctrl-c.ts         # Double Ctrl+C exit handler
│   ├── use-global-keys.ts    # Global keyboard shortcuts (help, palette, quit)
│   ├── use-input-mode.ts     # Input mode state (normal, review, question)
│   ├── use-overlay.ts        # Overlay open/close state (help, palette, skills)
│   ├── use-router.ts         # Screen navigation state machine
│   ├── use-sessions.ts       # Session persistence (list, create, load)
│   ├── use-sidebar.ts        # Sidebar visibility toggle
│   ├── use-skills.ts         # Skill discovery and selection state
│   ├── use-terminal-size.ts  # Terminal resize tracking + responsive layout
│   └── use-workflow.ts       # Orchestrator lifecycle (start, events, completion)
└── utils/                    # Helpers (no React/Ink dependencies)
    ├── diff.ts               # Line-level diff computation
    ├── format.ts             # Formatting helpers (tokens, cost, time)
    ├── fs.ts                 # .tiny-spec/ directory management, archiving
    ├── git.ts                # Git operations (commit, diff, status, discard changes)
    ├── process.ts            # Subprocess spawn, streaming, lifecycle, cleanup
    ├── sessions.ts           # Session directory management (project + global scope)
    └── version.ts            # Semantic version parsing and comparison

tests/
├── *.test.ts                 # Unit tests for engine, ui logic, utilities
├── helpers/
│   └── render.tsx            # Ink component test helper
└── integration/              # Integration tests (require running services)
    └── *.integration.test.ts
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
  → Planner researches codebase, writes spec/plan/tasks  [conversational cards]
  → Planner may ask clarifying questions (inline in flow)
  → User approves spec and plan (inline: approve, edit, comment, quit)
  → For each task:
    → Implementer implements the code                    [⚡ tool-call cards]
    → Validation: tsc → lint → tests                    [✓/✗ result cards]
    → Pass → commit, collapse task to 1 line
    → Fail → retry (max 3) → escalate to planner       [⚠ escalation card]
  → Planner reviews full diff against original spec
  → Summary: tasks done, escalated, time, cost savings
  → Footer shows real-time: Local: X% │ $X.XX │ Saved: ~$X.XX
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

### TUI Architecture (v0.4)

Conversation flow layout with structured event cards. Key design:
- `TuiEvent` union type drives all UI rendering via `EventCard` switch
- Planner output: markdown with Shiki-highlighted code blocks. Implementer: structured tool-call cards.
- Collapsible syntax-highlighted diffs, collapsible completed tasks, pipeline progress bar, cost savings footer.
- All colors from `src/theme.ts` (zero hardcoded hex in `src/ui/`)
- Zero React/Ink imports in `src/engine/` (clean engine/UI separation)

### Known Limitations

- `s` (skip task) and `Esc` (manual escalate) keyboard shortcuts not yet implemented
- Prompt size limits (8K/16K) not enforced in formatter
- TypeScript/JavaScript projects only (multi-language future)

See `specs/002-cost-optimized-orchestrator/research.md` for all architectural decisions and rationale.

## Active Technologies
- TypeScript 5.9+, Node.js 22+, ESM only (`"type": "module"`)
- Ink 6.x, React 19, @inkjs/ui 2.x
- Shiki 4.x (syntax highlighting), ansis (ANSI escape codes)
- openai ^6.0.0, yaml, simple-git, commander ^14.0.0
- JSON files (.tiny-spec/state.json, events.jsonl), Markdown files (spec.md, plan.md, tasks.md)
- TypeScript 5.9+, ESM only + Ink 6.8, React 19, @inkjs/ui 2.x, Shiki 4.x, ansis, cfonts (new), fullscreen-ink (new), ink-multiline-input (new) (014-chat-first-tui-redesign)
- JSON files (`.tiny-spec/sessions/`, `.tiny-spec/state.json`) (014-chat-first-tui-redesign)
- TypeScript 5.9+, ESM only + Ink 6.8, React 19, @inkjs/ui 2.x, ink-multiline-input, cfonts, ansis (015-tui-interactive-fix)
- JSON files (`.tiny-spec/state.json`, `sessions/`) (015-tui-interactive-fix)
- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 6.x (React 19), commander, openai, simple-git, yaml, Shiki 4.x, ansis (016-engine-srp-refactor)
- JSON files (`.tiny-spec/state.json`, `events.jsonl`), Markdown files (spec, plan, tasks) (016-engine-srp-refactor)
- TypeScript 5.9+, ESM only (`"type": "module"`) + openai ^6.0.0, yaml, simple-git, commander ^14.0.0, Ink 6.x (React 19) (017-engine-code-quality)
- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 6.x (React 19), openai ^6.0.0, simple-git, yaml, commander ^14.0.0, Shiki 4.x, ansis (018-audit-remediation)
- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 6.x (React 19), openai ^6.0.0, simple-git, commander ^14.0.0, yaml, Shiki 4.x, ansis (019-deep-quality-fixes)
- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 6.x (React 19), openai ^6.0, commander ^14.0, simple-git, yaml, Shiki 4.x, ansis (021-deep-quality-remediation)
- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 6.x (React 19), openai ^6.0, simple-git, commander ^14.0, yaml, Shiki 4.x, ansis (022-quality-audit-fixes)

## Recent Changes
- 012-core-cli-restructure: Restructured src/ into engine/, ui/, hooks/, utils/ with centralized theme.ts
- 007-agent-mode-hardening: Added agent-mode implementer, hardened conversational planning
