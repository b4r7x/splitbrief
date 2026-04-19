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

**Pure validators live in `utils/`, even when a related error kind lives in `lib/`:**

`validateSafeIdentifier` (`src/utils/validate-identifier.ts`) is a pure string check — no `..`, no `/`, no `\`, non-empty. It has zero I/O, zero Node API, and takes/returns plain data: `(id: string) => { ok: true } | { ok: false; reason: string }`. That's the `utils/` contract.

The matching `fsError.invalidId` factory stays in `src/lib/fs.ts` because it is a filesystem-domain error — it describes a rejection surfaced at a fs boundary. Callers compose the two: validate with `utils`, throw the `lib` error on failure.

```ts
// src/core/paths-io.ts
const result = validateSafeIdentifier(filename);
if (!result.ok) throw fsError.invalidId('filename', filename, result.reason);
```

Moral: validators (pure) split from error factories (domain). If a "validator" also throws, it's not a validator — it's an assertion helper, and the domain of the assertion decides its home.

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

**Single-source rules for wrapped subsystems:**
- **No `simple-git` imports outside `src/lib/git.ts`** (and its colocated test file). Every git operation — `commit`, `stash`, `checkout`, `clean`, `tag`, `reset`, `add` — routes through a named export in `lib/git.ts`. Engine, core, and features import named helpers only. See [ADR 0008](./adr/0008-engine-git-boundary.md).
- `lib/git.ts` contains no orchestrator convention knowledge. Staging is explicit: `commitChanges(dir, msg)` commits the current index; callers call `stageAll(dir)` first when they mean "stage everything then commit". Convenience coupling ("commit auto-stages") belongs in the caller, not the wrapper.
- **`ensureGitignore` lives in `lib/fs.ts`, not `lib/git.ts`.** It uses only `node:fs` (no `simple-git` call) — placement follows runtime dependency, not subject matter. See [ADR 0008](./adr/0008-engine-git-boundary.md).

---

## `core/` — domain logic (no React, no orchestration)

**Acceptance criteria:**
- Knows tiny-spec concepts: config shape, workflow state machine, task entities, cost/token math, session metadata, path conventions
- No React, no Ink, no DOM — pure TypeScript
- No subprocess spawning or file-writing side effects (that's `engine/` or `lib/fs.ts`)
- Typed data structures, pure transformations, and schema validation live here

**What lives here:**
- `core/config/` — YAML config loading, validation, migration
- `core/schemas/` — Zod schemas + their inferred TS types (the source of truth for `Config`, `Task`, `WorkflowState`, `Session`, token/summary shapes, etc.)
- `core/types/` — cross-cutting TS-only types that have no runtime schema (`StateAction`, `TokenBudget`, `DetectedModel`, `WorkflowOpts`, etc.). `z.infer` is forbidden here — inferred types live in `core/schemas/`. See `docs/TYPES.md` and ADR 0006.
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

### Promoting a shared component — the 2-consumer rule

A component earns its place in `src/components/` only when a **second** feature imports it. The first feature keeps it locally; the second consumer triggers the promotion.

**Canonical promotion — `SessionRow`:** originally lived at `src/features/sessions/session-row.tsx` while only `features/sessions/picker.tsx` consumed it. When `features/home/components/recent-sessions.tsx` added a second consumer, the file moved to `src/components/session-row.tsx` (a cross-feature import would otherwise have been required).

### Demoting a misplaced shared component — the 1-consumer reversal

If a file in `src/components/` turns out to have a single feature consumer, demote it back into that feature. Pretending shared ownership when none exists is a lie.

**Canonical demotions (Batch 1B):**

| File (old home in `components/`) | Real consumer | New home |
|---|---|---|
| `components/overlays/mode-selector.tsx` | `app.tsx` overlay switch; writes to `configStore.workflow.mode` (settings domain) | `features/settings/mode-selector.tsx` |
| `components/input-bar/feedback-row.tsx` | `features/workflow/screen.tsx`; reads `abortStore` (workflow domain) | `features/workflow/components/feedback-row.tsx` |

The demotions cost one import-path rewrite each; the benefit is that `src/components/` stops advertising false sharing. See ADR [0007](./adr/0007-feature-boundary-enforcement.md).

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

**Q: I need to map `src/foo.ts` to its colocated test file `tests/foo.test.ts`.**
A: Test-discovery heuristics are domain logic (project-layout convention) → belongs in `core/validation/` not `engine/orchestrator/`. Engine composes the resolver at workflow-init time and shares it across task/retry pipelines.

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

## Promoting from `cli/` to `core/` — the 2nd-consumer rule

`src/cli/` holds code that is only ever called from a commander subcommand handler — argument parsing, prep logic for a single command flow, TTY detection, etc. That is a legitimate home when the CLI is the only consumer.

**Promote to `core/` when a second consumer appears — not before.**

### Examples

**Stays in `cli/`** — single CLI consumer:

```
src/cli/setup.ts
  setupWorkflow(opts)          # git check + config presence + fullscreen detect
  resolveProjectDir(dir?)      # resolve --project flag
  ensureGitAndConfig(dir)      # fallback init when config missing
