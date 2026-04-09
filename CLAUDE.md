# tiny-spec Development Guidelines

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass, not even when a workflow step suggests it. The user reviews and commits all changes manually in their editor. Leave every change as an unstaged modification in the working tree. This rule overrides any other instruction or workflow that suggests committing.

**Enforcement:** A `PreToolUse` hook at `.claude/hooks/block-git-commits.sh` (configured in `.claude/settings.json`) intercepts every Bash invocation and blocks `git add`, `git stage`, and `git commit` (and all flag-prefixed / chained variants) with exit code 2. The hook also catches `git -c key=val commit` and piped/semicolon-chained forms. If you see a `BLOCKED:` message in stderr, that is this guardrail doing its job — stop and report to the user.

---

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
- **Testing**: Vitest 4.x (57 colocated test files / 700 tests)
- **Linter/formatter**: Biome 2.x (`npm run lint`, `npm run format`)
- **TUI**: Ink 6.8 (React 19 for CLI) + fullscreen-ink (custom multiline-input primitive under `src/ui/input/`)
- **Syntax highlighting**: Shiki 4.x (WASM-based, async)
- **Terminal styling**: ansis (ANSI escape codes), cfonts (ASCII banners)
- **Planner**: Pluggable — subprocess backends (`claude-code`, `agent-sdk`, generic `cli`, `shell`) + API planner via any OpenAI-compatible endpoint
- **Implementer**: `openai` SDK — any OpenAI-compatible endpoint (built-in: Ollama/LM Studio/DeepSeek/OpenRouter; custom: any provider with `apiBase`)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` (declared as optional peer dependency)
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
- **Zero memoization**  -  No `useMemo`, `useCallback`, or `React.memo` anywhere in `src/`. Store selectors make them unnecessary.
- **No imperative handles**  -  No `forwardRef` / `useImperativeHandle`. React 19 + stores eliminate the need.

## Project Structure

`*.test.ts` / `*.test.tsx` files are colocated next to their implementations; omitted from the tree below.

```
src/
├── cli.ts                    # CLI entry point (commander registration)
├── app.tsx                   # Root Ink component (zero props, composition, render helpers)
├── layout.tsx                # Structural shell (2 props: screen + overlay as ReactNode)
├── types.ts                  # Re-exports from core/types/
├── stores/                   # External stores (useSyncExternalStore, zero deps)
│   ├── create-store.ts       # Generic store factory
│   ├── overlay.ts            # Overlay active/exclusive state
│   ├── router.ts             # Screen routing + transition validation
│   ├── feedback.ts           # Feedback/error message state
│   ├── detection.ts          # Provider detection state
│   ├── config.ts             # Config + projectDir (loaded from disk)
│   ├── conversation-scroll.ts # Scroll position (replaces forwardRef/useImperativeHandle)
│   ├── skills.ts             # Skill discovery + selection
│   ├── sessions.ts           # Session list (loaded from disk)
│   └── workflow.ts           # Workflow events/phase/tasks (biggest store)
├── core/                     # Shared domain logic (config, types, commands, state)
│   ├── phases.ts             # Phase role mapping + cancellable/implementer phase sets
│   ├── commands/             # Slash command definitions and handlers
│   │   ├── index.ts          # Public re-exports
│   │   ├── definitions.ts    # Command registry
│   │   ├── shortcuts.ts      # Keyboard shortcut bindings
│   │   └── review-commands.ts # Review-mode slash commands
│   ├── config/               # YAML config loading, defaults, validation
│   │   ├── index.ts          # Public re-exports
│   │   ├── access.ts         # Config read accessors
│   │   ├── loading.ts        # YAML load/write + defaults
│   │   ├── transforms.ts     # Config normalisation
│   │   └── validation.ts     # Schema validation
│   ├── providers/            # Shared model/provider catalog helpers
│   │   ├── catalog.ts        # Known model-vendor providers with API defaults
│   │   ├── models.ts         # Model metadata helpers
│   │   └── pricing.ts        # Cost calculation (known model pricing + $0 local fallback)
│   ├── sessions/             # Session domain helpers
│   │   └── status.ts         # Status icon + colour mapping (Session['status'] → Theme)
│   ├── settings/             # Setting definitions and catalog
│   │   └── catalog.ts
│   ├── state/                # Workflow state machine
│   │   ├── machine.ts        # Phases + transitions
│   │   └── persistence.ts    # State persistence to .tiny-spec/state.json
│   └── types/                # All shared types (split by domain)
│       ├── index.ts          # Re-exports all type modules
│       ├── config.ts         # Config, PlannerTool, OutputFormat, ThemeMode
│       ├── events.ts         # TuiEvent union type
│       ├── summary.ts        # RunSummary, CostBreakdown
│       ├── ui.ts             # UI-specific types
│       └── workflow.ts       # Phase, Task, TaskStatus, WorkflowState
├── cli/                      # CLI-specific logic (non-React)
│   ├── commands/             # commander subcommand handlers
│   │   ├── init.ts           # `tiny-spec init`
│   │   ├── resume.ts         # `tiny-spec resume`
│   │   ├── spec.ts           # `tiny-spec spec`
│   │   ├── start.ts          # `tiny-spec start`
│   │   └── status.ts         # `tiny-spec status`
│   ├── init-stores.ts        # Eager store bootstrap before React renders
│   ├── render.ts             # Ink/fullscreen rendering setup
│   └── workflow.ts           # Shared CLI workflow helpers
├── engine/                   # Workflow logic (zero React/Ink imports)
│   ├── agent-sdk.ts          # Shared Anthropic Agent SDK loader (optional peer dep)
│   ├── cli-tools.ts          # Shared CLI-tool detection / spawn helpers
│   ├── orchestrator/         # Main workflow loop (decomposed into focused modules)
│   │   ├── index.ts          # runWorkflow main loop + re-exports
│   │   ├── run.ts            # Top-level run entry point
│   │   ├── cost.ts           # Cost breakdown calculations + buildSummary
│   │   ├── escalation.ts     # Escalation logic (hints → full planner fix)
│   │   ├── events.ts         # Event emission helpers
│   │   ├── helpers.ts        # Shared utilities (context, validation helpers)
│   │   ├── tokens.ts         # Token usage accounting (planner/implementer/escalation)
│   │   ├── task-runner.ts    # Retry/escalation cascade + validateCommitAndAdvance
│   │   ├── task-loop.ts      # Per-task iteration with WorkflowContext
│   │   ├── task-step.ts      # Single task step execution
│   │   ├── planning.ts       # Mode-aware planning (quick/standard/full)
│   │   └── validator.ts      # tsc → lint → test pipeline (stops on first failure)
│   ├── planners/             # Pluggable planner backends (subprocess + API)
│   │   ├── index.ts          # Public re-exports
│   │   ├── types.ts          # PlannerBackend interface
│   │   ├── factory.ts        # createPlanner(config) — API planner if provider set, else tool switch
│   │   ├── base.ts           # Shared planner factory (createPlannerBase, quickPlan)
│   │   ├── api.ts            # API-based planner (any OpenAI-compatible endpoint)
│   │   ├── claude-code.ts    # Claude Code CLI (stream-json, session chaining)
│   │   ├── agent-sdk.ts      # Anthropic Agent SDK (programmatic, no subprocess)
│   │   ├── cli.ts            # Generic CLI planner backend
│   │   ├── shell.ts          # Generic shell — any command via config
│   │   └── context.ts        # Project context builder
│   ├── implementers/         # Pluggable implementer backends (mirrors planner pattern)
│   │   ├── index.ts          # Public re-exports
│   │   ├── types.ts          # ImplementerBackend interface
│   │   ├── base.ts           # createImplementerBase() factory — shared pipeline
│   │   ├── factory.ts        # createImplementer(config) — routing (api/shell/agent)
│   │   ├── openai.ts         # OpenAI-compatible API implementer
│   │   ├── shell.ts          # Shell subprocess implementer
│   │   ├── agent.ts          # Agent subprocess implementer
│   │   ├── agent-sdk.ts      # Anthropic Agent SDK implementer
│   │   ├── tool.ts           # Tool-based implementer helper
│   │   └── apply.ts          # Code application (whole-file write + search/replace markers)
│   ├── providers/            # Provider registry (used by both planners and implementers)
│   │   ├── index.ts          # Re-exports
│   │   ├── types.ts          # ProviderDef interface, ModelsResponse, ProviderOverrides
│   │   ├── registry.ts       # KNOWN_PROVIDERS, getProvider(), detectAvailableProviders()
│   │   ├── client.ts         # Shared HTTP client
│   │   ├── openai-compat.ts  # Shared factory for remote OpenAI-compatible providers
│   │   ├── ollama.ts         # Ollama (local, /api/tags, /api/show)
│   │   └── lm-studio.ts      # LM Studio (local, /v1/models)
│   ├── spec/                 # Spec parsing, formatting & prompt generation
│   │   ├── parser.ts         # tasks.md → Task[] with topological sort
│   │   ├── formatter.ts      # Task → self-contained prompt for local model
│   │   ├── token-budget.ts   # Token budget calculation and context fitting
│   │   └── prompts/          # Individual prompt templates
│   │       ├── plan.ts
│   │       ├── quick-plan.ts
│   │       ├── research.ts
│   │       ├── spec.ts
│   │       ├── tasks.ts
│   │       ├── review.ts
│   │       └── escalation.ts
│   ├── detection/            # Auto-detect planners (CLI) and implementers
│   │   ├── index.ts          # Public re-exports
│   │   └── detection.ts      # Detection entry point
│   ├── parsers/              # Response parsers (question, code extraction)
│   │   ├── question-parser.ts    # Parse <!-- Q:{JSON} --> markers from planner stream
│   │   ├── response-extractor.ts # Code extraction from model responses
│   │   ├── scope-extractor.ts    # Function-level code extraction for large files
│   │   ├── code-detection.ts     # Code-language sniffer
│   │   └── code-patterns.ts      # Shared regex patterns
│   ├── streaming/            # Streaming transport layer
│   │   ├── claude-stream.ts  # Claude Code stream-json parsing
│   │   ├── openai-stream.ts  # OpenAI-compatible streaming client (timeout, error handling)
│   │   ├── output-parsers.ts # Unified output format parsers (text, stream-json, jsonl)
│   │   └── spawn-collect.ts  # Subprocess spawn + collect helper (stdin → parsed lines)
│   └── skills/               # Skill discovery (frontmatter parsing, .claude/skills scanning)
│       ├── index.ts          # Public re-exports
│       └── skills.ts
├── screens/                  # Top-level screen components
│   ├── home.tsx              # Home screen (banner, session list, input)
│   ├── setup.tsx             # Setup screen (planner/implementer selection)
│   ├── workflow.tsx          # Workflow screen (header, events, footer, input)
│   └── summary.tsx           # Post-run summary screen
├── components/               # Feature components (business logic + rendering)
│   ├── labeled-row.tsx       # <LabeledRow label value /> — canonical label + value row
│   ├── screen-shell.tsx      # <ScreenShell header footer /> — outer frame for screens
│   ├── home/                 # Home screen sub-components
│   │   ├── config-summary.tsx
│   │   └── recent-sessions.tsx
│   ├── conversation-flow/    # Scrollable event card list with auto-follow + virtual scroll
│   │   ├── index.ts
│   │   ├── conversation-flow.tsx
│   │   ├── use-scrollable-flow.ts
│   │   └── viewport-trimming.ts
│   ├── event-cards/          # TuiEvent rendering — typed renderer registry
│   │   ├── index.tsx         # Renderer registry (switch on event type)
│   │   ├── card.tsx          # <Card> primitive — canonical base for all event cards
│   │   ├── implementer-card.tsx
│   │   └── validate-card.tsx
│   ├── input-bar/            # Multiline input with slash command suggestions
│   │   ├── index.ts
│   │   ├── input-bar.tsx
│   │   ├── slash-suggestions.tsx
│   │   └── use-slash-autocomplete.ts
│   ├── workflow/             # Workflow screen sub-components
│   │   ├── cost-footer.tsx   # Real-time cost savings: Task N/M | Local: X% | Saved: ~$X
│   │   ├── header.tsx        # Top header (feature name, pipeline bar, elapsed time)
│   │   ├── pipeline-bar.tsx  # Phase progress: res spec plan impl rev
│   │   ├── review-view.tsx   # Spec/plan review display (markdown file viewer)
│   │   ├── sidebar.tsx       # Task list sidebar (progress, status)
│   │   └── task-summary.tsx  # Collapsed completed task with file path
│   ├── pickers/              # Generic picker primitives
│   │   ├── filterable-list.tsx  # FilterableList — canonical list-with-filter primitive (render-prop children API)
│   │   ├── single-column-picker.tsx
│   │   └── two-column-picker/   # Compound component (TwoColumnPicker.Columns, .Left, .Right, .Hint)
│   │       ├── index.ts
│   │       ├── two-column-picker.tsx
│   │       └── use-two-column-state.ts
│   └── overlays/             # Overlay components
│       ├── command-palette.tsx   # Ctrl+K command palette overlay
│       ├── help-overlay.tsx      # Keyboard shortcut help overlay
│       ├── mode-selector.tsx     # Workflow mode picker (quick/standard/full)
│       ├── overlay-panel.tsx     # Overlay panel primitive
│       ├── text-input-overlay.tsx
│       ├── settings-overlay/     # Unified settings overlay (all config fields + sub-pickers)
│       │   ├── index.ts
│       │   ├── settings-overlay.tsx
│       │   ├── settings-presentation.ts
│       │   └── use-settings-editor.ts
│       ├── skills-picker/        # Skill selection overlay
│       │   ├── index.ts
│       │   └── skills-picker.tsx
│       └── tool-model-picker/    # Planner/implementer backend + model selection
│           ├── index.ts
│           ├── tool-model-picker.tsx
│           ├── tool-row.tsx
│           ├── picker-catalog.ts
│           ├── picker-view.tsx
│           ├── use-picker-actions.ts
│           └── use-picker-catalog.ts
├── ui/                       # Low-level UI primitives (no business logic)
│   ├── diff-view.tsx         # Collapsible syntax-highlighted diff
│   ├── filter-input.tsx      # Reusable filter text input
│   ├── input/                # Controlled multiline input primitives
│   │   ├── multiline-input.tsx
│   │   ├── segments.ts       # Visual segment helpers
│   │   └── text-editing.ts   # Pure text-editing operations
│   ├── markdown.tsx          # Shared markdown rendering (parseBlocks, renderMarkdownLine, HighlightedCode)
│   ├── picker-utils.ts       # Shared picker helpers (scroll offset, truncation)
│   ├── scroll-indicator.tsx  # Scroll position indicator
│   ├── spinner.tsx           # Braille spinner component with elapsed time
│   └── theme.tsx             # Centralized color palette — zero hardcoded colors elsewhere
├── hooks/                    # React hooks (Ink-dependent lifecycle)
│   ├── use-async-highlight.ts # Shared Shiki highlight effect with cancellation
│   ├── use-filterable-list.ts # Filterable list state (search, scroll, selection)
│   ├── use-global-keys.ts    # Global keyboard shortcuts (reads stores, takes only { exit })
│   ├── use-input-mode.ts     # Input mode state (Promise-based, workflow-scoped)
│   ├── use-static-selector.ts # Fixed-list up/down/return/escape selector (no-filter peer)
│   ├── use-terminal-size.ts  # Terminal resize tracking + responsive layout
│   ├── use-workflow.ts       # Thin composition of runner + review-input hooks
│   ├── use-workflow-runner.ts # Engine invocation + abort lifecycle
│   └── use-workflow-review-input.ts # Review/question command parsing + handling
└── utils/                    # Helpers (no React/Ink dependencies)
    ├── diff.ts               # Line-level diff computation
    ├── editor.ts             # $EDITOR subprocess helpers
    ├── event-sections.ts     # Group TuiEvents into collapsible sections
    ├── format.ts             # Formatting helpers (tokens, cost, time, version parsing)
    ├── fs.ts                 # .tiny-spec/ directory management, archiving
    ├── git.ts                # Git operations (commit, diff, status, discard changes)
    ├── highlight.ts          # Shiki-based syntax highlighting (async, WASM)
    ├── process.ts            # Subprocess spawn, streaming, lifecycle, cleanup
    ├── sectioned-list.ts     # Sectioned list helpers (grouping, flattening)
    ├── sessions.ts           # Session directory management (project + global scope)
    ├── topo-sort.ts          # Topological sort for task dependencies
    └── with-timeout.ts       # Promise timeout wrapper
