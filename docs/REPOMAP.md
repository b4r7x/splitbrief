# Repo-map context

The SPLITBRIEF planner sees a token-budgeted **repo-map** of your project's source on every workflow start. The repo-map gives the planner a structural overview — file paths, top-level signatures, exports — without burning context tokens on file reads. Inspired by [Aider's repomap](https://aider.chat/docs/repomap.html), tuned for a planner that compiles Task Briefs and decides when extra structure is worth paying for.

## Why

Without a repo-map, cheap planners (Ollama, DeepSeek, etc.) miss existing helpers and propose duplicates. Even Claude burns tokens reading files we could have summarized. The repo-map costs ~4000 tokens per workflow and saves orders of magnitude more on `researching` phase reads.

## What it contains

For each file (sorted by [PageRank](#ranking) over the import graph):

```
src/engine/orchestrator/run/workflow.ts:
  export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary>
  export type RunWorkflowOptions = ...

src/core/state/machine.ts:
  export function createInitialState(feature: string): WorkflowState
  export function transition(state: WorkflowState, action: StateAction): WorkflowState
  export type Phase = 'idle' | 'researching' | ...
```

Only signatures (declarations) appear. Bodies elided. Files outside the budget are dropped, lowest-ranked first.

## Configuration

```yaml
# .splitbrief/config.yaml — all fields optional, defaults shown
codebase:
  enabled: true              # set to false to disable
  tokenBudget: 4000          # tokens reserved in the planner prompt
  cacheDir: ".splitbrief"       # where the SQLite cache lives
  include: ["src/**/*"]     # globs (default: discovery walks all known language extensions)
  exclude:                   # regex strings; default excludes test files + node_modules + dist
    - "\\.test\\.tsx?$"
    - "node_modules/"
    - "dist/"
```

Schema: `src/core/schemas/codebase.ts`.

## Ranking

Files are ranked by [PageRank](https://en.wikipedia.org/wiki/PageRank) over the file→file import graph (damping 0.85, max 100 iterations). Edges are directed from importer to imported; edge weight is the number of distinct symbols imported from the target.

### Personalization vector

A personalization vector biases the walk toward files the user already cares about:

- Any entry in `RepoMapOptions.focusFiles` gets a boosted prior.
- The user's feature prompt is scanned for basename mentions (e.g. `auth.ts`, `validation.ts`). Each matched file receives the same boost — so "edit auth.ts and wire it into login" makes `auth.ts` and its import neighborhood rank first.

The personalization mass is normalized against the uniform prior so non-mentioned files still receive signal; this avoids the degenerate case where an unmentioned-but-central file (e.g. `state/machine.ts`) disappears.

Mentioned-file extraction lives in `src/engine/codebase/extract-mentioned-filenames.ts`. The PageRank implementation is in `src/engine/codebase/pagerank.ts` — pure JS, no native deps.

## Cache

Parsed symbols are cached in SQLite at `${projectDir}/.splitbrief/repomap.sqlite` via `better-sqlite3`. One row per file.

### Schema

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  symbols_json TEXT NOT NULL,
  parse_version INTEGER NOT NULL
);
CREATE INDEX idx_mtime ON files (mtime_ms);
```

### Invalidation

On read, `cache.ts` compares the row's `(mtime_ms, size_bytes, parse_version)` to the file on disk and the build-time constant:

- **Hit:** `mtime_ms` and `size_bytes` match the current stat **and** `parse_version` matches the compiled-in constant → deserialize `symbols_json`, skip parse.
- **Miss (file changed):** mtime or size differs → re-parse, upsert the row.
- **Miss (parser changed):** the global `parse_version` constant was bumped (grammar upgrade, capture changes) → every row is stale, the entire cache is rebuilt transparently on next read.

This means grammar bumps don't need manual cleanup, and neither does anything else: every planning run re-reads the cache and re-parses whatever is stale, so there is no manual rebuild step.

Cold parse on a 200-file repo: ~3s on M1. Warm hit: <100ms (mtime check + JSON load). Note: mtime-based invalidation misses the rare content-equal-mtime-different case; the escape hatch is deleting `${projectDir}/.splitbrief/repomap.sqlite` by hand, along with the `-shm` and `-wal` siblings WAL mode leaves beside it — the next planning run parses from scratch.

## Opt-out

```yaml
# .splitbrief/config.yaml
codebase:
  enabled: false
```

The planner runs without the `<repo-map>` block. Use this if you have token-tight planners and prefer to lean on `Read` tool calls instead.

## Implementation

Module: `src/engine/codebase/`. The entry point `repomap.ts` composes a four-step pipeline:

1. **Parse** — `src/engine/codebase/parse.ts` wraps `web-tree-sitter` with language-specific WASM grammars loaded lazily from the `LanguageConfig` registry. For each discovered file it extracts `tags.scm`-equivalent captures (function declarations, classes, types, etc.) according to the language's node types. Unknown languages or missing grammars fall back to filename-only inclusion (empty symbols/imports). Output is `FileNode { symbols, imports, sizeBytes, mtimeMs }`. The parse step is fronted by the cache (see above) — actual tree-sitter work only runs on misses.
2. **Graph build** — `src/engine/codebase/graph.ts` turns the parsed `imports` of each file into a directed file→file graph. Imports are resolved via `tsconfig` `baseUrl`/`paths`; unresolved or external imports are dropped. Edge weight equals the number of symbols imported from the target.
3. **PageRank** — `src/engine/codebase/pagerank.ts` runs PageRank over the graph with a personalization vector built from `focusFiles` and basenames extracted from the user's prompt (see [Ranking](#ranking)).
4. **Budget-aware emit** — `src/engine/codebase/format.ts` and `src/engine/codebase/budget.ts` walk files in descending rank order, emitting one block of signature lines per file. A rolling token estimate (chars / 4) stops emission once `tokenBudget` is exceeded, so files in the ranked tail are dropped first.

Other files:

- `src/engine/codebase/cache.ts` — SQLite-backed parse cache (see [Cache](#cache)).
- `src/engine/codebase/types.ts` — `CodebaseSnapshot`, `SymbolRef`, `FileNode`.
- `src/engine/codebase/extract-mentioned-filenames.ts` — basename extraction for personalization.
- `src/engine/codebase/repomap.ts` — `buildRepoMap(projectDir, opts)` entry, the only file the orchestrator imports.

## Integration

`src/engine/orchestrator/planning/run.ts` is the single caller. On planning entry, it invokes `buildRepoMap(projectDir, { focusFiles, tokenBudget })`, threading `focusFiles` from mentioned-filename extraction and `tokenBudget` from `config.codebase.tokenBudget` (default 4000).

The resulting string is passed to the planner as an optional `codebaseContext` field on `PlanOptions`; the planner is invoked as `Planner.plan(opts)` with `opts = { feature, projectDir, callbacks, skillsContext, codebaseContext }`. Each backend adapter wraps it in `<repo-map>...</repo-map>` and injects it:

- `cli` planners prepend the block to the first-phase prompt.
- `api` planners include it in the system prompt.
- `agent-sdk` adds it as a `<repo-map>` block on the user turn.

The implementer does not see the repo-map — it's planner-side context only, so `tasks.md` remains transport for Task Briefs and implementer prompts stay unchanged.

Setting `codebase.enabled: false` short-circuits `buildRepoMap` before parsing; the planner runs without the block.

## Design decisions

Alternatives considered and rejected:

- **A — TypeScript Compiler API (`ts-morph` / `typescript`).** Native to our stack, but 10–20× slower than tree-sitter for tag extraction and pulls the full TS compiler (~30 MB) at runtime just to list symbols. Overkill — we don't need semantic resolution. **Rejected.**
- **B — Aider's repomap via subprocess.** Zero implementation effort, but requires Python in the user's environment, adds cross-process serialization, and breaks the "single TS binary" UX. The algorithm is small enough (PageRank ~50 LOC, tree-sitter wrapper ~100 LOC) to own. **Rejected.**
- **C — Embedding-based retrieval (Voyage / OpenAI embeddings).** Semantically smarter than symbol matching, but adds per-call cost, network round-trip, vendor lock-in, and an index-sync problem. Local-only users get nothing. **Rejected for now**, deferred as a possible `codebase.kind: "embeddings"` adapter.
- **D — Skip caching, parse every run.** Simpler, no SQLite, but ~3s on every `splitbrief start` for a 200-file repo is unacceptable repeated cost. **Rejected.**
- **E — TypeScript Language Server (tsserver) over LSP.** Zero new parsing code, but requires a long-running subprocess with a complex lifecycle, heavy startup overhead, and is TS-only by design anyway. Out of proportion for the gain. **Rejected.**

Trade-offs accepted: ~3 MB of new runtime deps (`web-tree-sitter` + TS grammar WASM + `better-sqlite3`), a native module via `better-sqlite3` (prebuilt binaries cover macOS/Linux). Non-TS files are now supported via a language registry (Python, Go, Rust, JavaScript) with lazy grammar loading; unknown languages or missing grammars fall back to filename-only inclusion.
