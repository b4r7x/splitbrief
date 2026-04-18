# diptych Development Guidelines

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass, not even when a workflow step suggests it. The user reviews and commits all changes manually in their editor. Leave every change as an unstaged modification in the working tree. This rule overrides any other instruction or workflow that suggests committing.

**Enforcement:** A `PreToolUse` hook at `.claude/hooks/block-git-commits.sh` (configured in `.claude/settings.json`) intercepts every Bash invocation and blocks `git add`, `git stage`, and `git commit` (and all flag-prefixed / chained variants) with exit code 2. The hook also catches `git -c key=val commit` and piped/semicolon-chained forms. If you see a `BLOCKED:` message in stderr, that is this guardrail doing its job — stop and report to the user.

---

Open-source CLI tool that orchestrates expensive AI (Claude Code / Opus) for planning and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs.

## Quick Context

Start here to orient yourself in the codebase. Every link below exists.

- `docs/VISION.md`  -  Strategic direction, competitive analysis, design decisions. **Read first for why diptych exists.**
- `docs/PRINCIPLES.md`  -  One-page index of architectural rules (screaming architecture, deep modules, folder colocation, type placement, etc.) with links to canonical docs. **Read first for orientation.**
- `docs/ARCHITECTURE.md`  -  How the pieces fit together — planner/implementer runner contracts, the orchestrator loop, event model, capability matrix.
- `docs/CONCEPTS.md`  -  Shared vocabulary (planner, implementer, escalation, session, event, etc.) used across `src/` and docs.
- `docs/STRUCTURE.md`  -  File-tree layout, feature anatomy, folder colocation rules, file length thresholds. Companion to `LAYERS.md` (what vs where).
- `docs/LAYERS.md`  -  Decision tree for `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/`. **Read before adding any new file to these folders.**
- `docs/STORES.md`  -  External store architecture (factory, patterns, inventory). **Read when touching anything under `src/stores/`.**
- `docs/TYPES.md`  -  Type placement rules (Zod schemas vs TS types, three-case rule, screaming types). **Read before adding or moving any type.**
- `docs/NO-BARRELS.md`  -  Codebase-wide principle: no re-export-only `index.ts` files. **Read before creating any new `index.ts`.** Enforced — zero barrels anywhere in `src/`.
- `docs/HOOKS.md`  -  React hook conventions (what stays a hook, what becomes a store, keyboard mounting).
- `docs/BOOTSTRAP.md`  -  How the app starts (`initStores()`, phase responsibilities, cross-store orchestration). **Read before adding a startup step.**
- `docs/ERRORS.md`  -  Canonical error pattern: `error()` factory + domain predicate bag + `kind` discriminator. **Read before creating a new error type.**
- `docs/TESTING.md`  -  Test placement (colocated vs `testing/integration/`), fake factories, and the static-as-trophy-tier rule.
- `docs/WORKFLOW.md`  -  End-user workflow: modes, approval gates, slash commands, rewind/resume.
- `docs/FUTURE.md`  -  Deliberately deferred features (not yet built). Current roadmap for ideas that have shape but await priority.
- `docs/API-KEYS.md`  -  How API keys are resolved and redacted.
- `docs/adr/`  -  Architecture Decision Records (rationale + alternatives considered).
- `.specify/memory/constitution.md`  -  6 constitutional principles (v1.3.1) — referenced from `docs/VISION.md`.

## Tech Stack

- **Runtime**: Node.js 22+
- **Language**: TypeScript 6.x, ESM only (`"type": "module"`)
- **Dev runner**: `tsx` (handles TypeScript + JSX/TSX + ESM, no custom loaders needed)
- **Testing**: Vitest 4.x (colocated tests: `foo.test.ts` next to `foo.ts`)
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
- **Sanctioned assertion boundaries only**  -  The allowed exceptions are the internal assertion helpers in `src/utils/type-guards.ts`, the store internals in `src/stores/create-store.ts` and `src/stores/use-stores.ts`, and the branded ID constructors in `src/core/types/state-actions.ts` / `src/core/schemas/task.ts`. Keep assertions contained to those boundaries instead of spreading them through feature code. Enforced by review and `tsc --strict`, not by automated tree-walking.
- **Zero memoization**  -  No `useMemo`, `useCallback`, or `React.memo` anywhere in `src/`. Store selectors make them unnecessary.
- **No imperative handles**  -  No `forwardRef` / `useImperativeHandle`. React 19 + stores eliminate the need.