```

## Commands

```bash
npm run dev -- --help            # Show CLI help
npm run dev -- start "feature"   # Full workflow with TUI (default: standard mode)
npm run dev -- start --mode quick "feature"  # Quick mode: 1 planner call, 0 approvals
npm run dev -- start --mode full "feature"   # Full mode: 4 planner calls, 2 approvals
npm run dev -- spec "feature"    # Spec-only mode (no implementation)
npm run dev -- init              # Create config (Ink-based picker with model discovery)
npm run dev -- status            # Show workflow state
npm run dev -- resume            # Resume interrupted workflow
npm test                         # Run unit tests (vitest)
npm run test:watch               # Vitest in watch mode
npm run test:coverage            # Vitest with v8 coverage
npm run test:integration         # Integration tests under testing/integration/
npm run typecheck                # tsc --noEmit
npm run lint                     # Biome check
npm run format                   # Biome format --write
npm run build                    # tsc → dist/
```

## Prerequisites

- **Planner** — CLI: Claude Code (default), Codex, OpenCode, Aider, Agent SDK, shell; OR API: any OpenAI-compatible endpoint
- **Implementer** — Ollama (default), LM Studio, DeepSeek, OpenRouter, or any OpenAI-compatible endpoint
- **Node.js 22+**
- **Git** initialized in the target project

## Workflow Modes

| Mode | Planner Calls | Approval Gates | Best For |
|------|:---:|:---:|---|
| `quick` | 1 | 0 | Small: "add endpoint", "fix bug" |
| `standard` (default) | 4 | 1 (spec) | Medium features |
| `full` | 4 | 2 (spec + plan) | Large features, team handoffs |

Set via `--mode`, config `workflow.mode`, or `/mode` slash command at runtime.

## How It Works

```
User: "add user auth"
  → Planner researches codebase, writes spec/plan/tasks  [conversational cards]
  → Planner may ask clarifying questions (inline in flow)
  → User approves spec (and plan in full mode)
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
  tool: custom-ollama           # any string — known tools have provider defaults
  kind: api                     # api | shell | agent (optional, auto-detected)
  model: minimax-m2.7
  apiBase: http://my-server:11434/v1   # required for unknown tools
  apiKey: ""                    # optional, falls back to <TOOL>_API_KEY env var
