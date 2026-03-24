# tiny-spec Development Guidelines

Open-source CLI tool that orchestrates expensive AI (Claude/Opus) for planning and cheap/local AI (Ollama/LM Studio) for implementation, saving 50%+ on AI coding costs.

## Quick Context

- `specs/001-tiny-spec-core/spec.md` — Full specification
- `specs/001-tiny-spec-core/plan.md` — Architecture, dependencies, file structure
- `specs/001-tiny-spec-core/tasks.md` — 33 implementation tasks across 9 phases
- `specs/001-tiny-spec-core/research.md` — Condensed research findings

## Tech Stack

- **Runtime**: Node.js 22+ with native TypeScript stripping (`--experimental-strip-types`)
- **Language**: TypeScript 5.9+, ESM only (`"type": "module"`)
- **TUI**: Ink 5.x (React for CLI) + @inkjs/ui
- **APIs**: `@anthropic-ai/sdk` (Claude), `openai` (OpenAI-compatible for Ollama/LM Studio)
- **Config**: `yaml` package
- **Git**: `simple-git` package
- **CLI**: `commander` package
- **Testing**: `node --experimental-strip-types --test`

## Code Conventions

- **Zero classes** — Pure functions, module-scoped state
- **ESM imports** — Always use `.js` extension in imports (`'./config.js'`, not `'./config'`)
- **No unnecessary comments** — Code should be self-explanatory
- **Error at boundaries** — Internal functions propagate, callers decide
- **JSX for Ink** — `.tsx` files for React components, `.ts` for everything else

## Project Structure

```
src/
├── cli.ts                    # CLI entry point
├── app.tsx                   # Root Ink component
├── types.ts                  # All shared types
├── config.ts                 # Config loading
├── state.ts                  # Workflow state machine
├── tui/                      # Ink UI components
│   ├── layout.tsx            # Split-pane layout
│   ├── pane.tsx              # Scrollable output pane
│   ├── status-bar.tsx        # Bottom status bar
│   ├── header.tsx            # Top header
│   └── prompt.tsx            # User approval prompts
├── orchestrator/             # Workflow logic
│   ├── orchestrator.ts       # Main loop
│   ├── planner.ts            # Claude API integration
│   ├── implementer.ts        # Local model integration
│   ├── validator.ts          # tsc/lint/test pipeline
│   └── escalator.ts          # Escalation to Opus
├── spec/                     # Spec parsing & formatting
│   ├── parser.ts             # tasks.md → Task[]
│   ├── templates.ts          # Prompt templates
│   └── formatter.ts          # Task → prompt for local model
└── utils/                    # Helpers
    ├── process.ts            # Subprocess management
    ├── git.ts                # Git operations
    └── fs.ts                 # File system helpers
```

## Commands

```bash
npm run dev -- start "feature"   # Full workflow with TUI
npm run dev -- spec "feature"    # Spec-only mode
npm run dev -- init              # Create config
npm run dev -- status            # Show workflow state
npm test                         # Run tests
npm run build                    # tsc → dist/
```

## Implementation Order

Follow `specs/001-tiny-spec-core/tasks.md` phases sequentially (Phase 1-9).
Each task marked with `[P]` can run in parallel with others in the same phase.