## Project Structure

`*.test.ts` / `*.test.tsx` files are colocated next to their implementations; omitted from the tree below.

```
src/
├── cli.ts                    # CLI entry point (commander registration)
├── app.tsx                   # Root Ink component — dispatches screen + overlay
├── layout.tsx                # Structural shell (2 props: screen + overlay as ReactNode)
├── stores/                   # External stores (useSyncExternalStore, zero deps, ZERO barrels — see docs/NO-BARRELS.md)
│   ├── create-store.ts       # Generic store factory
│   ├── use-stores.ts         # Multi-store Proxy-tracked hook
│   ├── ui/                   # Ephemeral UI chrome
│   │   ├── controls.ts       # sidebarVisible + inputMode (cross-tree flags)
│   │   ├── terminal-size.ts  # Terminal resize tracking + responsive layout
│   │   ├── overlay.ts        # Overlay active/exclusive/stack state
│   │   ├── feedback.ts       # Feedback/error message state
│   │   ├── input-history.ts  # Command input history (persisted to ~/.diptych/history)
│   │   ├── input-height.ts   # Input bar rendered height (cross-tree)
│   │   └── persistence.ts    # Disk I/O for inputHistoryStore (hydrate + debounced save)
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
├── core/                     # Shared domain logic (config, schemas, commands, state, layout)
│   ├── phases.ts             # Phase role mapping + cancellable/implementer phase sets
│   ├── config/               # YAML config loading, defaults, validation (grouped by lifecycle)
│   │   ├── errors.ts         # configError() factory + isConfigError predicate
│   │   ├── load/             # Disk → validated config (load, migrate, transform, validate)
│   │   │   ├── load.ts
│   │   │   ├── migrate.ts
│   │   │   ├── transform.ts
│   │   │   └── validate.ts
│   │   ├── runtime/          # Runtime assembly (build runner configs, apply overrides)
│   │   │   ├── build-runner.ts
│   │   │   └── overrides.ts
│   │   └── accessors/        # Read-side helpers (runner-config selection, state access)
│   │       ├── runner-config.ts
│   │       └── state.ts
│   ├── formatting.ts         # LLM-domain formatters (formatCost, formatContextLength)
│   ├── layout/               # Pure layout / geometry helpers (no React)
│   │   ├── chrome-rows.ts
│   │   ├── conversation-scroll.ts
│   │   ├── diff-height.ts
│   │   ├── event-sections.ts
│   │   ├── renderable-conversation.ts
│   │   ├── scroll-window.ts
│   │   ├── terminal-width.ts
│   │   ├── viewport-trimming.ts
│   │   └── workflow-rect.ts
│   ├── migration/
│   │   ├── executor.ts       # Business logic for the migrate command (orchestrates legacy helpers + I/O)
│   │   └── legacy.ts         # Pre-v3 .diptych/current/ state migration primitives
│   ├── model-display.ts
│   ├── paths.ts
│   ├── paths-io.ts
│   ├── project-meta.ts
│   ├── providers/            # Provider catalog + known models + model selection
│   │   ├── catalog.ts
│   │   ├── known-models.ts
│   │   └── model-selection.ts
│   ├── schemas/              # Zod schemas — source of truth for config types (promoted from types/schemas)
│   │   ├── config.ts
│   │   ├── enums.ts
│   │   ├── implementer-config.ts
│   │   ├── models-dev.ts
│   │   ├── planner-config.ts
│   │   ├── question.ts
│   │   ├── runner-fields.ts
│   │   ├── session-log.ts
│   │   ├── session.ts
│   │   ├── summary.ts
│   │   ├── task.ts
│   │   ├── tokens.ts
│   │   └── workflow.ts
│   ├── sessions/             # Session domain helpers (consolidated to lifecycle + io + log-reader + analytics + guards + display + errors)
│   │   ├── analytics.ts
│   │   ├── display.ts        # Session display formatters (was core/sessions-display.ts)
│   │   ├── errors.ts         # sessionError() factory + isSessionError predicate
│   │   ├── guards.ts         # clearStaleSession and session-state predicates
│   │   ├── io.ts
│   │   ├── lifecycle.ts
│   │   └── log-reader.ts
│   ├── settings/             # Setting definitions and presentation
│   │   ├── catalog.ts
│   │   └── presentation.ts
│   ├── slash-commands/       # Slash command catalog + dispatch + keybindings + types
│   │   ├── catalog.ts
│   │   ├── context.ts        # Slash command execution context assembly
│   │   ├── dispatch.ts
│   │   ├── fuzzy.ts          # Fuzzy match scorer for slash command filtering
│   │   ├── keybindings.ts
│   │   └── types.ts
│   ├── state/                # Workflow state machine
│   │   ├── machine.ts
│   │   ├── persistence.ts
│   │   ├── selectors.ts
│   │   └── topo-sort.ts
│   ├── validation/           # Validation domain heuristics
│   │   └── test-discovery.ts # src/foo.ts → tests/foo.test.ts resolver (cached)
│   └── types/                # Cross-cutting TS-only types. No `z.infer` (those live with their schema in core/schemas/).
│       ├── config-options.ts # DetectedModel, WorkflowOpts, PlannerDetection, ProviderDetection, PlannerTool
│       ├── state-actions.ts  # StateAction, TokenBudget, CodeContext, ProjectContext
│       └── summary.ts        # ImplementerResult, ValidationResult
├── cli/                      # CLI-specific logic (non-React)
│   ├── commands/             # commander subcommand handlers
│   │   ├── init.ts
│   │   ├── migrate.ts
│   │   ├── resume.ts
│   │   ├── spec.ts
│   │   ├── start.ts
│   │   └── status.ts
│   ├── errors.ts             # cliError() factory + isCliError predicate — see docs/ERRORS.md
│   ├── init-stores.ts        # Eager store bootstrap before React renders (3 internal helpers) — see docs/BOOTSTRAP.md
│   ├── options.ts            # Commander fluent builder (addWorkflowOptions)
│   ├── render.ts             # Ink/fullscreen rendering setup
│   └── setup.ts              # Bootstrap prep: resolveProjectDir, ensureGitAndConfig, setupWorkflow
├── engine/                   # Workflow logic (zero React/Ink imports) — zero barrels
│   ├── agent-sdk.ts          # Shared Anthropic Agent SDK loader (optional peer dep)
│   ├── change-detection.ts
│   ├── claude-runner.ts
│   ├── cli-tools.ts          # Shared CLI-tool detection / spawn helpers
│   ├── config-assertions.ts
│   ├── constants.ts
│   ├── session-expiry.ts
│   ├── errors/               # Engine-scoped error diagnosis
│   │   └── hints.ts          # Provider error hints (Ollama, LM Studio, etc.)
│   ├── orchestrator/         # Main workflow loop (decomposed into focused modules)
│   │   ├── approval.ts
│   │   ├── budget.ts
│   │   ├── clarifications.ts
│   │   ├── continuation.ts   # Continuation loop + regeneration (merged from continuation-loop + regenerate)
│   │   ├── cost-prediction.ts
│   │   ├── events.ts         # Event emission primitives (state-change events live in state-ops.ts)
│   │   ├── final-review.ts
│   │   ├── native-injection.ts
│   │   ├── planner-review.ts
│   │   ├── queue.ts          # Queue management (absorbed queue-drain)
│   │   ├── resume-context.ts
│   │   ├── session-lifecycle.ts
│   │   ├── signals.ts
│   │   ├── state-ops.ts      # State-change event emitters (emitPlanApproved, etc.)
│   │   ├── summary.ts
│   │   ├── task-commit.ts
│   │   ├── task-loop.ts
│   │   ├── task-step.ts
│   │   ├── tokens.ts
│   │   ├── transcript-rebuild.ts
│   │   ├── types.ts
│   │   ├── validation.ts     # Validation pipeline (merged from validator + validator-internal)
│   │   ├── run/              # Top-level run entry point, split by phase
│   │   │   ├── run.ts        # Entry — orchestrates init + phases
│   │   │   ├── init.ts
│   │   │   └── phases.ts
│   │   ├── escalation/       # Escalation flow (local → intermediate → full → hint)
│   │   │   ├── escalation.ts # Entry dispatcher
│   │   │   ├── step.ts
│   │   │   ├── local.ts
│   │   │   ├── intermediate.ts
│   │   │   ├── full.ts
│   │   │   └── hint.ts
│   │   └── planning/
│   │       ├── run.ts        # runPlanningPhase dispatcher (was planning/index.ts)
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
│   │   ├── command-based.ts
│   │   ├── errors.ts         # runnerError() factory + isRunnerError predicate
│   │   └── types.ts          # Runner config types (was core/types/runner.ts)
│   ├── providers/            # Provider registry, catalogs, pricing, HTTP clients
│   │   ├── anthropic/        # Per-provider folder (adapter + stream)
│   │   │   ├── adapter.ts
│   │   │   └── stream.ts
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
│   │   ├── openai-stream.ts  # OpenAI-compatible stream parser (promoted from streaming/)
│   │   ├── openrouter.ts
│   │   ├── pricing.ts
│   │   ├── pricing-resolver.ts
│   │   ├── registry.ts
│   │   ├── constants.ts      # Provider constants (default models, timeouts)
│   │   ├── errors.ts         # providerError() factory + isProviderError predicate
│   │   ├── __test-helpers__.ts  # Test support (vitest import); excluded from production tsc
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
│   ├── streaming/            # Streaming transport layer (provider-specific streams live under providers/)
│   │   ├── output-parsers.ts
│   │   ├── spawn-collect.ts
│   │   ├── stream-errors.ts
│   │   ├── token-utils.ts
│   │   └── transcript-buffer.ts
│   └── skills/               # Skill discovery (frontmatter parsing, .claude/skills scanning)
│       └── discovery.ts
├── features/                 # Business features — vertical slices, one folder per feature
│   ├── workflow/             # Running workflow: conversation, events, keyboard, runner
│   │   ├── screen.tsx        # Feature entry rendered by app.tsx
│   │   ├── handlers.ts       # Engine↔UI bridge (module-scoped handler registry)
│   │   ├── keyboard.ts       # Pure workflow-scope keyboard dispatchers
│   │   ├── layout.ts         # Pure geometry snapshots from workflow stores
│   │   ├── review-parser.ts  # Review/question command parsing (pure)
│   │   ├── types.ts          # Feature-local types
│   │   ├── components/
│   │   │   ├── agent-status-row.tsx
│   │   │   ├── config-line.tsx
│   │   │   ├── cost-display.tsx
│   │   │   ├── cost-footer.tsx
│   │   │   ├── feedback-row.tsx   # Feedback/error row + abort hint — consumed only by workflow screen
│   │   │   ├── header.tsx
│   │   │   ├── input-footer.tsx   # Input bar footer (status text + token counter)
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
│   │       ├── build-rewind-action.ts      # Pure builder: session → rewind StateAction
│   │       ├── use-workflow-runner.ts      # Engine lifecycle, resume, rewind
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
│   │   ├── mode-selector.tsx # Workflow mode picker (quick/standard/full) — single consumer is app.tsx overlay switch
│   │   ├── use-edit-buffer.ts
│   │   └── use-settings-editor.ts
│   ├── sessions/             # Sessions picker — resume past session
│   │   ├── picker.tsx
│   │   └── picker-select.ts
│   ├── tool-picker/          # Planner/implementer backend + model selection
│   │   ├── picker.tsx
│   │   ├── picker-view.tsx
│   │   ├── model-catalog.ts
│   │   ├── config-transforms.ts
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
│   ├── session-row.tsx       # Shared session row (used by features/sessions + features/home)
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
│   │   ├── history-navigation.ts
│   │   ├── slash-suggestions.tsx
│   │   ├── use-input-bar-history.ts
│   │   └── use-slash-autocomplete.ts
│   ├── overlays/             # SHARED overlays only — feature overlays live in features/
│   │   ├── command-palette.tsx   # Ctrl+K command palette
│   │   ├── help-overlay.tsx      # Keyboard shortcut help
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
│   ├── navigate-index.ts     # Pure index wrap/clamp helper shared by list/selector hooks
│   ├── use-app-keys.ts       # App-wide keyboard dispatch (Ctrl+C, Ctrl+K, Escape, etc.) — always mounted
│   ├── use-async-highlight.ts # Shiki async highlight wrapper with cancellation
│   ├── use-filterable-list.ts # Filterable, searchable picker state (arrow-nav, filter, selection)
│   └── use-static-selector.ts # Fixed-list keyboard selector (no filter) — peer of use-filterable-list
├── lib/                      # Infrastructure wrappers — see docs/LAYERS.md
│   ├── availability.ts       # Tool availability probing (version parsing + isAvailable)
│   ├── fs.ts                 # Security-aware filesystem helpers (ensureSecureDir, writeSecureFile, ensureGitignore)
│   ├── git.ts                # simple-git wrapper (stageAll, commitChanges, diff, status, createCheckpoint, discardTaskChanges) — sole simple-git importer
│   ├── highlight.ts          # Shiki syntax highlighting wrapper (async, WASM)
│   ├── warn.ts               # stderr formatter
│   ├── process/              # Subprocess subsystem
│   │   ├── spawn.ts          # spawn + streaming + lifecycle
│   │   ├── errors.ts         # Process error type guards + factory
│   │   ├── registry.ts       # Active-subprocess tracking + signal handling
│   │   └── line-buffer.ts    # stdout line buffering primitive
│   └── terminal/             # Terminal protocol helpers
│       ├── mouse.ts          # Mouse event parsing + Ink stdin interop
│       └── kitty-keyboard.ts # Kitty keyboard protocol detection
└── utils/                    # Generic primitives (zero domain, zero infra) — see docs/LAYERS.md
    ├── diff.ts               # LCS diff algorithm
    ├── error.ts              # error() factory + matches() predicate helper — see docs/ERRORS.md
    ├── format-errors.ts      # Error → string with redaction
    ├── format-time.ts        # Generic time formatters (formatDuration, formatTime, formatTimeHHMMSS, formatEta)
    ├── frontmatter.ts        # Generic YAML frontmatter parser
    ├── parse-shell-command.ts # Quote/escape-aware shell tokenizer
    ├── redact.ts             # Secret/API-key redaction
    ├── sectioned-list.ts     # List grouping helper
    ├── slugify.ts            # kebab-case slug generator (used by sessions + migration)
    ├── truncate.ts           # Text truncation (truncateByChars, truncateByLines, truncateWithEllipsis)
    ├── type-guards.ts        # assertNever, isRecord, typedEntries, etc.
    ├── validate-identifier.ts # Safe identifier validators (e.g. feature slugs)
    └── with-timeout.ts       # withTimeout + withIdleTimeout + timeoutError bag
```

