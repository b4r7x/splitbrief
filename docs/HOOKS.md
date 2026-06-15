# Hook Architecture

> **This document is about React hooks.** It is not the same as the workflow lifecycle hook system (user-declared `pre_task` / `post_commit` / etc. commands fired on engine events). For that, see [`docs/HOOKS-CONFIG.md`](./HOOKS-CONFIG.md). The two concepts share the word "hook" and nothing else.

diptych organizes React hooks by the **scope of consumption**, not by "what kind of hook it is". The same principle that shapes [`docs/STORES.md`](./STORES.md) and [`docs/NO-BARRELS.md`](./NO-BARRELS.md) applies here: put code where its consumers live, avoid flat dumping grounds, avoid fake hooks.

## Principle

> **If a hook is consumed by a single feature → it lives in that feature. If it is consumed across features or is a UI primitive → it lives in `src/hooks/`.**

This is the same rule [bulletproof-react](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) applies, and it is a direct consequence of the colocation principle: code that changes together lives together.

## Placement decision

| Situation | Location |
|---|---|
| Hook used by one feature only | `src/features/{feature}/hooks/` |
| Hook used by 2+ features | `src/hooks/` (shared) |
| Hook that is a UI primitive (filterable list, async highlight, fixed-item selector) | `src/hooks/` (shared) |
| Module named `use-*` that has no React dependency (pure function disguised as a hook) | Not a hook. Move to `src/utils/`, `src/core/`, or the feature that owns it. |
| State that needs to cross multiple components or survive unmounts | Not a hook. Use a store (`src/stores/`). See [`STORES.md`](./STORES.md). |

**Single-consumer hooks colocated with their component are acceptable** when the hook's sole job is to decompose that component's internals (e.g. `src/features/runners/two-column-picker/use-nav-state.ts`). They are private implementation details of the component, not part of any public surface.

## Shallow-hook policy

A module deserves the `use-` prefix only when it has at least one of:

- **Real React lifecycle** — uses `useState`, `useEffect`, `useRef`, `useContext`, `useReducer`, `useEffectEvent`, or the equivalent.
- **Multi-consumer abstraction** sharing a non-trivial pattern (e.g. a cancellation contract, a promise-based resolver, a keyboard handler).

Modules that only rename fields, flatten other hooks' return shapes, or carry no React-ness at all are **not hooks**. Convert them to plain functions and put them next to the domain they serve (usually the feature root, `src/utils/`, or `src/core/`).

The single-consumer gate matters too: a hook used by exactly one caller with no React state has zero abstraction power — inline it. Dissolved examples: `use-workflow.ts` (facade flattening three hook returns), `use-workflow-review-input.ts` (75 LOC with zero React lifecycle, replaced by `createReviewInputHandler`).

## Inventory

### Shared (`src/hooks/`)

Cross-feature primitives only. Flat directory — no subfolders, no barrels.

| Hook | Purpose |
|---|---|
| `use-filterable-list.ts` | Filterable, searchable picker state (arrow-nav, filter, selection). Used by every feature-level picker. |
| `use-static-selector.ts` | Fixed-list keyboard selector (no filter). Peer of `use-filterable-list` for simpler cases. |

App-wide keyboard dispatch (`useAppKeys`) lives at `src/app/keys.ts` rather than under `src/hooks/`. It binds to app-shell concerns (`useApp().exit`, the global router, overlay stack, lifecycle abort) and is composed once by `src/app.tsx`, so it sits next to the shell it serves.

### Feature-scoped (`src/features/{feature}/hooks/`)

Hooks whose sole consumer is inside one feature folder. Example from `features/workflow/hooks/`:

| Hook | Purpose |
|---|---|
| `use-runner.ts` | Engine lifecycle, resume, rewind, approval/question prompts. |
| `use-input-mode.ts` | Promise-based modal input (normal/review/question). |
| `use-review-content.ts` | Async file read via `AbortController`-cancelled `fs.readFile` + line-count sync to `reviewStore`. |
| `use-mouse-scroll.ts` | Mouse-wheel binding to conversation/review scroll. |
| `use-cost-stats.ts` | Cost breakdown from tokens + tasks stores, formatted for footer. |
| `use-keys.ts` | Workflow-only keyboard: scroll, review chords, sidebar toggle. Mounted only when `screen === 'workflow'`. |

## Pure helpers that are not hooks

Some files live under a feature because they are the feature's domain logic, even if they carry no React state. Keep them out of `hooks/` subfolders — they do not deserve the `use-` prefix.

Example, `src/features/workflow/`:

| File | Purpose |
|---|---|
| `handlers.ts` | Engine↔UI bridge. Module-scoped handler registry. |
| `keyboard.ts` | Pure keyboard-action dispatchers (workflow-scope). |
| `layout.ts` | Pure geometry snapshots that read from multiple stores. |

Tests live next to each file (`handlers.test.ts`, `layout.test.ts`). Pure functions are trivial to test — and that is the only reason they have tests.

## Consumption patterns

### Read stores, don't wrap them

```ts
// ✅ Good — component reads directly from stores
import { configStore } from '../../stores/project/config.js';
const config = configStore.useConfig();
```

