# Layers: `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/`

When you add a new module, ask: **what kind of code is this?** The answer tells you which top-level folder it belongs in. Get this wrong and the import graph rots — pure helpers start knowing about `.diptych/`, infrastructure wrappers start depending on features, and the codebase becomes hard to reason about.

This document is the decision authority. Companion to [`STRUCTURE.md`](./STRUCTURE.md) (which documents the file tree) and [`NO-BARRELS.md`](./NO-BARRELS.md) (which bans re-export indirection).

---

## The five layers

| Layer | Role | Imports from | Imported by |
|---|---|---|---|
| `src/utils/` | Generic primitives — pure, stateless, zero domain | Node stdlib, npm, other `utils/` | anyone |
| `src/lib/` | Infrastructure wrappers — single-purpose adapters for Node/terminal/external libs | Node stdlib, npm, `utils/`, other `lib/` | anyone except `utils/` |
| `src/core/` | Domain logic — knows tiny-spec concepts (config, state machine, paths, types, formatting of cost/tokens) | `utils/`, `lib/`, `core/` siblings | `engine/`, `stores/`, `features/` |
| `src/engine/` | Workflow orchestrator — runs planners, implementers, validation. Zero React/Ink | `utils/`, `lib/`, `core/`, `engine/` siblings | `cli/`, `features/workflow/` |
| `src/stores/` | External state stores — the only cross-cutting channel between engine and UI | `utils/`, `core/`, `lib/` | anyone |
| `src/features/{f}/` | Vertical business slices — screens, feature-local hooks, components | everything below + shared `components/`, `hooks/` | only `app.tsx` |

**Import direction is one-way, top to bottom.** Violations are blockers:
- ❌ `utils/` importing from `core/` — breaks the "leaf primitive" contract
- ❌ `lib/` importing from `engine/` — infra must not know about workflow
- ❌ `core/` importing from `features/` — domain must not know about UI
- ❌ `features/A` importing from `features/B` — features are independent

---

## Decision tree: where does this code go?

```
Does the code import React/Ink?
├── YES → `src/components/`, `src/hooks/`, or `src/features/{f}/`
└── NO ↓

Does the code know about tiny-spec concepts
(`.diptych/`, cost $, tokens K/M, workflow phases,
Ollama, Claude Code, LLM providers, etc.)?
├── YES ↓
│   Is it workflow orchestration (planner, implementer, validation)?
│   ├── YES → `src/engine/`
│   └── NO  → `src/core/`
└── NO ↓

Is it a wrapper around an external system
(git, filesystem, node:child_process, terminal I/O, Shiki, simple-git)?
├── YES → `src/lib/`
└── NO  → `src/utils/`  (pure primitive, npm-publishable in isolation)
```

---

## `utils/` — generic primitives

**Acceptance criteria:**
- No imports from `core/`, `engine/`, `stores/`, `features/`, `components/`, `hooks/`, or `lib/`
- No tiny-spec string literals (`.diptych`, `claude-code`, `ollama`, `cost`, `planner`, `workflow`, etc.)
- Pure function or small stateless module — you could publish it to npm under a different name without touching the code
- Reusable across unrelated projects

**Examples of what lives here:**
- `type-guards.ts` — `assertNever`, `isRecord`, `typedEntries`
- `format-errors.ts` — `toErrorMessage(unknown)` → string
- `redact.ts` — strip API keys from strings
- `truncate.ts` — `truncateByChars`, `truncateByLines`, `truncateWithEllipsis`
- `format-time.ts` — `formatDuration`, `formatTime`, `formatTimeHHMMSS`, `formatEta`
- `with-timeout.ts` — wrap a promise with a timeout
- `frontmatter.ts` — generic YAML frontmatter parser
- `sectioned-list.ts` — group a flat list into sections
- `diff.ts` — LCS diff algorithm

**Red flags that something doesn't belong in `utils/`:**
- Contains a string literal that names a tiny-spec tool, provider, or internal path
- Imports `node:child_process`, `simple-git`, `shiki`, or wraps a specific binary — that's `lib/`
- Has `process.exit` or hardcoded exit codes — that's feature-level
- Depends on a specific file-system layout (`.diptych/sessions/` etc.) — that's `core/`