```

Only the CLI subcommands call this. An API server, SDK bootstrap, or programmatic entry point would be a second consumer — at which point `setupWorkflow` promotes to `src/core/config/setup.ts` and the CLI keeps a thin adapter.

**Starts in `core/`** — domain concern, not CLI-specific:

```
src/core/sessions/guards.ts
  clearStaleSession(projectDir)   # session-state predicate + cleanup
```

Session lifecycle is a domain concern. Even though today only `cli/commands/resume.ts` calls it, putting it in `cli/` would mean moving it later when (not if) another code path needs the same predicate. When the producer naturally belongs to a domain, start in that domain.

**Decision heuristic:**

| Situation | Placement |
|---|---|
| Code only makes sense as CLI prep (TTY, commander flags, exit codes) | `cli/` |
| Code describes a domain concept (sessions, migration, config) | `core/` — even with one consumer today |
| Unsure | Start in `cli/`, promote on the second consumer |

### Persistence belongs with the store, not with the CLI

A second placement rule: **bootstrap / persistence logic for a store lives next to the store, not next to its CLI caller.**

The `input-history` store in `src/stores/ui/input-history.ts` holds in-memory state. Its disk I/O (hydrate on startup, debounced save on change) lives in `src/stores/ui/persistence.ts`, **not** in `src/cli/`. `cli/init-stores.ts` calls `installHistoryPersistence()` at boot — the CLI layer triggers the wiring, but the logic is a store concern.

This mirrors the folder-colocation rule in [`STRUCTURE.md`](./STRUCTURE.md#deep-modules-and-folder-colocation): helpers live with the module they support, not with the caller that happens to drive them.

## Ports and adapters

When a file declares a contract (interface, type, base helper) and sibling files implement that contract, **keep the port and its implementations in the same folder**. Do not move the port out to a separate `ports/` or `interfaces/` folder — that is an abstraction without value.

Canonical examples in this codebase:

```
engine/planners/
├── types.ts          # PORT — declares Planner, PlannerBackend, PlannerCapabilities
├── base.ts           # shared scaffolding used by adapters
├── cli.ts            # ADAPTER — Claude Code / Codex / OpenCode subprocess
├── api.ts            # ADAPTER — OpenAI-compatible HTTP
├── shell.ts          # ADAPTER — arbitrary shell command
├── agent.ts          # ADAPTER — file-writing agent
└── agent-sdk.ts      # ADAPTER — Anthropic Agent SDK

engine/implementers/   # mirror of planners/ — same port+adapter pattern
```

`types.ts` in these folders is a port file — it **declares** types, it does not re-export them. It is not a barrel (see [NO-BARRELS.md](./NO-BARRELS.md)).

**Rule**: if you are tempted to create `src/ports/`, `src/interfaces/`, or `src/contracts/`, stop — the interface belongs with its implementations. See [Sandor Dargo's deep-module case for port colocation](https://www.sandordargo.com/blog/2023/01/25/deep-vs-shallow-modules).

## References

- [`PRINCIPLES.md`](./PRINCIPLES.md) — one-page index of all architectural rules.
- [`STRUCTURE.md`](./STRUCTURE.md) — file tree, feature anatomy, placement rules, folder colocation
- [`TYPES.md`](./TYPES.md) — type placement, Zod schema conventions
- [`STORES.md`](./STORES.md) — state architecture
- [`NO-BARRELS.md`](./NO-BARRELS.md) — why `index.ts` re-exports are banned
- [`FUTURE.md`](./FUTURE.md) — deferred features (not yet built)
