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

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 6.x, ESM only (`"type": "module"`)
- **Dev runner**: `tsx` (handles TypeScript + JSX/TSX + ESM, no custom loaders needed)
- **Testing**: Vitest 4.x (72 test files, colocated with implementations)
- **TUI**: Ink 6.8 (React 19 for CLI) + @inkjs/ui 2.x + fullscreen-ink + ink-multiline-input
- **Syntax highlighting**: Shiki 4.x (WASM-based, async)
- **Terminal styling**: ansis (ANSI escape codes), cfonts (ASCII banners)
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
- **Colocated tests**  -  `foo.test.ts` lives next to `foo.ts` (no separate `tests/` directory)

## Project Structure

```
src/
├── cli.ts                    # CLI entry point (commander registration)
├── app.tsx                   # Root Ink component (zero props, composition, render helpers)
├── layout.tsx                # Structural shell (2 props: screen + overlay as ReactNode)
├── types.ts                  # Re-exports from core/types/
├── state.ts                  # Workflow state machine (11 phases, 20 transitions)
├── state-persistence.ts      # Re-exports from core/state-persistence
├── stores/                   # External stores (useSyncExternalStore, zero deps)
│   ├── create-store.ts       # Generic store factory (~40 lines)
│   ├── overlay.ts            # Overlay active/exclusive state
│   ├── router.ts             # Screen routing + transition validation
│   ├── error.ts              # Error message state
│   ├── config.ts             # Config + projectDir (loaded from disk)
│   ├── skills.ts             # Skill discovery + selection
│   ├── sessions.ts           # Session list (loaded from disk)
│   └── workflow.ts           # Workflow events/phase/tasks (biggest store)
├── core/                     # Shared domain logic (config, types, theme, commands)
│   ├── config.ts             # YAML config loading, defaults, validation
│   ├── config-validation.ts  # Config schema validation
│   ├── commands.ts           # Slash command definitions and handlers
│   ├── shortcuts.ts          # Keyboard shortcut definitions per screen
│   ├── state.ts              # State machine (re-export)
│   ├── state-persistence.ts  # State persistence to .tiny-spec/state.json
│   ├── theme.ts              # Centralized color palette — zero hardcoded colors elsewhere
│   └── types/                # All shared types (split by domain)
│       ├── index.ts          # Re-exports all type modules
│       ├── config.ts         # Config, PlannerTool, OutputFormat, ThemeMode
│       ├── events.ts         # TuiEvent union type
│       ├── summary.ts        # RunSummary, CostBreakdown
│       ├── tokens.ts         # TokenUsage, TaskTokenUsage
│       ├── ui.ts             # UI-specific types
│       └── workflow.ts       # Phase, Task, TaskStatus, WorkflowState
├── cli/                      # CLI-specific logic (non-React)
│   ├── picker.ts             # Interactive planner/implementer selection (readline)
│   ├── render.ts             # Ink/fullscreen rendering setup
│   └── workflow.ts           # CLI command handlers (start, spec, init, etc.)
├── engine/                   # Workflow logic (zero React/Ink imports)
│   ├── orchestrator/         # Main workflow loop (decomposed into focused modules)
│   │   ├── index.ts          # runWorkflow main loop + re-exports
│   │   ├── cost.ts           # Cost breakdown calculations + buildSummary
│   │   ├── escalation.ts     # Escalation logic (hints → full planner fix)
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
│   ├── implementers/         # Alternative implementer backends
│   │   ├── openai.ts         # Default OpenAI-compatible API implementer
│   │   ├── shell.ts          # Shell subprocess implementer (stdin/stdout)
│   │   └── agent.ts          # Agent subprocess implementer
│   ├── spec/                 # Spec parsing, formatting & prompt generation
│   │   ├── parser.ts         # tasks.md → Task[] with topological sort
│   │   ├── templates.ts      # Prompt templates for planner
│   │   ├── formatter.ts      # Task → self-contained prompt for local model
│   │   ├── token-budget.ts   # Token budget calculation and context fitting
│   │   ├── planning-prompts.ts    # Planner prompt generation (research, spec, plan, tasks)
│   │   ├── execution-prompts.ts   # Implementer prompt generation (implement, retry)
│   │   └── review-prompts.ts      # Review prompt generation (final review, escalation)
│   ├── apply.ts              # Code application (whole-file write + search/replace markers)
│   ├── openai-stream.ts      # OpenAI-compatible streaming client (timeout, error handling)
│   ├── output-parsers.ts     # Unified output format parsers (text, stream-json, jsonl)
│   ├── implementer.ts        # Implementer routing + OpenAI implementation core
│   ├── implementer-utils.ts  # Shared implementer utilities (extract, apply, diff)
│   ├── validator.ts          # tsc → lint → test pipeline (stops on first failure)
│   ├── extractor.ts          # Code extraction from model responses (fences, explanation stripping)
│   ├── context-extractor.ts  # Function-level code extraction for large files
│   ├── claude-stream.ts      # Claude Code stream-json parsing
│   ├── question-parser.ts    # Parse <!-- Q:{JSON} --> markers from planner stream
│   ├── detection.ts          # Auto-detect available planners and implementers
│   ├── pricing.ts            # Cost calculation (known model pricing tables + $0 local fallback)
│   ├── providers.ts          # Provider abstraction (known defaults + generic apiBase/apiKey)
│   └── skills.ts             # Skill discovery (frontmatter parsing, .claude/skills scanning)
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
│   ├── picker-utils.ts       # Shared picker helpers (scroll offset, truncation)
│   ├── review-view.tsx       # Spec/plan review display (markdown file viewer)
│   ├── sidebar.tsx           # Task list sidebar (progress, status)
│   ├── skills-picker.tsx     # Skill selection overlay
│   ├── slash-suggestions.tsx # Slash command autocomplete dropdown
│   └── spinner.tsx           # Braille spinner component
├── hooks/                    # React hooks (Ink-dependent lifecycle)
│   ├── use-ctrl-c.ts         # Double Ctrl+C exit handler (Ink useInput)
│   ├── use-filterable-list.ts # Filterable list state (search, scroll, selection)
│   ├── use-global-keys.ts    # Global keyboard shortcuts (reads stores, takes only { exit })
│   ├── use-input-mode.ts     # Input mode state (Promise-based, workflow-scoped)
│   ├── use-latest-ref.ts     # Ref that always holds the latest value
│   ├── use-sidebar.ts        # Sidebar visibility toggle (viewport-responsive)
│   ├── use-terminal-size.ts  # Terminal resize tracking + responsive layout
│   └── use-workflow.ts       # Orchestrator lifecycle (useEffect + store reads)
└── utils/                    # Helpers (no React/Ink dependencies)
    ├── diff.ts               # Line-level diff computation
    ├── event-sections.ts     # Group TuiEvents into collapsible sections
    ├── format.ts             # Formatting helpers (tokens, cost, time, version parsing)
    ├── fs.ts                 # .tiny-spec/ directory management, archiving
    ├── git.ts                # Git operations (commit, diff, status, discard changes)
    ├── highlight.ts          # Shiki-based syntax highlighting (async, WASM)
    ├── process.ts            # Subprocess spawn, streaming, lifecycle, cleanup
    └── sessions.ts           # Session directory management (project + global scope)
```