```

Built-in planner backends: `claude-code`, `agent-sdk`, generic `cli`, `shell`, and API planner (any OpenAI-compatible endpoint).
Known implementer tools (with defaults): `ollama`, `lm-studio`, `deepseek`, `openrouter`. Any other tool name works as long as you supply `apiBase`.

Provider registry (`src/engine/providers/registry.ts`): `getProvider(name, overrides?)` returns known providers with defaults or creates generic ones for unknown names.
Provider catalog (`src/core/providers/catalog.ts`): static list of known model-vendor providers with their API base URLs and model lists.

## Implementation Status

All 45 tasks from `specs/002-cost-optimized-orchestrator/tasks.md` are complete (45 checked, 0 pending).
Current package version: `0.1.0` (see `package.json`). Test suite: 57 colocated test files / 700 tests.

### TUI Architecture

Conversation flow layout with structured event cards. Key design:
- `TuiEvent` union type drives all UI rendering via a typed renderer registry in `src/components/event-cards/index.tsx`
- `<Card>` (`src/components/event-cards/card.tsx`) is the canonical primitive for all new event card entries
- Planner output: markdown with Shiki-highlighted code blocks. Implementer: structured tool-call cards.
- Collapsible syntax-highlighted diffs, collapsible completed tasks, pipeline progress bar, cost savings footer.
- All colors from `src/ui/theme.tsx` (zero hardcoded hex in components)
- Zero React/Ink imports in `src/engine/` (clean engine/UI separation)
- `FilterableList` (`src/components/pickers/filterable-list.tsx`) is the canonical list-with-filter primitive. For advanced cases that need access to filter state from outside, consumers call `useFilterableList` directly instead of wrapping `FilterableList`.
- `TwoColumnPicker` (`src/components/pickers/two-column-picker/two-column-picker.tsx`) is a direct-props component: pass `leftProps` and `rightProps` objects. No React Context, no compound-component reflection.

### State Management (External Stores)

Uses DIY external stores built on React's `useSyncExternalStore` — zero dependencies, zero Context (except ThemeContext which is static). No `useMemo`, `useCallback`, or `React.memo` anywhere. No `forwardRef` / `useImperativeHandle` — React 19 + stores cover all those cases.

See `docs/STORES.md` for full architecture documentation.

**How it works:**
- `src/stores/create-store.ts` — ~45 line factory: `get()`, `set()`, `subscribe()`, `use(selector)`, `reset()`
- Domain stores: overlay, router, feedback, detection, config, conversation-scroll, skills, sessions, workflow
- `conversationScrollStore` (`src/stores/conversation-scroll.ts`) — replaces the old `forwardRef`/`useImperativeHandle` pattern in conversation-flow; any code can call `conversationScrollStore.scrollToBottom()` without holding a ref
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
- `useGlobalKeys` — Ink's `useInput` required for keybinding dispatch
- `useFilterableList` — keyboard-driven list state
- `useStaticSelector` — peer of `useFilterableList` for no-filter overlays
- `useTerminalSize` — terminal resize tracking
- `useAsyncHighlight` — wraps the Shiki async highlight pipeline with cancellation

**Keyboard input convention:**
Global keyboard handling lives in `src/hooks/use-global-keys.ts`. Local input primitives (multiline-input, filter-input, filterable-list, static-selector, etc.) may use `useInput` directly with their own focus/active gating. Avoid putting `useInput` directly in screen components — route through `useGlobalKeys` instead.

**What NOT to do:**
- Don't add `useMemo`, `useCallback`, or `React.memo` — store selectors make them unnecessary
- Don't use `forwardRef` / `useImperativeHandle` — extract state to a store instead (see `conversationScrollStore`)
- Don't call `store.set()` or `store.load()` during React render — causes infinite loops
- Don't add `loaded: boolean` flags to store state — init belongs in the CLI entry point, not in hooks
- Don't create React Context for shared state — use stores instead
- Don't create thin wrapper hooks around `store.use()` — call stores directly in components
- Don't put `commands` in a store — it closes over Ink's `exit()` function
- Don't use `configStore.get()` in components — use `configStore.use(selector)` or `configStore.useConfig()` for reactive reads (`.get()` is for non-React code)
- Use `feedbackStore.setMessage()` for informational messages (e.g., slash command feedback), `setError()` for actual errors
- When updating config via store, create new objects (immutable): `configStore.set({ ...configStore.get(), config: { ...config, workflow: { ...config.workflow, mode } } })`

### Testing Policy

- **Zero failing tests** — all tests must pass before any PR. No pre-existing failures accepted.
- **Agent implementer tests** spawn real subprocesses. The `command not found` test uses a login shell fallback (`-lc`) which can be slow on machines with heavy shell configs — it has a 30s timeout for this reason.

### Known Limitations

- TypeScript/JavaScript projects only (multi-language future)

See `specs/002-cost-optimized-orchestrator/research.md` for all architectural decisions and rationale.