---

## `lib/` — infrastructure wrappers

**Acceptance criteria:**
- Wraps a single external system (Node stdlib, npm package, terminal protocol)
- Does not know about tiny-spec concepts — the wrapper is generic, the caller supplies context
- May have state (caches, registries) but not tiny-spec-specific state
- Survives without the rest of the codebase (the wrapper is reusable)

**What lives here:**
- `lib/git.ts` — `simple-git` wrapper (commit, diff, status)
- `lib/fs.ts` — security-aware filesystem helpers (`ensureSecureDir`, `writeSecureFile`)
- `lib/highlight.ts` — Shiki syntax highlighting wrapper
- `lib/warn.ts` — `stderr` formatter
- `lib/availability.ts` — command availability probing
- `lib/process/` — subprocess lifecycle (`spawn`, `errors`, `registry`, `line-buffer`)
- `lib/terminal/` — terminal I/O (`mouse` events, `kitty-keyboard` protocol)

**Why `lib/` is not `utils/`:** these modules depend on Node APIs, external packages, or protocol specifics. They are reusable, but not as drop-in primitives. `utils/` is for things you could copy-paste into any TypeScript project; `lib/` is for things that only make sense in a Node + terminal context.

**Why `lib/` is not `core/`:** these modules don't know anything about tiny-spec. A workflow runner, a `.diptych/` session store, a cost calculation — all domain. A git-commit wrapper, a process spawner, a terminal mouse parser — all infrastructure. Swap `simple-git` for another implementation, `lib/git.ts` changes; `core/` doesn't.

**Nesting rule:** create a sub-folder under `lib/` only when you have ≥3 closely-coupled files for a single subsystem (`lib/process/` has `spawn`, `errors`, `registry`, `line-buffer`). One-file subsystems stay flat (`lib/git.ts`, not `lib/git/git.ts`).

---

## `core/` — domain logic (no React, no orchestration)