All `*.test.ts` files are colocated next to their implementations (80 test files total, not shown above).

## Commands

```bash
npm run dev -- --help            # Show CLI help
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode (no implementation)
npm run dev -- init              # Create config (auto-detect models)
npm run dev -- status            # Show workflow state
npm run dev -- resume            # Resume interrupted workflow
npm test                         # Run unit tests (vitest)
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
    → Implementer implements the code                    [tool-call cards]
    → Validation: tsc → lint → tests                    [result cards]
    → Pass → commit, collapse task to 1 line
    → Fail → retry (max 3) → escalate to planner       [escalation card]
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
110 source files, 80 colocated test files.

### TUI Architecture

Conversation flow layout with structured event cards. Key design:
- `TuiEvent` union type drives all UI rendering via `EventCard` switch
- Planner output: markdown with Shiki-highlighted code blocks. Implementer: structured tool-call cards.
- Collapsible syntax-highlighted diffs, collapsible completed tasks, pipeline progress bar, cost savings footer.
- All colors from `src/core/theme.ts` (zero hardcoded hex in `src/ui/`)
- Zero React/Ink imports in `src/engine/` (clean engine/UI separation)

### State Management (External Stores)

Uses DIY external stores built on React's `useSyncExternalStore` — zero dependencies, zero Context (except ThemeContext which is static). No `useMemo`, `useCallback`, or `React.memo` anywhere.

See `docs/STORES.md` for full architecture documentation.

**How it works:**
- `src/stores/create-store.ts` — ~45 line factory: `get()`, `set()`, `subscribe()`, `use(selector)`, `reset()`
- 7 domain stores: overlay, router, error, config, skills, sessions, workflow
- Components subscribe to specific slices via `store.use(selector)` — only re-render when that slice changes
- Stores are module-scoped singletons, accessible from both React components and engine code
- Tests use `beforeEach(() => store.reset())` for isolation
- `configStore.useConfig()` returns typed `Config` (non-null) with a guard — use this in components instead of `store.use(s => s.config)!`

**Store initialization (eager, before React):**
- Stores that need data from disk (config, sessions, skills) are loaded in `src/cli.ts` via `initStores()` before `render()` is called
- Router is initialized conditionally (`start` with feature) or always (`resume`)
- Components call `store.use(selector)` directly — no wrapper hooks needed
- This prevents infinite render loops that occur when `store.set()` is called during React render

**Data flow:**
```
CLI (initStores → store.load) → render(<App />)
  App (store.use subscriptions) → Layout (structural shell, 2 props)
    → renderScreen(switch) → Screen reads stores directly
    → renderOverlay(switch) → Overlay reads stores directly
  Engine code → workflowStore.addEvent() → subscribers re-render
```

**What stays as React hooks (can't be stores):**
- `useInputMode` — Promise-based resolver pattern (workflow-scoped lifecycle)
- `useWorkflow` — orchestrator lifecycle (useEffect + store reads + engine bridge)
- `useGlobalKeys` / `useCtrlC` — Ink's `useInput` required
- `useSidebar` — viewport-responsive state
- `useFilterableList` — keyboard-driven list state

**What NOT to do:**
- Don't add `useMemo`, `useCallback`, or `React.memo` — store selectors make them unnecessary
- Don't call `store.set()` or `store.load()` during React render — causes infinite loops
- Don't add `loaded: boolean` flags to store state — init belongs in the CLI entry point, not in hooks
- Don't create React Context for shared state — use stores instead
- Don't create thin wrapper hooks around `store.use()` — call stores directly in components
- Don't put `commands` in a store — it closes over Ink's `exit()` function
- Don't use `configStore.get()` in components — use `configStore.use(selector)` or `configStore.useConfig()` for reactive reads (`.get()` is for non-React code)

### Testing Policy

- **Zero failing tests** — all tests must pass before any PR. No pre-existing failures accepted.
- **Agent implementer tests** spawn real subprocesses. The `command not found` test uses a login shell fallback (`-lc`) which can be slow on machines with heavy shell configs — it has a 30s timeout for this reason.

### Known Limitations

- TypeScript/JavaScript projects only (multi-language future)

See `specs/002-cost-optimized-orchestrator/research.md` for all architectural decisions and rationale.
