# Layers: `utils/` vs `lib/` vs `core/` vs `engine/` vs `features/`

Per-layer reference. For the **decision tree** ("where does this file go?"), see [`STRUCTURE.md` §File placement decision tree](./STRUCTURE.md#file-placement-decision-tree). This doc answers the follow-up question: **once I know the layer, what exactly lives there and what does not?**

Companion to [`STRUCTURE.md`](./STRUCTURE.md) (file tree, feature anatomy) and [`NO-BARRELS.md`](./NO-BARRELS.md) (barrel policy).

---

## Layer summary

| Layer | Role | Imports from | Imported by |
|---|---|---|---|
| `src/utils/` | Generic primitives — pure, stateless, zero domain | Node stdlib, npm, other `utils/` | anyone |
| `src/lib/` | Infrastructure wrappers — single-purpose adapters for Node/terminal/external libs | Node stdlib, npm, `utils/`, other `lib/` | anyone except `utils/` |
| `src/core/` | Domain logic — knows SPLITBRIEF concepts (config, state machine, paths, types, formatting of cost/tokens) | `utils/`, `lib/`, `core/` siblings | `engine/`, `stores/`, `features/` |
| `src/engine/` | Workflow orchestrator — runs planners, implementers, validation. Zero React/Ink | `utils/`, `lib/`, `core/`, `engine/` siblings | `cli/`, `app/`, `features/workflow/`, `features/runners/` |
| `src/stores/` | External state stores — the only cross-cutting channel between engine and UI | `utils/`, `core/`, `lib/`, `engine/` (type-only) | anyone |
| `src/features/{f}/` | Vertical business slices — screens, feature-local hooks, components | everything below + shared `components/`, `hooks/` | only the `app/` shell (pages in `app/screens\|overlays` + `app/router.tsx`) |

Import direction is one-way, top to bottom. For the cross-check table and blockers, see [`STRUCTURE.md` §File placement decision tree](./STRUCTURE.md#file-placement-decision-tree).

---

## `utils/` — generic primitives

**Purpose.** Pure, stateless, framework-agnostic helpers that could be npm-published in isolation. The leaf of the import graph.

**Acceptance criteria:**
- No imports from `core/`, `engine/`, `stores/`, `features/`, `components/`, `hooks/`, or `lib/`
- No SPLITBRIEF string literals (`.splitbrief`, `claude-code`, `ollama`, `cost`, `planner`, `workflow`, etc.)
- Pure function or small stateless module — you could publish it to npm under a different name without touching the code
- Reusable across unrelated projects

**What lives here (`src/utils/`):**
- `type-guards.ts` — `assertNever`, `isRecord`, `typedEntries`
- `error.ts` / `format-errors.ts` — `error(kind, msg, …)` factory + `toErrorMessage(unknown)` → string
- `redact.ts` — strip API keys from strings
- `truncate.ts` — `truncateByChars`, `truncateByLines`, `truncateWithEllipsis`
- `format-time.ts` — `formatDuration`, `formatTime`, `formatTimeHHMMSS`, `formatEta`
- `with-timeout.ts` — wrap a promise with a timeout
- `frontmatter.ts` — generic YAML frontmatter parser
- `diff.ts` — LCS diff algorithm

**Prohibited imports:** `core/`, `engine/`, `stores/`, `features/`, `components/`, `hooks/`, `lib/`, `cli/`.

**Red flags that something does not belong in `utils/`:**
- Contains a string literal that names a SPLITBRIEF tool, provider, or internal path
- Imports `node:child_process`, `simple-git`, `better-sqlite3`, or wraps a specific binary — that's `lib/`
- Has `process.exit` or hardcoded exit codes — that's feature-level
- Depends on a specific file-system layout (`.splitbrief/sessions/` etc.) — that's `core/`

**Pure validators live in `utils/`, even when a related error kind lives in `lib/`:**

`validateSafeIdentifier` (`src/utils/validate-identifier.ts`) is a pure string check — no `..`, no `/`, no `\`, non-empty. It has zero I/O, zero Node API, and takes/returns plain data: `(id: string) => { ok: true } | { ok: false; reason: string }`. That's the `utils/` contract.

The matching `fsError.invalidId` factory stays in `src/lib/fs.ts` because it is a filesystem-domain error — it describes a rejection surfaced at a fs boundary. Callers compose the two: validate with `utils`, throw the `lib` error on failure.

```ts
// src/core/paths-io.ts
const result = validateSafeIdentifier(filename);
if (!result.ok) throw fsError.invalidId('filename', filename, result.reason);
```

Moral: validators (pure) split from error factories (domain). If a "validator" also throws, it is not a validator — it is an assertion helper, and the domain of the assertion decides its home.

---

## `lib/` — infrastructure wrappers

**Purpose.** Single-responsibility adapters around Node stdlib, npm packages, or terminal protocols. Infra the codebase needs but does not speak SPLITBRIEF.

**Acceptance criteria:**
- Wraps a single external system (Node stdlib, npm package, terminal protocol)
- Does not know about SPLITBRIEF concepts — the wrapper is generic, the caller supplies context
- May have state (caches, registries) but not SPLITBRIEF-specific state
- Survives without the rest of the codebase (the wrapper is reusable)

**What lives here:**
- `lib/git/` — `simple-git` boundary in `client.ts` (commit, diff, status helpers in sibling modules)
- `lib/fs.ts` — security-aware filesystem helpers (`ensureSecureDir`, `writeSecureFile`)
- `lib/warn.ts` — `stderr` formatter
- `lib/process/` — subprocess lifecycle (`spawn`, `errors`, `registry`, `line-buffer`)
- `lib/terminal/` — terminal I/O (`mouse` events, `kitty-keyboard` protocol)

**Prohibited imports:** `core/`, `engine/`, `stores/`, `features/`, `components/`, `hooks/`, `cli/`. `lib/` may import other `lib/` siblings and `utils/`.

**Why `lib/` is not `utils/`:** these modules depend on Node APIs, external packages, or protocol specifics. They are reusable, but not as drop-in primitives. `utils/` is for things you could copy-paste into any TypeScript project; `lib/` is for things that only make sense in a Node + terminal context.

**Why `lib/` is not `core/`:** these modules don't know anything about SPLITBRIEF. A workflow runner, a `.splitbrief/` session store, a cost calculation — all domain. A git-commit wrapper, a process spawner, a terminal mouse parser — all infrastructure. Swap `simple-git` for another implementation, `lib/git/client.ts` changes; `core/` doesn't.

**Nesting rule:** create a sub-folder under `lib/` only when you have ≥3 closely-coupled files for a single subsystem (`lib/process/` has `spawn`, `errors`, `registry`, `line-buffer`). Git helpers live under `lib/git/` (`client.ts` owns the `simple-git` boundary).

**Single-source rules for wrapped subsystems:**
- **No `simple-git` imports outside `src/lib/git/client.ts`** (and colocated test files). Every git operation routes through named exports under `lib/git/`. Engine, core, and features import named helpers only.
- `lib/git/client.ts` contains no orchestrator convention knowledge. Staging is explicit: `commitChanges(dir, msg)` commits the current index; callers call `stageAll(dir)` first when they mean "stage everything then commit". Convenience coupling ("commit auto-stages") belongs in the caller, not the wrapper.
- **`ensureGitignore` lives in `lib/fs.ts`, not `lib/git/`.** It uses only `node:fs` (no `simple-git` call) — placement follows runtime dependency, not subject matter.

**Good / bad examples:**

```ts
// GOOD — lib/git/client.ts: pure simple-git boundary
export async function commitChanges(dir: string, message: string) { ... }

// BAD — lib/git/client.ts knowing a workflow naming convention
export async function commitTaskResult(taskId: TaskId) { ... }
//     ^ TaskId is a core/ concept; this belongs in engine/
```

---

## `core/` — domain logic (no React, no orchestration)

**Purpose.** Describes SPLITBRIEF: config shape, state machine, paths, sessions, cost/token math. UI-agnostic and orchestration-agnostic.

**Acceptance criteria:**
- Knows SPLITBRIEF concepts: config shape, workflow state machine, task entities, cost/token math, session metadata, path conventions
- No React, no Ink, no DOM — pure TypeScript
- No workflow orchestration — `core/` does not run planners, implementers, retries, or commits (that's `engine/`). The one sanctioned subprocess in `core/` is the read-only readiness baseline probe (`core/readiness/checks/validation.ts` runs the configured typecheck/lint/test commands via `lib/process/spawn/run-command.ts` to detect a pre-broken tree before any task starts); it spawns nothing else
- Domain persistence is allowed: `core/` writes its own state to disk (sessions, stats, state machine, config, evidence ledger). It prefers the secure `lib/fs.ts` / `lib/confined-fs.ts` helpers (`writeSecureFile`, `readJsonSafe`, `ensureSecureDir`, confined writes) and `lib/file-lock.ts` for whole-file payloads (e.g. `evidence/ledger-storage.ts`), but also writes directly with raw `node:fs` for appends, lockfiles, and atomic renames (e.g. `sessions/tree/io.ts`, `sessions/compaction.ts`, `migration/executor.ts`) — always with inline secure-mode (`SECURE_FILE_MODE`, `0o700`) and symlink/confinement guards
- Typed data structures, pure transformations, and schema validation live here

**What lives here:**
- `core/config/` — YAML config loading, validation, migration
- `core/schemas/` — Zod schemas + their inferred TS types (the source of truth for `Config`, `Task`, `WorkflowState`, `Session`, token/summary shapes, etc.)
- `core/types/` — cross-cutting TS-only types that have no runtime schema (`StateAction`, `TokenBudget`, `ProjectContext`, `WorkflowOpts`, etc.). `z.infer` is forbidden here — inferred types live in `core/schemas/`. See [`docs/TYPES.md`](./TYPES.md).
- `core/state/` — workflow state machine, transitions, persistence shape
- `core/sessions/` — session metadata, analytics, ID generation
- `core/formatting.ts` — LLM-specific formatters (`formatCost`, `formatContextLength`)
- `core/paths.ts`, `core/paths-io.ts` — `.splitbrief/` path derivation and validation
- `core/runtime/commands/` — runtime command definitions (pure data + handlers; see also `core/keybindings/`)
- `core/providers/` — provider catalog, known-models, model-selection logic
- `core/hooks/` — workflow hook config validation + sha256 trust hashing (`trust.ts`)
- `core/tokens/` — pure token accounting helpers (`estimate.ts`) used by the repo-map budget and the planner base

**Prohibited imports:** `engine/`, `stores/`, `features/`, `components/`, `hooks/`, `cli/`. `core/` may import `utils/`, `lib/`, and other `core/` siblings.

**Why `core/` is not `engine/`:** `engine/` runs the workflow (spawns agent subprocesses, streams tokens, retries tasks). `core/` describes it — the types, the transitions, the derived formatters — and persists its own domain state (sessions, stats, state machine, config, evidence ledger), preferring the secure `lib/fs.ts` / `lib/confined-fs.ts` helpers but also writing directly via raw `node:fs` (with inline secure-mode and symlink guards) where it needs appends, lockfiles, or atomic renames. It never runs the workflow loop; its only subprocess is the read-only readiness baseline probe (`core/readiness/checks/validation.ts`) that runs the configured validation commands to flag a pre-broken tree. You could delete `engine/` and rewrite it in a different runtime; `core/` stays.

**Why `core/` is not `features/`:** `core/` is UI-agnostic domain logic. A feature uses it, but the same logic could drive a CLI-only mode, a JSON output mode, or a different TUI framework. Coupling domain to one UI is how codebases die.

---

## `engine/` — workflow orchestration

**Purpose.** Runs the workflow loop: planners, implementers, validation, retry, escalation, commits. Side-effectful and stateful.

**Acceptance criteria:**
- Zero imports from React, Ink, `src/components/`, `src/hooks/`, `src/features/`
- Owns the workflow loop: planners, implementers, validation, retry, escalation, commits
- Emits `EngineEvent` values through the `EventBus`; sinks fan out to the workflow store (for the UI), JSONL log, session-tree log, stdout NDJSON, OTel, and hooks. Engine never calls React directly.
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
- `engine/skill-discovery.ts` — planner skill source discovery
- `engine/availability.ts` — command availability probing
- `engine/error-hints.ts` — engine-scoped error diagnosis (provider hints, etc.)
- `engine/events/` — event bus subsystem: `schema.ts` (`EngineEventSchema` type-dispatched schema + `parseEngineEvent`), `types.ts` (the `EngineEvent` alias inferred from that schema, plus the `EventBus`/`EventSink` ports), `bus.ts` (`createEventBus()` factory with crash isolation per sink), and `sinks/` holding headless/persistence/telemetry subscribers:
  - `features/workflow/tui-sink.ts` — pass-through sink forwarding `EngineEvent` to `workflow/actions/event.addEvent` (workflow sub-stores consume `EngineEvent` directly)
  - `sinks/jsonl.ts` — appends every event to `.splitbrief/sessions/<id>/session.jsonl` via `appendEngineEvent`
  - `sinks/tree-recorder.ts` — always-on sink appending `.splitbrief/sessions/<id>/session-tree.jsonl` and `tree-meta.json`
  - `sinks/stdout-json.ts` — public NDJSON emitter for `splitbrief start --json` / headless mode (`event` envelope plus bounded/redacted payload policy)
  - `sinks/otel.ts` — optional OpenTelemetry span emitter (workflow → phase → task span tree)
- `engine/hooks/` — workflow hook runtime: `dispatch.ts` (subprocess `command` hooks; inserts a `--` end-of-options guard before any arg whose leading characters come from an interpolated `${event.*}` value, so untrusted event fields cannot inject flags into the trusted command's argv), `load-module.ts` (in-process `module` hooks), `substitute.ts` (safe `${event.*}` regex substitution — values are emitted verbatim as distinct argv elements, never shell-evaluated), `run-pre.ts` (sequential `pre_*` runner with deny short-circuit), `sink.ts` (bus sink for `post_*`/`on_*` fire-and-forget), `types.ts`, `builtins/` (`prettier-on-change`, `block-secrets`, `registry.ts`)
- `engine/codebase/` — repo-map pipeline (`parse`, `cache`, `graph`, `pagerank`, `format`, `budget`, `rebuild`, `extract-mentioned-filenames`, `repomap.ts` entry, `types.ts`) — produces the token-budgeted codebase summary injected into the planner prompt. See [REPOMAP.md](./REPOMAP.md).

**Prohibited imports:** `features/`, `components/`, `hooks/`, `cli/`, `react`, `ink`. Grep gate in [`INVARIANTS.md`](./INVARIANTS.md).

---

## `stores/` — external state

See [`STORES.md`](./STORES.md) for full architecture. In layer terms: stores are the sanctioned cross-boundary channel between `engine/` (writes) and `features/` (reads). They depend on `utils/`, `core/`, and optionally `lib/`. They never import React (only `use-stores.ts` consumers do, and those are hook-level).

Stores may import engine **types only** (`import type`) — `EngineEvent` from `engine/events/types.ts` and the detection service types from `engine/detection/service.ts`. No engine values cross into `stores/`.

---

## `components/` and `hooks/` — shared UI

**Purpose.** Cross-feature React code (used by ≥2 features, or a UI primitive that will be).

Top-level `src/components/` and `src/hooks/` hold:
- A component used by ≥2 features → `src/components/`
- A hook used by ≥2 features or a UI primitive → `src/hooks/`

Single-feature code stays under `src/features/{f}/`. See [`STRUCTURE.md`](./STRUCTURE.md).

Sectioned picker display belongs to the picker display-window stack: `src/components/pickers/scroll-window.ts` computes header/gap/item slots, and `src/components/pickers/list-viewport.tsx` renders them.

### Promoting a shared component — the 2-consumer rule

A component earns its place in `src/components/` only when a **second** feature imports it. The first feature keeps it locally; the second consumer triggers the promotion.

**Canonical promotion — `SessionRow`:** originally lived at `src/features/sessions/session-row.tsx` while only `src/app/overlays/sessions.tsx` consumed it. When `features/home/components/recent-sessions.tsx` added a second consumer, the file moved to `src/components/session-row.tsx` (a cross-feature import would otherwise have been required).

### Demoting a misplaced shared component — the 1-consumer reversal

If a file in `src/components/` turns out to have a single feature consumer, demote it back into that feature. Pretending shared ownership when none exists is a lie.

**Canonical demotions (Batch 1B):**

| File (old home in `components/`) | Real consumer | New home |
|---|---|---|
| `components/overlays/mode-selector.tsx` | `app/router.tsx` overlay switch (`renderOverlay`); writes to `configStore.workflow.mode` (settings domain) | `features/settings/mode-selector.tsx` |
| `components/composer/feedback-row.tsx` | `src/app/screens/workflow.tsx`; reads `abortStore` (workflow domain) | `features/workflow/components/feedback-row.tsx` |

The demotions cost one import-path rewrite each; the benefit is that `src/components/` stops advertising false sharing.

---

## `features/` — vertical business slices

**Purpose.** One folder per business concept. Contains the feature's screen/overlay/picker entry + its components + its hooks + its pure helpers.

**Features do not import from each other.** The only cross-cutting channel is stores. See [`STRUCTURE.md` §Cross-feature rule](./STRUCTURE.md#cross-feature-rule).

**Prohibited imports:** other `features/` siblings. The callback-composition-at-the-`app/`-shell pattern (router supplies the render-prop) covers the "feature A renders UI owned by feature B" case.

---

## Anti-patterns

| Symptom | Problem | Fix |
|---|---|---|
| `utils/foo.ts` imports from `core/types/...` | `utils/` is supposed to be a leaf | Move `foo.ts` to `core/` or `lib/` |
| `lib/bar.ts` contains `"claude-code"` | Infra wrapper knows domain | Extract the domain part to `core/` or `engine/` |
| `core/baz.ts` imports from `engine/` | Wrong direction | Invert: `engine/` should depend on `core/`, not the other way |
| `features/A/x.ts` imports from `features/B/y.ts` | Features must be independent | Promote the shared code to `core/`, `stores/`, `components/`, or `hooks/` |
| `src/engine/**` importing from `src/features/**` | Engine must be UI-agnostic | Resolved 2026-04-19 via event bus (bridge sink deleted — zero engine→features imports remain) — see [ARCHITECTURE.md §Design decisions](./ARCHITECTURE.md#design-decisions--why-eventbus) |
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

- [`STRUCTURE.md` §File placement decision tree](./STRUCTURE.md#file-placement-decision-tree) — the canonical "where does this file go?" flow
- [`PRINCIPLES.md`](./PRINCIPLES.md) — one-page index of all architectural rules
- [`STRUCTURE.md`](./STRUCTURE.md) — file tree, feature anatomy, placement rules, folder colocation
- [`TYPES.md`](./TYPES.md) — type placement, Zod schema conventions
- [`STORES.md`](./STORES.md) — state architecture
- [`NO-BARRELS.md`](./NO-BARRELS.md) — why `index.ts` re-exports are banned
- [`FUTURE.md`](./FUTURE.md) — deferred features (not yet built)
