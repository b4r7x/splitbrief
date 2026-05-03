# 02 - Parser Refactor + File Discovery + Graph

> Implement only this brief. Do not run git add/commit/stage/stash.
> Depends on: brief 01 (language registry).

## Goal

Refactor parse.ts for multi-language lazy grammar loading. Update repomap.ts to discover all known-extension files. Update graph.ts to use per-language import resolution. Unknown languages or missing grammars → filename-only FileNode (empty symbols/imports).

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`
- `/code-audit`

## Required Reading

- `CLAUDE.md`
- `src/engine/codebase/languages.ts` (from brief 01)
- `src/engine/codebase/parse.ts` — full file, this is the rewrite target
- `src/engine/codebase/repomap.ts` — full file, modify discovery
- `src/engine/codebase/graph.ts` — full file, modify resolution
- `src/engine/codebase/cache.ts` — understand cache keying and PARSE_VERSION
- `src/engine/codebase/types.ts` — FileNode, SymbolRef

## Write Ownership

```
src/engine/codebase/parse.ts       (rewrite)
src/engine/codebase/parse.test.ts  (create or extend)
src/engine/codebase/repomap.ts     (modify lines 17-24, discoverFiles)
src/engine/codebase/graph.ts       (modify resolveImport)
src/engine/codebase/graph.test.ts  (create or extend)
src/engine/codebase/cache.ts       (bump PARSE_VERSION)
package.json                       (add optionalDependencies)
```

## Required Behavior

### Parser: Lazy grammar loading

Replace module-level `tsLanguage`/`tsxLanguage` with a `Map<string, Language>`:

```typescript
const loadedGrammars = new Map<string, Language>();

async function loadGrammar(lang: LanguageConfig, ext: string): Promise<Language | null> {
  const wasmFile = lang.resolveGrammarWasm(ext);
  if (!wasmFile || !lang.grammarPackage) return null;

  const cached = loadedGrammars.get(wasmFile);
  if (cached) return cached;

  try {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve(`${lang.grammarPackage}/${wasmFile}`);
    const grammar = await Language.load(wasmPath);
    loadedGrammars.set(wasmFile, grammar);
    return grammar;
  } catch {
    return null; // package not installed — filename-only
  }
}
```

`initParser()` still calls `Parser.init()` but does NOT pre-load grammars.

`parseFile(absPath)`:
1. Get `LanguageConfig` via `getLanguageForExtension(extname(absPath))`
2. If null → return null (unknown extension, skip)
3. Load grammar → if null (package missing) → return filename-only FileNode: `{ path, symbols: [], imports: [], sizeBytes, mtimeMs }`
4. Parse with language's `declarationNodeTypes`
5. Extract imports with language's `importRegex`

### Discovery: All known extensions

In `repomap.ts`, replace:
```typescript
const DEFAULT_INCLUDE_EXTS = new Set(['.ts', '.tsx']);
```
with:
```typescript
import { ALL_KNOWN_EXTENSIONS } from './languages.js';
```

Use `ALL_KNOWN_EXTENSIONS` in `discoverFiles()` where the extension check happens.

### Graph: Per-language resolution

In `graph.ts`, `resolveImport()` uses the importer's language config:

```typescript
function resolveImport(spec: string, importerPath: string, resolvedPathMap: Map<string, string>): string | null {
  if (!spec.startsWith('.')) return null;
  const lang = getLanguageForExtension(extname(importerPath));
  if (!lang) return null;
  const stripped = spec.replace(/\.\w+$/, '');
  for (const candidate of lang.resolveImportCandidates(stripped)) {
    const resolved = resolvedPathMap.get(candidate);
    if (resolved) return resolved;
  }
  return null;
}
```

### Cache: Bump PARSE_VERSION

In `cache.ts`, increment the `PARSE_VERSION` constant to force a full cache rebuild.

### package.json: optionalDependencies

```json
"optionalDependencies": {
  "tree-sitter-wasms": "^0.1.13"
}
```

After adding, run `npm install` and verify the WASM files exist in `node_modules/tree-sitter-wasms/`. Adapt the grammar resolution paths in `languages.ts` if the directory structure differs from expected.

## TDD Steps

- [ ] **Write test: TS parsing backward compat**

```typescript
// src/engine/codebase/parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseFile, initParser } from './parse.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('parseFile', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parse-'));
    await initParser();
  });
  afterEach(() => rmSync(tmpDir, { recursive: true }));

  it('parses TS file with function and type declarations', async () => {
    const file = join(tmpDir, 'test.ts');
    writeFileSync(file, 'export function hello(): string { return "hi"; }\nexport type Foo = string;');
    const node = await parseFile(file);
    expect(node?.symbols).toHaveLength(2);
    expect(node?.symbols[0].name).toBe('hello');
    expect(node?.symbols[1].name).toBe('Foo');
  });

  it('returns filename-only node for unknown extension', async () => {
    const file = join(tmpDir, 'test.xyz');
    writeFileSync(file, 'some content');
    const node = await parseFile(file);
    expect(node).toBeNull();
  });

  it('returns filename-only node when grammar package is missing', async () => {
    // .py file but tree-sitter-wasms not installed (or mock the require.resolve to throw)
    const file = join(tmpDir, 'test.py');
    writeFileSync(file, 'def hello(): pass');
    const node = await parseFile(file);
    // If tree-sitter-wasms IS installed, this returns symbols
    // If NOT installed, this returns { symbols: [], imports: [] }
    expect(node).toBeTruthy(); // at minimum, a FileNode is returned
  });
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Write test: graph uses per-language resolution**

```typescript
// src/engine/codebase/graph.test.ts
it('resolves TS imports with .ts/.tsx candidates', () => {
  // Build graph with TS FileNodes importing relative paths
  // Verify edges are created correctly — same as current behavior
});

it('Go files produce no import edges', () => {
  // Build graph with Go FileNodes
  // Verify no edges (Go doesn't have file-relative imports)
});
```

- [ ] **Run tests, implement, verify**
- [ ] **Run:** `npm run test-ci`

## Verification

- [ ] TS project produces identical repo map (diff before/after)
- [ ] Python files with tree-sitter-wasms installed get parsed symbols
- [ ] Python files without grammar get filename-only entries (no crash)
- [ ] Go files have no import graph edges
- [ ] Cache rebuilds automatically (PARSE_VERSION bump)
- [ ] `npm run test-ci` passes
- [ ] Update docs: REPOMAP.md, ARCHITECTURE.md, FUTURE.md