```ts
// ❌ Bad — thin wrapper hook adding nothing
export function useConfig() { return configStore.useConfig(); }
```

See [`STORES.md`](./STORES.md) for the full "don't create wrapper hooks around `store.use()`" rule.

### Use `useStores(...)` for multi-store flat reads

```ts
import { useStores } from '../stores/use-stores.js';

const [{ screen }, { active }, { cols }] = useStores(routerStore, overlayStore, terminalSizeStore);
```

### Prefer composition over inheritance of behaviors

When a hook would wrap another hook and add only trivial logic, inline instead. `use-settings-list` existed as a wrapper over `use-filterable-list` that added one space-bar toggle — removed during restructure because the wrapper carried more indirection cost than reuse benefit.

## Anti-patterns

| Don't | Why |
|---|---|
| Create `src/hooks/{feature}/` subfolders | That is a feature. Move the hook to `src/features/{feature}/hooks/`. |
| Put pure functions under `src/hooks/` | The `use-` prefix is a promise — if it has no React lifecycle, it is not a hook. |
| Wrap a store's `.use()` in a single-call hook | Consumers should call the store directly. |
| Wrap another hook in a thin hook that adds ≤5 lines | Inline. If the wrapper carries only one transformation, it is not earning its keep. |
| Write tests that assert "hook calls `useState` internally" | Tests should assert observable behavior. Internal hook calls are implementation details. See [`test-behavior-not-implementation`](../CLAUDE.md). |
| Create a `use-*` hook to hold state that should cross components | Use a store. Hooks for per-component or per-subtree lifecycle; stores for cross-tree shared state. |
| Add a barrel (`hooks/index.ts`) | Forbidden project-wide. See [`NO-BARRELS.md`](./NO-BARRELS.md). |

## Rules of thumb

1. **Trivial hooks do not need direct tests.** A 20-LOC hook with no branching that wraps an Ink API is covered transitively through its consumer's integration test. Writing a direct test for it asserts implementation.
2. **Behavior lives in the hook, not the pure helper.** If you split a hook into `use-foo.ts` + `foo-helpers.ts`, the hook orchestrates, the helpers stay pure. Test the pure helpers directly; test the hook at the behavior level.
3. **Hooks do not import from other features.** `features/home/hooks/*` must not import from `features/workflow/*`. Cross-feature needs go through a shared hook in `src/hooks/` or a store.
4. **One `useInput` per concern.** Splitting `use-global-keys` into `useAppKeys` (now at `src/app/keys.ts`) + `use-keys` was a direct application of this: global keybindings stay always-on, workflow keybindings mount conditionally under `screen === 'workflow'`.
5. **Prefer `AbortController` over ad-hoc `cancelled` flags for async cancellation.** When a hook races a promise against unmount, use `new AbortController()` + `controller.signal` and return `() => controller.abort()` from the effect. Node's `fs.readFile`, `fetch`, and most async APIs accept `{ signal }` natively. Closure booleans (`let cancelled = false`) work but signal the wrong intent — `AbortController.abort()` is self-documenting and the Node-native SOTA. Canonical example: `use-review-content.ts`.

## Design decisions

**Why not a deep taxonomy inside `src/hooks/`?**
Once the shared directory only contains hooks used across ≥2 features, the count drops to single digits (2 today). A taxonomy over two files is pure ceremony.

**Why keep `use-filterable-list` shared when it powers feature-level pickers?**
It is a keyboard/filter primitive, not a business hook. Every feature picker composes it — the primitive has its own lifecycle independent of any feature.

**Why split `use-global-keys` into `useAppKeys` (`src/app/keys.ts`) + `use-keys` (`src/features/workflow/hooks/use-keys.ts`)?**
Three reasons: (1) `use-keys` reads from workflow-scoped stores (`conversationScrollStore`, `reviewStore`, `lifecycleStore`) and belongs in the workflow feature; (2) mounting the workflow listeners only on the workflow screen eliminates edge cases where a workflow chord fires on the home screen; (3) feature-local keyboard logic is discoverable from the feature folder, not from a 130-LOC shared hook with 9 store dependencies. `useAppKeys` lives next to `src/app.tsx` because its concerns are app-shell concerns (exit, overlay stack, lifecycle abort).

**Why not put `keyboard.ts` under `features/workflow/hooks/`?**
It is a pure function, not a hook. Hooks imply React lifecycle. Keeping pure helpers at the feature root (`features/workflow/keyboard.ts`) signals "this is feature logic, consumable by both React and non-React code".

## References

- [`STRUCTURE.md`](./STRUCTURE.md) — companion doc on folder organization; defines the feature layout this hook doc lives inside.
- [`STORES.md`](./STORES.md) — companion doc on state architecture; the same colocation principle motivates both.
- [`NO-BARRELS.md`](./NO-BARRELS.md) — no `index.ts` re-exporters anywhere in `src/` except where the file is the real implementation.
- [bulletproof-react — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — source of the "shared vs feature-scoped" rule.
- [React docs — Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks) — official guidance on when to extract.
