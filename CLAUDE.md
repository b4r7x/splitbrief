# diptych Development Guidelines

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
- `docs/STORES.md`  -  External store architecture (factory, patterns, inventory). **Read when touching anything under `src/stores/`.**
- `docs/STORES-RESTRUCTURE.md`  -  Historical RFC for the 2026-04 stores restructure (Phases 1–3). Captures rationale + decisions; read if curious why the directory looks the way it does.
- `docs/NO-BARRELS.md`  -  Codebase-wide principle: no re-export-only `index.ts` files. **Read before creating any new `index.ts`.** Applies to stores today, engine/core next.
- `docs/FUTURE-WORK.md`  -  Three deferred RFCs ready to execute (unbarrel `src/core/`, unbarrel `src/engine/`, refactor `inputHistoryStore` persistence boundary). Self-contained — do not re-audit, read the plans.

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 6.x, ESM only (`"type": "module"`)
- **Dev runner**: `tsx` (handles TypeScript + JSX/TSX + ESM, no custom loaders needed)
- **Testing**: Vitest 4.x (57 colocated test files / 700 tests)
- **Linter/formatter**: Biome 2.x (`npm run lint`, `npm run format`)
- **TUI**: Ink 6.8 (React 19 for CLI) + fullscreen-ink (custom multiline-input primitive under `src/components/input/`)
- **Syntax highlighting**: Shiki 4.x (WASM-based, async)
- **Terminal styling**: ansis (ANSI escape codes), cfonts (ASCII banners)
- **Planner / Implementer**: Both accept 5 runner kinds — `cli` (subprocess of known tool), `api` (any OpenAI-compatible endpoint via `openai` SDK), `shell` (arbitrary command), `agent` (file-writing command), `agent-sdk` (Anthropic Agent SDK)
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
- **kebab-case file naming**  -  Use kebab-case for multi-word file and folder names (`models-dev.ts`, `lm-studio.ts`). Prefer single-word names where natural (`pricing.ts`, `known.ts`, `registry.ts`). File names should match their primary concept.
- **No unsafe type assertions**  -  Do not use incidental `!` (non-null assertion) or broad `as` casts in production code. Use optional chaining (`?.`), type narrowing, or proper null checks instead.
- **Sanctioned assertion boundaries only**  -  The allowed exceptions are the internal assertion helpers in `src/utils/type-guards.ts`, the store internals in `src/stores/create-store.ts` and `src/stores/use-stores.ts`, and the branded ID constructors in `src/core/types/state-actions.ts` / `src/core/types/schemas/task.ts`. Keep assertions contained to those boundaries instead of spreading them through feature code.
- **Zero memoization**  -  No `useMemo`, `useCallback`, or `React.memo` anywhere in `src/`. Store selectors make them unnecessary.
- **No imperative handles**  -  No `forwardRef` / `useImperativeHandle`. React 19 + stores eliminate the need.

## Project Structure

`*.test.ts` / `*.test.tsx` files are colocated next to their implementations; omitted from the tree below.