Domain-aware formatters moved to `src/core/formatting.ts` (`formatCost`, `formatContextLength`). Provider-specific error hints moved to `src/engine/errors/hints.ts`.

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
Provider catalog (`src/core/providers/catalog.ts`): static list of known providers with API base URLs. Known providers: `ollama`, `lm-studio`, `anthropic`, `openrouter`, `deepseek`.

## Implementation Status

Core orchestrator is shipped and in daily use. Current package version: see `package.json`. For the current direction and deferred work, see `docs/VISION.md` and `docs/FUTURE.md`.

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
- `useWorkflowRunner` (`src/features/workflow/hooks/use-workflow-runner.ts`) — orchestrator lifecycle (useEffect + store reads + engine bridge)
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
- Don't export raw `store.set` from a store facade — expose named actions. Tests may use `__testReset(nextState?)` as the single sanctioned escape hatch (see `docs/STORES.md` anti-patterns, `docs/adr/0010-store-setter-hardening.md`).
- When updating config via store, use a named action (e.g. `configStore.setContextLength(n)`, `configStore.save(updated)`) or `configStore.__testReset(...)` in tests.
- Don't create re-export-only `index.ts` barrels anywhere in `src/` — zero tolerance, see `docs/NO-BARRELS.md`. All application barrels have been removed; `find src -name 'index.ts'` must stay at zero.
- Don't reintroduce `workflowStore` as a single object — the split into `eventsStore`/`tasksStore`/`tokensStore`/`lifecycleStore` + `actions.ts` is deliberate. Read the sub-store or call an action from `workflow/actions.js`.