**Acceptance criteria:**
- Knows tiny-spec concepts: config shape, workflow state machine, task entities, cost/token math, session metadata, path conventions
- No React, no Ink, no DOM — pure TypeScript
- No subprocess spawning or file-writing side effects (that's `engine/` or `lib/fs.ts`)
- Typed data structures, pure transformations, and schema validation live here

**What lives here:**
- `core/config/` — YAML config loading, validation, migration
- `core/types/` — Zod schemas + type definitions (the source of truth for Config, Task, Session, etc.)
- `core/state/` — workflow state machine, transitions, persistence shape
- `core/sessions/` — session metadata, analytics, ID generation
- `core/formatting.ts` — LLM-specific formatters (`formatCost`, `formatContextLength`)
- `core/layout/` — pure layout/geometry helpers for the TUI (no React, no hooks)
- `core/paths.ts`, `core/paths-io.ts` — `.diptych/` path derivation and validation
- `core/slash-commands/` — command definitions (pure data + handlers)
- `core/providers/` — provider catalog, known-models, model-selection logic

**Why `core/` is not `engine/`:** `engine/` runs the workflow (spawns subprocesses, streams tokens, retries tasks). `core/` just describes it — the types, the transitions, the derived formatters. You could delete `engine/` and rewrite it in a different runtime; `core/` stays.

**Why `core/` is not `features/`:** `core/` is UI-agnostic domain logic. A feature uses it, but the same logic could drive a CLI-only mode, a JSON output mode, or a different TUI framework. Coupling domain to one UI is how codebases die.

---

## `engine/` — workflow orchestration

**Acceptance criteria:**
- Zero imports from React, Ink, `src/components/`, `src/hooks/`, `src/features/`
- Owns the workflow loop: planners, implementers, validation, retry, escalation, commits
- Emits `TuiEvent` events for the UI via stores — never calls React directly
- Side-effectful: spawns subprocesses, streams HTTP, writes files

**What lives here:**
- `engine/orchestrator/` — the main loop and its decomposed modules
- `engine/planners/` — five planner backends (cli, api, shell, agent, agent-sdk)
- `engine/implementers/` — mirror for implementers
- `engine/providers/` — HTTP clients, pricing, streaming
- `engine/spec/` — spec parsing, prompt templates
- `engine/parsers/` — response parsers (question, code extraction)
- `engine/streaming/` — streaming transport layer
- `engine/detection/` — auto-detect installed tools
- `engine/skills/` — skill discovery
- `engine/errors/` — engine-scoped error diagnosis (provider hints, etc.)

---

## `stores/` — external state

See [`STORES.md`](./STORES.md) for full architecture. In layer terms: stores are the sanctioned cross-boundary channel between `engine/` (writes) and `features/` (reads). They depend on `utils/`, `core/`, and optionally `lib/`. They never import React (only `use-stores.ts` consumers do, and those are hook-level).

---

## `components/` and `hooks/`

Top-level `src/components/` and `src/hooks/` hold cross-feature React code:
- A component used by ≥2 features → `src/components/`
- A hook used by ≥2 features or a UI primitive → `src/hooks/`

Single-feature code stays under `src/features/{f}/`. See [`STRUCTURE.md`](./STRUCTURE.md).

---

## `features/` — vertical business slices

One folder per feature. Contains the feature's screen/overlay/picker entry + its components + its hooks + its pure helpers.

**Features do not import from each other.** The only cross-cutting channel is stores.

---

## Worked examples

**Q: I need to format a date as `YYYY-MM-DD`.**
A: Generic, reusable, no domain → `src/utils/` (pick an existing time file or create one).

**Q: I need to format a cost in dollars with a `$` prefix.**
A: LLM-domain (cost is a tiny-spec concept) → `src/core/formatting.ts`.

**Q: I need to parse CLI version output to detect if `git` is installed.**
A: Infrastructure (wraps `node:child_process` to probe an external tool) → `src/lib/availability.ts`.

**Q: I need to write a file at `.diptych/config.yaml` with secure permissions.**
A: The file-write primitive (`writeSecureFile`) is `src/lib/fs.ts`. The path derivation (`getConfigPath`) is `src/core/paths.ts`. The "write the config" operation composes both from `core/config/loading.ts`.

**Q: I need to detect when Ollama returns "model not found" and show a hint.**
A: That's a tiny-spec LLM-domain concern → `src/engine/errors/hints.ts` (close to the engine consumers that call it).

**Q: I need a React hook to debounce user input.**
A: Generic UI primitive → `src/hooks/use-debounce.ts`. If only one feature uses it, it starts inside that feature and gets promoted to shared when a second consumer appears.

**Q: I need to parse a YAML frontmatter block.**
A: Generic → `src/utils/frontmatter.ts`. The fact that it's used for skills discovery is the consumer's business.

**Q: I need a function that returns `true` if a session ID is valid.**
A: Validation against a tiny-spec-defined format → `src/core/sessions/id.ts`.

---

## Anti-patterns

| Symptom | Problem | Fix |
|---|---|---|
| `utils/foo.ts` imports from `core/types/...` | `utils/` is supposed to be a leaf | Move `foo.ts` to `core/` or `lib/` |
| `lib/bar.ts` contains `"claude-code"` | Infra wrapper knows domain | Extract the domain part to `core/` or `engine/` |
| `core/baz.ts` imports from `engine/` | Wrong direction | Invert: `engine/` should depend on `core/`, not the other way |
| `features/A/x.ts` imports from `features/B/y.ts` | Features must be independent | Promote the shared code to `core/`, `stores/`, `components/`, or `hooks/` |
| New `utils/` file with 1 consumer | Not shared yet | Keep it inside the consumer until ≥2 users exist |
| Re-export barrel (`utils/index.ts`) | Indirection with no added value | Delete it — consumers import from source |

---

## References

- [`STRUCTURE.md`](./STRUCTURE.md) — file tree, feature anatomy, placement rules
- [`STORES.md`](./STORES.md) — state architecture
- [`NO-BARRELS.md`](./NO-BARRELS.md) — why `index.ts` re-exports are banned
- [`FUTURE.md`](./FUTURE.md) — deferred features (not yet built)