```
src/
├── cli.ts                    # CLI entry point (commander registration)
├── app.tsx                   # Root Ink component — dispatches screen + overlay
├── layout.tsx                # Structural shell (2 props: screen + overlay as ReactNode)
├── types.ts                  # Re-exports from core/types/
├── stores/                   # External stores (useSyncExternalStore, zero deps, ZERO barrels — see docs/NO-BARRELS.md)
│   ├── create-store.ts       # Generic store factory
│   ├── use-stores.ts         # Multi-store Proxy-tracked hook
│   ├── ui/                   # Ephemeral UI chrome
│   │   ├── controls.ts       # sidebarVisible + inputMode (cross-tree flags)
│   │   ├── terminal-size.ts  # Terminal resize tracking + responsive layout
│   │   ├── overlay.ts        # Overlay active/exclusive/stack state
│   │   ├── feedback.ts       # Feedback/error message state
│   │   ├── input-history.ts  # Command input history (persisted to ~/.diptych/history)
│   │   └── input-height.ts   # Input bar rendered height (cross-tree)
│   ├── workflow/             # State scoped to a running workflow (4 sub-stores + actions)
│   │   ├── events.ts         # eventsStore + mergeEvent + MAX_EVENTS
│   │   ├── tasks.ts          # tasksStore + updateTaskMap + updateTaskCounts
│   │   ├── tokens.ts         # tokensStore + updateTokens
│   │   ├── lifecycle.ts      # lifecycleStore + updatePhase + updateQueueDepth
│   │   ├── actions.ts        # addEvent (dispatcher, cancelled gate), markCancelled, resetWorkflow, useSections, getSections, WorkflowViewState type
│   │   ├── abort.ts          # abortStore — pending flag + 2s auto-clear timer
│   │   ├── conversation-scroll.ts # Scroll position + expanded diffs
│   │   └── review.ts         # Review file path + scroll offset
│   ├── navigation/
│   │   └── router.ts         # Screen routing + transition guards
│   ├── project/              # Loaded-from-disk state tied to projectDir
│   │   ├── config.ts
│   │   ├── sessions.ts
│   │   ├── skills.ts
│   │   └── detection.ts
│   └── discovery/
│       └── model-cache.ts    # Per-provider model cache + Models.dev catalog
├── core/                     # Shared domain logic (config, types, commands, state, layout)
│   ├── phases.ts             # Phase role mapping + cancellable/implementer phase sets
│   ├── config/               # YAML config loading, defaults, validation
│   │   ├── index.ts          # Public re-exports
│   │   ├── access.ts
│   │   ├── loading.ts
│   │   ├── overrides.ts
│   │   ├── transforms.ts
│   │   ├── validation.ts
│   │   ├── migration.ts
│   │   ├── runner-config.ts
│   │   └── build-runner.ts
│   ├── layout/               # Pure layout / geometry helpers (no React)
│   │   ├── chrome-rows.ts
│   │   ├── conversation-scroll.ts
│   │   ├── diff-height.ts
│   │   ├── event-sections.ts
│   │   ├── picker-chrome.ts
│   │   ├── renderable-conversation.ts
│   │   ├── scroll-banner.ts
│   │   ├── scroll-window.ts
│   │   ├── terminal-width.ts
│   │   ├── viewport-trimming.ts
│   │   └── workflow-rect.ts
│   ├── migration/
│   │   └── legacy.ts         # Pre-v3 .diptych/current/ state migration
│   ├── model-display.ts
│   ├── paths.ts
│   ├── paths-io.ts
│   ├── project-meta.ts
│   ├── providers/            # Provider catalog + known models + model selection
│   │   ├── index.ts
│   │   ├── catalog.ts
│   │   ├── known-models.ts
│   │   └── model-selection.ts
│   ├── sessions/             # Session domain helpers
│   │   ├── active.ts
│   │   ├── analytics.ts
│   │   ├── begin.ts
│   │   ├── id.ts
│   │   ├── io.ts
│   │   ├── log-reader.ts
│   │   └── status.ts
│   ├── settings/             # Setting definitions and presentation
│   │   ├── catalog.ts
│   │   └── presentation.ts
│   ├── slash-commands/       # Slash command definitions and handlers
│   │   ├── index.ts
│   │   ├── definitions.ts
│   │   ├── executor.ts
│   │   ├── phase-guards.ts
│   │   ├── review-commands.ts
│   │   └── shortcuts.ts
│   ├── state/                # Workflow state machine
│   │   ├── machine.ts
│   │   ├── persistence.ts
│   │   ├── selectors.ts
│   │   └── topo-sort.ts
│   └── types/                # All shared types (split by domain)
│       ├── app.ts
│       ├── config-options.ts
│       ├── events.ts
│       ├── model-catalog.ts
│       ├── orchestrator-events.ts
│       ├── runner.ts
│       ├── state-actions.ts
│       ├── summary.ts
│       ├── theme.ts
│       ├── tui-events.ts     # TuiEvent union type
│       └── schemas/          # Zod schemas (source of truth for config types)
│           ├── config.ts
│           ├── enums.ts
│           ├── implementer-config.ts
│           ├── planner-config.ts
│           ├── question.ts
│           ├── runner-fields.ts
│           ├── session-log.ts
│           ├── session.ts
│           ├── summary.ts
│           ├── task.ts
│           ├── tokens.ts
│           └── workflow.ts
├── cli/                      # CLI-specific logic (non-React)
│   ├── commands/             # commander subcommand handlers
│   │   ├── guards.ts
│   │   ├── init.ts
│   │   ├── migrate.ts
│   │   ├── resume.ts
│   │   ├── spec.ts
│   │   ├── start.ts
│   │   └── status.ts
│   ├── errors.ts
│   ├── init-stores.ts        # Eager store bootstrap before React renders
│   ├── render.ts             # Ink/fullscreen rendering setup
│   └── workflow.ts           # Shared CLI workflow helpers
├── engine/                   # Workflow logic (zero React/Ink imports)
│   ├── index.ts              # Public re-exports
│   ├── agent-sdk.ts          # Shared Anthropic Agent SDK loader (optional peer dep)
│   ├── api-shared.ts
│   ├── change-detection.ts
│   ├── claude-runner.ts
│   ├── cli-tools.ts          # Shared CLI-tool detection / spawn helpers
│   ├── config-assertions.ts
│   ├── constants.ts
│   ├── http.ts
│   ├── session-expiry.ts
│   ├── orchestrator/         # Main workflow loop (decomposed into focused modules)
│   │   ├── index.ts          # runWorkflow main loop + re-exports
│   │   ├── approval.ts
│   │   ├── budget.ts
│   │   ├── clarifications.ts
│   │   ├── continuation-loop.ts
│   │   ├── continuation.ts
│   │   ├── cost-prediction.ts
│   │   ├── escalation.ts
│   │   ├── events.ts
│   │   ├── final-review.ts
│   │   ├── git-ops.ts
│   │   ├── helpers.ts
│   │   ├── native-injection.ts
│   │   ├── queue.ts
│   │   ├── queue-drain.ts
│   │   ├── regenerate.ts
│   │   ├── run.ts            # Top-level run entry point
│   │   ├── session-lifecycle.ts
│   │   ├── summary.ts
│   │   ├── task-commit.ts
│   │   ├── task-loop.ts
│   │   ├── task-step.ts
│   │   ├── tokens.ts
│   │   ├── transcript-rebuild.ts
│   │   ├── types.ts
│   │   ├── validator.ts
│   │   ├── validator-internal.ts
│   │   └── planning/
│   │       ├── index.ts
│   │       ├── new.ts
│   │       ├── quick.ts
│   │       ├── rewind.ts
│   │       └── shared.ts
│   ├── planners/             # Pluggable planner backends (5 runner kinds)
│   │   ├── types.ts          # PlannerBackend interface
│   │   ├── base.ts           # Shared planner factory
│   │   ├── agent-sdk.ts
│   │   ├── agent.ts
│   │   ├── api.ts
│   │   ├── claude-code.ts
│   │   ├── cli.ts
│   │   ├── command-invoke.ts
│   │   ├── context.ts
│   │   └── shell.ts
│   ├── implementers/         # Pluggable implementer backends (mirrors planner pattern)
│   │   ├── types.ts
│   │   ├── base.ts
│   │   ├── agent-sdk.ts
│   │   ├── agent.ts
│   │   ├── api.ts
│   │   ├── apply.ts
│   │   ├── cli.ts
│   │   ├── command-invoke.ts
│   │   ├── shell.ts
│   │   └── utils.ts
│   ├── runners/              # Symmetric planner/implementer factory
│   │   ├── factory.ts
│   │   └── command-based.ts
│   ├── providers/            # Provider registry, catalogs, pricing, HTTP clients
│   │   ├── anthropic.ts
│   │   ├── client.ts
│   │   ├── compat.ts
│   │   ├── discovery.ts
│   │   ├── groq.ts
│   │   ├── lm-studio.ts
│   │   ├── metadata.ts
│   │   ├── model-catalog.ts
│   │   ├── model-parsing.ts
│   │   ├── model-resolution.ts
│   │   ├── models-dev.ts
│   │   ├── ollama.ts
│   │   ├── openrouter.ts
│   │   ├── pricing.ts
│   │   ├── pricing-resolver.ts
│   │   ├── registry.ts
│   │   ├── test-helpers.ts
│   │   ├── together.ts
│   │   └── types.ts
│   ├── spec/                 # Spec parsing, formatting & prompt generation
│   │   ├── parser.ts         # tasks.md → Task[] with topological sort
│   │   ├── formatter.ts
│   │   ├── token-budget.ts
│   │   └── prompts/          # Individual prompt templates
│   │       ├── escalation.ts
│   │       ├── plan.ts
│   │       ├── quick-plan.ts
│   │       ├── research.ts
│   │       ├── review.ts
│   │       ├── shared.ts
│   │       ├── spec.ts
│   │       └── tasks.ts
│   ├── detection/            # Auto-detect planners (CLI) and implementers
│   │   ├── index.ts          # Public re-exports
│   │   ├── adapter.ts        # UI-facing refresh entry point (ex src/hooks/detection-adapter.ts)
│   │   ├── cache.ts
│   │   ├── detect.ts
│   │   └── service.ts
│   ├── parsers/              # Response parsers (question, code extraction)
│   │   ├── code-detection.ts
│   │   ├── code-patterns.ts
│   │   ├── question-parser.ts
│   │   ├── response-extractor.ts
│   │   └── scope-extractor.ts
│   ├── streaming/            # Streaming transport layer
│   │   ├── anthropic-stream.ts
│   │   ├── openai-stream.ts
│   │   ├── output-parsers.ts
│   │   ├── spawn-collect.ts
│   │   ├── stream-errors.ts
│   │   ├── token-utils.ts
│   │   └── transcript-buffer.ts
│   └── skills/               # Skill discovery (frontmatter parsing, .claude/skills scanning)
│       ├── index.ts
│       └── discovery.ts
├── features/                 # Business features — vertical slices, one folder per feature
│   ├── workflow/             # Running workflow: conversation, events, keyboard, runner
│   │   ├── screen.tsx        # Feature entry rendered by app.tsx
│   │   ├── handlers.ts       # Engine↔UI bridge (module-scoped handler registry)
│   │   ├── keyboard.ts       # Pure workflow-scope keyboard dispatchers
│   │   ├── layout.ts         # Pure geometry snapshots from workflow stores
│   │   ├── components/
│   │   │   ├── agent-status-row.tsx
│   │   │   ├── config-line.tsx
│   │   │   ├── cost-display.tsx
│   │   │   ├── cost-footer.tsx
│   │   │   ├── header.tsx
│   │   │   ├── pipeline-bar.tsx
│   │   │   ├── review-view.tsx
│   │   │   ├── sidebar.tsx
│   │   │   ├── task-summary.tsx
│   │   │   ├── conversation-flow/
│   │   │   │   └── flow.tsx  # Scrollable event card list
│   │   │   └── event-cards/  # TuiEvent renderers
│   │   │       ├── card.tsx  # <Card> primitive — canonical base for all event cards
│   │   │       ├── event-card.tsx  # Renderer dispatcher (switch on event type)
│   │   │       ├── cost-prediction-card.tsx
│   │   │       ├── escalate-card.tsx
│   │   │       ├── implementer-card.tsx
│   │   │       ├── planner-status-card.tsx
│   │   │       ├── user-message-card.tsx
│   │   │       ├── validate-card.tsx
│   │   │       └── workflow-config-card.tsx
│   │   └── hooks/
│   │       ├── use-workflow.ts             # Composite facade
│   │       ├── use-workflow-runner.ts      # Engine lifecycle, resume, rewind
│   │       ├── use-workflow-review-input.ts # Review/question command parsing
│   │       ├── use-workflow-keys.ts        # Workflow-only keyboard (mounted under screen==='workflow')
│   │       ├── use-input-mode.ts           # Promise-based modal input
│   │       ├── use-review-content.ts       # Async file read with cancellation
│   │       ├── use-mouse-scroll.ts         # Mouse-wheel → scroll binding
│   │       └── use-cost-stats.ts           # Formatted cost breakdown for footer
│   ├── home/                 # Landing screen
│   │   ├── screen.tsx
│   │   └── components/
│   │       ├── config-summary.tsx
│   │       └── recent-sessions.tsx
│   ├── setup/                # First-time setup (planner + implementer selection)
│   │   └── screen.tsx
│   ├── summary/              # Post-workflow report
│   │   ├── screen.tsx
│   │   └── components/
│   │       ├── summary-cost-breakdown.tsx
│   │       ├── summary-phase-timing.tsx
│   │       ├── summary-progress.tsx
│   │       └── summary-task-table.tsx
│   ├── settings/             # Settings overlay — unified field editor
│   │   ├── overlay.tsx       # Feature entry rendered when overlay active
│   │   ├── use-edit-buffer.ts
│   │   └── use-settings-editor.ts
│   ├── sessions/             # Sessions picker — resume past session
│   │   ├── picker.tsx
│   │   ├── picker-select.ts
│   │   └── session-row.tsx
│   ├── tool-picker/          # Planner/implementer backend + model selection
│   │   ├── picker.tsx
│   │   ├── picker-view.tsx
│   │   ├── catalog-adapter.ts
│   │   ├── config-transforms.ts
│   │   ├── model-sorting.ts
│   │   ├── picker-model-catalog.ts
│   │   ├── picker-options.ts
│   │   ├── tool-row.tsx
│   │   ├── view-state.ts
│   │   ├── use-picker-actions.ts
│   │   └── use-picker-catalog.ts
│   └── skills/               # Skills picker — toggle available skills
│       └── picker.tsx
├── components/               # SHARED UI (cross-feature) — primitives + shared overlays + pickers + input
│   ├── diff-view.tsx         # Collapsible syntax-highlighted diff
│   ├── filter-input.tsx      # Reusable filter text input
│   ├── labeled-row.tsx       # <LabeledRow label value /> — canonical label + value row
│   ├── markdown.tsx          # Shared markdown rendering (parseBlocks, renderMarkdownLine, HighlightedCode)
│   ├── screen-shell.tsx      # <ScreenShell header footer /> — outer frame for screens
│   ├── scroll-indicator.tsx  # Scroll position indicator
│   ├── spinner.tsx           # Braille spinner component with elapsed time
│   ├── theme.tsx             # Centralized color palette — zero hardcoded colors elsewhere
│   ├── input/                # Controlled multiline input primitives
│   │   ├── controlled-multiline-input.tsx
│   │   ├── measure-box.tsx
│   │   ├── multiline-input.tsx
│   │   ├── segments.ts
│   │   ├── text-editing.ts
│   │   └── viewport-scroll.ts
│   ├── input-bar/            # Composite input bar used on every screen
│   │   ├── index.tsx         # InputBar (real component, not a barrel)
│   │   ├── feedback-row.tsx
│   │   ├── history-navigation.ts
│   │   ├── input-footer.tsx
│   │   ├── slash-suggestions.tsx
│   │   ├── use-input-bar-history.ts
│   │   └── use-slash-autocomplete.ts
│   ├── overlays/             # SHARED overlays only — feature overlays live in features/
│   │   ├── command-palette.tsx   # Ctrl+K command palette
│   │   ├── help-overlay.tsx      # Keyboard shortcut help
│   │   ├── mode-selector.tsx     # Workflow mode picker (quick/standard/full)
│   │   ├── overlay-panel.tsx     # Overlay panel primitive
│   │   └── text-input-overlay.tsx
│   └── pickers/              # Generic picker primitives
│       ├── cursor-cell.tsx
│       ├── filterable-list.tsx  # FilterableList — canonical list-with-filter primitive
│       ├── picker-utils.ts      # Shared picker helpers (scroll offset, truncation)
│       ├── single-column-picker.tsx
│       └── two-column-picker/   # Direct-props compound picker
│           ├── picker.tsx
│           ├── two-column-keyboard.ts
│           ├── use-column-state.ts
│           └── use-two-column-state.ts
├── hooks/                    # SHARED React hooks only (cross-feature primitives) — flat, no subdirs, no barrels
│   ├── use-app-keys.ts       # App-wide keyboard dispatch (Ctrl+C, Ctrl+K, Escape, etc.) — always mounted
│   ├── use-async-highlight.ts # Shiki async highlight wrapper with cancellation
│   ├── use-filterable-list.ts # Filterable, searchable picker state (arrow-nav, filter, selection)
│   └── use-static-selector.ts # Fixed-list keyboard selector (no filter) — peer of use-filterable-list
└── utils/                    # Helpers (no React/Ink dependencies)
    ├── availability.ts       # Tool availability checks (version parsing + isAvailable)
    ├── diff.ts               # Line-level diff computation
    ├── error-hints.ts        # Human-readable hints for common error messages
    ├── format-errors.ts
    ├── format-numbers.ts     # Formatting helpers (tokens, cost, time)
    ├── frontmatter.ts        # YAML-style frontmatter parser for skill/config files
    ├── fs.ts                 # .diptych/ directory management, archiving
    ├── git.ts                # Git operations (commit, diff, status, discard changes)
    ├── highlight.ts          # Shiki-based syntax highlighting (async, WASM)
    ├── kitty-keyboard.ts     # Kitty keyboard protocol helpers
    ├── line-buffer.ts
    ├── mouse.ts              # Mouse event parsing
    ├── process.ts            # Subprocess spawn, streaming, lifecycle, cleanup
    ├── process-errors.ts     # Process error type guards and factory helpers
    ├── process-registry.ts   # Subprocess lifecycle management
    ├── redact.ts             # Secret/API-key redaction for safe logging
    ├── sectioned-list.ts     # Sectioned list helpers (grouping, flattening)
    ├── truncate.ts
    ├── type-guards.ts        # Generic type guard helpers (includes, assertNever)
    ├── warn.ts
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
npm run dev -- migrate           # Migrate pre-v3 .diptych/current/ state
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

Both planner and implementer accept five runner kinds (`cli`, `api`, `shell`, `agent`, `agent-sdk`). The `kind` field is the discriminant and is always required. Config uses `version: 2`.

```yaml
version: 2

