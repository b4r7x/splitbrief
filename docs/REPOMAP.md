# Repo-map context

The SPLITBRIEF planner sees a token-budgeted **repo-map** of your project's source on every workflow start. The repo-map gives the planner a structural overview — file paths, top-level signatures, exports — without burning context tokens on file reads. Inspired by [Aider's repomap](https://aider.chat/docs/repomap.html), tuned for a planner that compiles Task Briefs and decides when extra structure is worth paying for.

## Why

Without a repo-map, cheap planners (Ollama, DeepSeek, etc.) miss existing helpers and propose duplicates. Even Claude burns tokens reading files we could have summarized. The repo-map costs ~4000 tokens per workflow and saves orders of magnitude more on planning-session reads.

## What it contains

For each file (sorted by [PageRank](#ranking) over the import graph):

```
src/core/state/machine.ts:
  export function createInitialState(feature: string, now: Date = new Date()): WorkflowState
  function setTaskStatus(state: WorkflowState, taskId: TaskId, status: TaskStatus): WorkflowState
  export function briefCorrections(state: WorkflowState, taskId: TaskId): readonly string[]

src/core/schemas/enums.ts:
  export const PhaseSchema = z.enum(PHASES);
  export type Phase = z.infer<typeof PhaseSchema>;
```

Only signatures (top-level declarations) appear. Bodies are elided. The highest-ranked file always appears. A later file whose block does not fit the remaining budget is skipped, and a smaller file after it can still fit.

## Configuration

```yaml
# .splitbrief/config.yaml — all fields optional, defaults shown
codebase:
  enabled: true              # set to false to disable
  tokenBudget: 4000          # tokens reserved in the planner prompt
  include: ["src/**/*"]     # globs (default: every file with a known language extension)
  exclude:                   # extra regex strings, added to the defaults below
    - "^generated/"
```

Schema: `src/core/schemas/codebase.ts`.

Discovery (`src/engine/codebase/discover-files.ts`) reads the known extensions from `ALL_KNOWN_EXTENSIONS` in `src/engine/codebase/languages.ts`. Five languages are known: TypeScript (`.ts`, `.tsx`), JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`), Python (`.py`), Go (`.go`) and Rust (`.rs`).

Discovery always skips the `.git`, `.splitbrief`, `node_modules`, `.trees` and `dist` folders and files that match `\.test\.tsx?$`. Each `exclude` entry is a regular expression. It is tested against the project-relative path of every file and every folder. Files larger than 100 KB are not parsed.

## Ranking

Files are ranked by [PageRank](https://en.wikipedia.org/wiki/PageRank) over the file→file import graph (damping 0.85, max 100 iterations). Edges are directed from importer to imported. Edges are unweighted: one import of a file makes one edge.

### Personalization vector

A personalization vector biases the walk toward files the user already cares about. SPLITBRIEF scans the feature prompt for file paths and basenames (e.g. `auth.ts`, `validation.ts`). Each matched file gets an equal share of the teleport mass. So "edit auth.ts and wire it into login" makes `auth.ts` and its import neighborhood rank first. When the prompt names no file, the teleport mass is uniform.

Every other file still receives rank through its inbound imports and through the uniform share of the rank that files without resolved imports give back. So a central file that the prompt does not name (e.g. `state/machine.ts`) stays in the map.

Mentioned-file extraction lives in `src/engine/codebase/extract-mentioned-filenames.ts`. The PageRank implementation is in `src/engine/codebase/pagerank.ts` — pure JS, no native deps.

## Cache

Parsed symbols and imports are cached in SQLite at `${projectDir}/.splitbrief/repomap.sqlite` via `better-sqlite3`. One row per file.

If the native SQLite binding is missing or incompatible with the current Node runtime, the same parser builds the repo-map without caching. Planning continues with its code overview. The transcript shows one short notice; the full diagnostic is recorded in the session log. Cache path and permission failures do not enter this fallback. To restore caching after changing Node versions, run `npm rebuild better-sqlite3` in the installation directory.

### Schema

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  symbols_json TEXT NOT NULL,
  imports_json TEXT NOT NULL,
  parse_version INTEGER NOT NULL
);
```

### Invalidation

On read, `cache.ts` compares the row's `(mtime_ms, size_bytes, parse_version)` to the file on disk and the build-time constant:

- **Hit:** `mtime_ms` and `size_bytes` match the current stat **and** `parse_version` matches the compiled-in constant → deserialize `symbols_json` and `imports_json`, skip parse.
- **Miss (file changed):** mtime or size differs → re-parse, upsert the row.
- **Miss (parser changed):** the global `parse_version` constant was bumped (grammar upgrade, capture changes) → every row is stale, and each file is re-parsed on its next read.

This means grammar bumps don't need manual cleanup, and neither does anything else: every planning run re-reads the cache and re-parses whatever is stale, so there is no manual rebuild step.

Cold parse on a 200-file repo: ~3s on M1. Warm hit: <100ms (mtime check + JSON load). Note: mtime-based invalidation misses the rare content-equal-mtime-different case; the escape hatch is deleting `${projectDir}/.splitbrief/repomap.sqlite` by hand, along with the `-shm` and `-wal` siblings WAL mode leaves beside it — the next planning run parses from scratch.

## Opt-out

```yaml
# .splitbrief/config.yaml
codebase:
  enabled: false
```

The planner prompt then has no `## Repository Map` section. Use this if you have token-tight planners and prefer to lean on `Read` tool calls instead.

## Implementation

Module: `src/engine/codebase/`. The entry point `repomap.ts` discovers the files (`discover-files.ts`) and then runs a four-step pipeline:

1. **Parse** — `src/engine/codebase/parse.ts` wraps `web-tree-sitter` with language-specific WASM grammars loaded lazily from the `LanguageConfig` registry. For each discovered file it extracts `tags.scm`-equivalent captures (function declarations, classes, types, etc.) according to the language's node types. A file whose language is not in the registry is not parsed and does not appear. A known language whose grammar does not load falls back to filename-only inclusion (empty symbols and imports). Output is `FileNode { symbols, imports, sizeBytes, mtimeMs }`. The parse step is fronted by the cache (see above) — actual tree-sitter work only runs on misses.
2. **Graph build** — `src/engine/codebase/graph.ts` turns the parsed `imports` of each file into a directed file→file graph. Only relative import specifiers (those that start with `.`) are resolved, through the language's candidate file names. Package imports, path aliases and unresolved imports are dropped. Edges are unweighted.
3. **PageRank** — `src/engine/codebase/pagerank.ts` runs PageRank over the graph with a personalization vector built from the files the user's prompt names (see [Ranking](#ranking)).
4. **Budget-aware emit** — `src/engine/codebase/format.ts` and `src/engine/codebase/budget.ts` walk files in descending rank order, emitting one block of signature lines per file. A rolling token estimate (chars / 4) skips each block that does not fit the remaining `tokenBudget`. The first block always fits, so the highest-ranked file always appears.

Other files:

- `src/engine/codebase/discover-files.ts` — the file walk with the default and configured excludes.
- `src/engine/codebase/languages.ts` — the `LanguageConfig` registry and `ALL_KNOWN_EXTENSIONS`.
- `src/engine/codebase/cache.ts` — SQLite-backed parse cache (see [Cache](#cache)).
- `src/engine/codebase/cache-path.ts` — the cache folder and the `repomap.sqlite` path.
- `src/engine/codebase/types.ts` — `SymbolRef`, `FileNode`.
- `src/engine/codebase/extract-mentioned-filenames.ts` — basename extraction for personalization.
- `src/engine/codebase/repomap.ts` — `buildRepoMap(projectDir, opts)` entry, the only file the orchestrator imports.

## Integration

`planTurnText()` in `src/engine/orchestrator/planning/session.ts` is the single caller. It builds the prompt of every planning turn, for a run and for `splitbrief spec`. It calls `buildRepoMap(projectDir, { featureText, tokenBudget, include, exclude })`. `featureText` is the user's request, and the other values come from the `codebase` config (`tokenBudget` defaults to 4000).

`buildPlanSessionPrompt()` in `src/engine/spec/prompts/plan-session.ts` puts the result in a `## Repository Map` section of the planning prompt. An empty repo-map adds no section. The planner then answers that prompt in one typed call, validated against `PlanAnswerSchema`.

An `api` planner reads no files of its own. For it, `planTurnText()` also builds the project context with `apiPlanningPacket()` (`src/engine/orchestrator/planning/api-packet.ts`). The packet attaches the current source of the files the request names, and then optional source files in repo-map order, so the highest-ranked files come first. The whole turn is measured against the seat's context window.

The implementer does not see the repo-map. It is planner-side context only, so `tasks.md` remains transport for Task Briefs and implementer prompts stay unchanged.

Setting `codebase.enabled: false` skips `buildRepoMap` completely; the planner runs without the section.

## Design decisions

Alternatives considered and rejected:

- **A — TypeScript Compiler API (`ts-morph` / `typescript`).** Native to our stack, but 10–20× slower than tree-sitter for tag extraction and pulls the full TS compiler (~30 MB) at runtime just to list symbols. Overkill — we don't need semantic resolution. **Rejected.**
- **B — Aider's repomap via subprocess.** Zero implementation effort, but requires Python in the user's environment, adds cross-process serialization, and breaks the "single TS binary" UX. The algorithm is small enough (PageRank ~50 LOC, tree-sitter wrapper ~100 LOC) to own. **Rejected.**
- **C — Embedding-based retrieval (Voyage / OpenAI embeddings).** Semantically smarter than symbol matching, but adds per-call cost, network round-trip, vendor lock-in, and an index-sync problem. Local-only users get nothing. **Rejected.** A `codebase.kind: "embeddings"` adapter remains possible.
- **D — Skip caching, parse every run.** Simpler, no SQLite, but ~3s on every `splitbrief start` for a 200-file repo is unacceptable repeated cost. **Rejected.**
- **E — TypeScript Language Server (tsserver) over LSP.** Zero new parsing code, but requires a long-running subprocess with a complex lifecycle, heavy startup overhead, and is TS-only by design anyway. Out of proportion for the gain. **Rejected.**

Trade-offs accepted: ~3 MB of new runtime deps (`web-tree-sitter` + TS grammar WASM + `better-sqlite3`), a native module via `better-sqlite3` (prebuilt binaries cover macOS/Linux). Non-TS files are supported via a language registry (JavaScript, Python, Go, Rust) with lazy grammar loading; a known language whose grammar does not load falls back to filename-only inclusion.
