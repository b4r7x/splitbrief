## Research Report

### Project Overview

**tiny-spec** is a cost-optimized AI coding orchestrator CLI tool. It uses expensive frontier AI (Claude Code, Codex, etc.) for planning (codebase research, spec writing, task decomposition) and routes implementation to cheap/local models (Ollama, LM Studio, DeepSeek, etc.) via any OpenAI-compatible endpoint. Built with TypeScript + Ink (React for terminals) + Vitest.

### Architecture

**Layers:**
1. **CLI** (`src/cli.ts`) — Commander.js entry point, initializes stores, renders Ink TUI
2. **Stores** (`src/stores/`) — Custom reactive stores via `useSyncExternalStore`, 7 domain stores (config, workflow, overlay, router, error, sessions, skills)
3. **Engine** (`src/engine/`) — Zero React/Ink; orchestrator, planners, implementers, validators
4. **Components** (`src/components/`, `src/screens/`) — Ink/React TUI, reads stores directly
5. **Hooks** (`src/hooks/`) — Ink-dependent lifecycle (workflow, input mode, global keys)

**Data flow:** `CLI → initStores() → render(<App/>) → useWorkflow() → runWorkflow() → events → workflowStore → React re-render`

**Key patterns:**
- External stores (not Context) for shared state, selectors for granular subscriptions
- Finite state machine (`src/core/state.ts`) drives all phase transitions
- Plugin backends for planners and implementers via factory functions
- Event-driven orchestration: engine emits `TuiEvent`, UI consumes

### Relevant Code

| File | Relevance |
|------|-----------|
| `src/core/types/events.ts` | `TuiEvent` union — all orchestrator-to-UI events |
| `src/core/types/config.ts` | `Config` shape — all runtime configuration |
| `src/core/types/ui.ts` | `Screen`, `OverlayType`, `InputMode`, `SlashCommandDef` |
| `src/stores/create-store.ts` | Store factory pattern (get/set/subscribe/use) |
| `src/stores/workflow.ts` | Workflow state (events, phase, tasks) |
| `src/core/commands.ts` | Slash command definitions and execution |
| `src/engine/orchestrator/index.ts` | `runWorkflow()` — main orchestration loop |
| `src/engine/orchestrator/types.ts` | `WorkflowContext` bundle |
| `src/engine/planners/factory.ts` | Planner backend selection |
| `src/engine/planners/types.ts` | `PlannerBackend` interface |
| `src/engine/implementers/types.ts` | `ImplementerBackend` interface |
| `src/hooks/use-workflow.ts` | Engine-to-React bridge |
| `src/components/settings-overlay.tsx` | Reference component pattern |

### Patterns to Follow

**Stores:**
```typescript
const store = createStore<State>(initial);
export const myStore = { ...storeBase(store), customMethod: () => store.set(s => ({ ...s })) };
// In components: myStore.use(s => s.field)
// Outside React: myStore.get()
```

**Components:** Functional, no `useMemo`/`useCallback`/`React.memo`, colors from `src/ui/theme.tsx` only, `Box`/`Text` from Ink.

**Tests:** Vitest with explicit imports (`import { describe, it, expect } from 'vitest'`), colocated `foo.test.ts` next to `foo.ts`, no globals.

**Imports:** Always `.js` extension (`'./config.js'`), ESM only.

**State updates:** Immutable spread (`{ ...state, field: newValue }`), never mutate in place.

**Error handling:** Propagate from internals, callers decide — only validate at system boundaries.

### Dependencies & Constraints

- **Node.js 22+**, **TypeScript strict mode**, **ESM only**
- `tsx` for dev execution (handles TSX/JSX without loaders)
- Ink 6.8 + React 19 for TUI — no DOM APIs
- Zero hardcoded hex colors outside `src/ui/theme.tsx`
- Zero React/Ink imports in `src/engine/`
- `store.set()` / `store.load()` must NOT be called during React render
- Commands receive `CommandContext` and must declare valid `screens`

### Implementation Considerations

The feature request "test" is ambiguous. Based on the codebase, the most likely interpretations:

1. **Test generation** — planner writes tests as part of spec; implementer implements them
2. **Test execution enhancement** — extend `src/engine/validator.ts` validation pipeline
3. **New test infrastructure** — add testing helpers or fixtures
4. **A feature named "test"** — the literal word as a tiny feature for prototyping

The validation pipeline already exists at `src/engine/validator.ts` (runs `tsc → lint → tests`). The planner can already generate test tasks. The biggest gap would be test *generation* as an explicit workflow phase or a dedicated `/test` slash command.

---

The feature request "test" is too vague to research precisely. Could you clarify what you mean?

<!-- Q:{"id":"feature_intent","type":"choice","text":"What does 'test' refer to as a feature?","options":["A test/prototype workflow (the word 'test' is a placeholder feature name to try the tool)","Add test generation capabilities (planner explicitly writes tests)","Enhance the validation/test pipeline (tsc/lint/test runner)","Add a /test slash command","Something else — I'll explain in the next question"],"default":0} -->

<!-- Q:{"id":"feature_scope","type":"input","text":"If 'something else', describe what you want to build:","default":"e.g., integrate Jest watch mode into workflow"} -->