# CLI kind — known tool (claude-code, codex, opencode, aider, copilot, kilo-code)
planner:
  kind: cli
  tool: claude-code
  model: claude-opus-4-5

# API kind — any OpenAI-compatible endpoint
implementer:
  kind: api
  provider: ollama              # known providers auto-fill apiBase
  model: qwen2.5:7b
  apiBase: http://localhost:11434/v1   # required; known providers auto-fill via migration

# Shell kind — arbitrary command (reads prompt via stdin, writes code to stdout)
planner:
  kind: shell
  command: claude-zai
  args: ["--output-format", "stream-json"]
  outputFormat: stream-json     # stream-json | jsonl | text

# Agent kind — command that writes files to disk (no stdout code extraction)
implementer:
  kind: agent
  command: my-file-writing-tool
  model: my-model
```

Five runner kinds: `cli` (known CLI tools), `api` (OpenAI-compatible HTTP), `shell` (stdin→stdout subprocess), `agent` (subprocess that writes files), `agent-sdk` (Anthropic Agent SDK library call).

Runner factory: `src/engine/runners/factory.ts` — `createPlanner(config)` and `createImplementer(config)` dispatch by `kind`.
Provider catalog (`src/core/providers.ts`): static list of known providers with API base URLs. Known providers: `ollama`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`.

