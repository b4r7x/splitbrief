# Execute Prompt: Polyglot Codebase Analysis

## Prompt To Paste

```text
You are implementing polyglot codebase analysis for diptych:

docs/superpowers/specs/02-polyglot-codebase-analysis/

Goal:
Replace TS-only codebase analysis (tree-sitter parsing, file discovery, import graph) with a language-aware system. LanguageConfig registry, lazy grammar loading, multi-lang repo map. Unknown languages fall back to filename-only inclusion.

CRITICAL WASM NOTE: The npm packages tree-sitter-python/go/rust do NOT ship .wasm files. Only tree-sitter-typescript ships WASM. For other languages, use the `tree-sitter-wasms` package (pre-built WASM for many languages) or `@vscode/tree-sitter-wasm` (Microsoft's builds). Verify WASM file paths after install before writing loader code.

Hard repository rules:
- Do NOT run git add, git stage, git commit, or git stash.
- Leave ALL changes as unstaged modifications.
- Verify with: npm run test-ci

Project constraints:
- Node.js 22+, TypeScript 6.x, ESM only (.js in all imports).
- No classes. Pure functions, module-scoped state only.
- No barrel files. No index.ts.
- Zod 4.x, Vitest 4.x, Biome 2.x.
- kebab-case file names. No decorative comments.

Required skills to load BEFORE writing any code:
1. /sota
2. /code-audit
3. /test-behavior-not-implementation
4. /clean-code
5. /coding-standards

Required reading:
1. CLAUDE.md
2. docs/REPOMAP.md
3. docs/ARCHITECTURE.md (codebase analysis section)
4. src/engine/codebase/parse.ts (current parser — 161 lines, TS-only)
5. src/engine/codebase/repomap.ts (repo map builder, DEFAULT_INCLUDE_EXTS at line 17)
6. src/engine/codebase/graph.ts (import graph — 64 lines, TS resolution)
7. src/engine/codebase/types.ts (FileNode, SymbolRef types)
8. src/engine/codebase/cache.ts (SQLite parse cache)
9. src/engine/codebase/budget.ts (token-budgeted formatting)
10. src/engine/codebase/pagerank.ts (PageRank ranking)
11. src/core/schemas/codebase.ts (CodebaseConfigSchema)

Implementation order:
1. docs/superpowers/specs/02-polyglot-codebase-analysis/agent-briefs/01-language-registry.md
2. docs/superpowers/specs/02-polyglot-codebase-analysis/agent-briefs/02-parser-and-discovery.md

After ALL briefs: npm run test-ci + verify TS project produces identical repo map.
Do NOT edit CLAUDE.md.
```