### Testing Policy

- **Zero failing tests** — all tests must pass before any PR. No pre-existing failures accepted.
- **Blast-radius rule for placement.** Colocated (`foo.test.ts` beside `foo.ts`) if the test touches one top-level folder; `testing/integration/<layer>/` (`cli/` | `orchestrator/` | `ui/`) if it spans multiple. See [`docs/TESTING.md`](./docs/TESTING.md) and [ADR T1](./docs/adr/T1-hybrid-test-layout.md).
- **Zero new fakes.** Use `createFakePlanner` / `createFakeImplementer` from `testing/helpers/orchestrator-factories.ts` for orchestrator integration tests. Extend via the fake's `script` parameter; do not add parallel fake implementations. See [ADR T4](./docs/adr/T4-engine-at-runworkflow-boundary.md).
- **Zod schemas do not get runtime shape tests.** TS strict + `schema.parse()` is the test. One repo-wide `.strict()` rejection test lives in `src/core/schemas/runner-fields.test.ts`. See [ADR T5](./docs/adr/T5-static-as-trophy-tier.md).
- **Ink tested at the feature seam.** `screen.tsx` / `overlay.tsx` / `picker.tsx` get tests; sub-components under `features/<f>/components/` do not. Shared primitives in `src/components/` are the exception. See [ADR T3](./docs/adr/T3-ink-feature-seam.md).
- **CI runs `npm run typecheck && npm run lint && npm test`** in that order via the `test-ci` script. Static fails fast; runtime tests never run against a broken type graph.
- **Agent implementer tests** spawn real subprocesses. The `command not found` test uses a login shell fallback (`-lc`) which can be slow on machines with heavy shell configs — it has a 30s timeout for this reason.

### Known Limitations

- TypeScript/JavaScript projects only (multi-language future)

See `docs/ARCHITECTURE.md` for system architecture and `docs/adr/` for individual decision records with alternatives considered.

## Active Technologies
- TypeScript 6.x, ESM only (`"type": "module"`), Node.js 22+ + `zod` 4.x (v4.3.6, schema validation), `yaml` (YAML parsing), `vitest` 4.x (testing), `ink` 6.x (TUI / React 19), `commander` (CLI), `@anthropic-ai/claude-agent-sdk` (optional peer dep — isolated in `src/engine/agent-sdk.ts:loadSdk`)
- `.diptych/config.yaml` (user config, YAML, version: 2), `.diptych/sessions/<id>/state.json` (workflow state, display strings only)