## Implementation Status

All 45 tasks from `specs/002-cost-optimized-orchestrator/tasks.md` are complete (45 checked, 0 pending).
Current package version: `0.1.0` (see `package.json`). Test suite: 57 colocated test files / 700 tests.

### TUI Architecture

Conversation flow layout with structured event cards. Key design:
- `TuiEvent` union type drives all UI rendering via a typed renderer registry in `src/features/workflow/components/event-cards/event-card.tsx`
- `<Card>` (`src/features/workflow/components/event-cards/card.tsx`) is the canonical primitive for all new event card entries
- Planner output: markdown with Shiki-highlighted code blocks. Implementer: structured tool-call cards.
- Collapsible syntax-highlighted diffs, collapsible completed tasks, pipeline progress bar, cost savings footer.
- All colors from `src/components/theme.tsx` (zero hardcoded hex in components)
- Zero React/Ink imports in `src/engine/` (clean engine/UI separation)
- `FilterableList` (`src/components/pickers/filterable-list.tsx`) is the canonical list-with-filter primitive. For advanced cases that need access to filter state from outside, consumers call `useFilterableList` directly instead of wrapping `FilterableList`.
- `TwoColumnPicker` (`src/components/pickers/two-column-picker/picker.tsx`) is a direct-props component: pass `leftProps` and `rightProps` objects. No React Context, no compound-component reflection.

### State Management (External Stores)

Uses DIY external stores built on React's `useSyncExternalStore` — zero dependencies, zero Context (except ThemeContext which is static). No `useMemo`, `useCallback`, or `React.memo` anywhere. No `forwardRef` / `useImperativeHandle` — React 19 + stores cover all those cases.

See `docs/STORES.md` for full architecture documentation.

**How it works:**
- `src/stores/create-store.ts` — ~45 line factory: `get()`, `set()`, `subscribe()`, `use(selector)`, `reset()`
- Domain stores grouped under `src/stores/<group>/`: `ui/` (controls, terminal-size, overlay, feedback, input-history, input-height), `workflow/` (events, tasks, tokens, lifecycle, abort, conversation-scroll, review — plus `actions.ts` composite operations module), `navigation/` (router), `project/` (config, sessions, skills, detection), `discovery/` (model-cache). **Zero `index.ts` barrels inside `src/stores/`** — import directly from the source file. See [`docs/NO-BARRELS.md`](./docs/NO-BARRELS.md) and [`docs/STORES.md`](./docs/STORES.md).
- **Workflow is split into 4 sub-stores + actions module.** Reads: `eventsStore.use(s => s.events)`, `tasksStore.use(s => s.tasks)`, etc. Writes: `import { addEvent, markCancelled, resetWorkflow, useSections } from '../stores/workflow/actions.js'`. The dispatcher (`addEvent`) owns the `cancelled` gate and fan-out order. `resetWorkflow()` calls `abortStore.clear()` first. See `docs/STORES.md` §Workflow actions module.
- `conversationScrollStore` (`src/stores/workflow/conversation-scroll.ts`) — replaces the old `forwardRef`/`useImperativeHandle` pattern in conversation-flow; any code can call `conversationScrollStore.scrollToBottom()` without holding a ref
- Components subscribe to specific slices via `store.use(selector)` — only re-render when that slice changes
- `useStores(...stores)` (`src/stores/use-stores.ts`) — multi-store hook with Proxy per-key tracking. Pass N stores, destructure a tuple, re-render only when an accessed key changes. Use for flat property reads across 1+ stores:
  ```tsx
  const [{ projectDir }, { allSessions }, { cols, isSmall }] = useStores(configStore, sessionsStore, terminalSizeStore);
  ```
  Keep `store.use(selector)` for computed/conditional selectors (`s => hasWorkflowConfig(s.events)`, `s => s.active !== 'none'`) — Proxy tracking only sees flat property reads.
- **`useStores` limitations** (Proxy `get` trap only): `Object.keys(x)`, `for...in`, spread (`{...x}`), rest (`{a, ...r}`), reads inside handlers/async callbacks (outside render phase) are **not tracked**. Use `store.use(selector)` for those cases.
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
  Engine code → addEvent() (from workflow/actions.js) → sub-store .set() fan-out → subscribers re-render
```

**What stays as React hooks (can't be stores):**
- `useInputMode` (`src/features/workflow/hooks/use-input-mode.ts`) — Promise-based resolver pattern (workflow-scoped lifecycle)
- `useWorkflow` (`src/features/workflow/hooks/use-workflow.ts`) — orchestrator lifecycle (useEffect + store reads + engine bridge)
- `useAppKeys` (`src/hooks/use-app-keys.ts`) — app-wide keybindings (Ctrl+C, Ctrl+K, Escape, etc.); always mounted
- `useWorkflowKeys` (`src/features/workflow/hooks/use-workflow-keys.ts`) — workflow-only keyboard (scroll, review chords, sidebar toggle); mounted only when `screen === 'workflow'`
- `useFilterableList` (`src/hooks/use-filterable-list.ts`) — keyboard-driven list state
- `useStaticSelector` (`src/hooks/use-static-selector.ts`) — peer of `useFilterableList` for no-filter overlays
- `useAsyncHighlight` (`src/hooks/use-async-highlight.ts`) — wraps the Shiki async highlight pipeline with cancellation

**Keyboard input convention:**
App-wide keyboard handling lives in `src/hooks/use-app-keys.ts` (mounted at the layout level). Workflow-specific keyboard handling lives in `src/features/workflow/hooks/use-workflow-keys.ts` (mounted inside the workflow screen). Local input primitives (multiline-input, filter-input, filterable-list, static-selector, etc.) may use `useInput` directly with their own focus/active gating. Avoid putting `useInput` directly in screen components — route through `useAppKeys` / `useWorkflowKeys` instead.

**What NOT to do:**
- Don't add `useMemo`, `useCallback`, or `React.memo` — store selectors make them unnecessary
- Don't use `forwardRef` / `useImperativeHandle` — extract state to a store instead (see `conversationScrollStore`)
- Don't call `store.set()` or `store.load()` during React render — causes infinite loops
- Don't add `loaded: boolean` flags to store state — init belongs in the CLI entry point, not in hooks
- Don't create React Context for shared state — use stores instead
- Don't create thin wrapper hooks around `store.use()` — call stores directly in components (`useStores` is the sanctioned exception for multi-store flat reads)
- Don't put `commands` in a store — it closes over Ink's `exit()` function
- Don't use `configStore.get()` in components — use `configStore.use(selector)` or `configStore.useConfig()` for reactive reads (`.get()` is for non-React code)
- Use `feedbackStore.setMessage()` for informational messages (e.g., slash command feedback), `setError()` for actual errors
- When updating config via store, create new objects (immutable): `configStore.set({ ...configStore.get(), config: { ...config, workflow: { ...config.workflow, mode } } })`
- Don't create re-export-only `index.ts` barrels in `src/stores/`, `src/hooks/`, `src/features/`, or `src/components/` — zero tolerance, see `docs/NO-BARRELS.md`. Remaining `index.ts` barrels under `src/core/` and `src/engine/` are tracked in `docs/FUTURE-WORK.md`.
- Don't reintroduce `workflowStore` as a single object — the split into `eventsStore`/`tasksStore`/`tokensStore`/`lifecycleStore` + `actions.ts` is deliberate. Read the sub-store or call an action from `workflow/actions.js`.

### Testing Policy

- **Zero failing tests** — all tests must pass before any PR. No pre-existing failures accepted.
- **Agent implementer tests** spawn real subprocesses. The `command not found` test uses a login shell fallback (`-lc`) which can be slow on machines with heavy shell configs — it has a 30s timeout for this reason.

### Known Limitations

- TypeScript/JavaScript projects only (multi-language future)

See `specs/002-cost-optimized-orchestrator/research.md` for all architectural decisions and rationale.

## Active Technologies
- TypeScript 6.x, ESM only (`"type": "module"`), Node.js 22+ + `zod` 3.x (schema validation), `yaml` (YAML parsing), `vitest` 4.x (testing), `ink` 6.x (TUI / React 19), `commander` (CLI), `@anthropic-ai/claude-agent-sdk` (optional peer dep — isolated in `src/engine/agent-sdk.ts:loadSdk`)
- `.diptych/config.yaml` (user config, YAML, version: 2), `.diptych/sessions/<id>/state.json` (workflow state, display strings only)
