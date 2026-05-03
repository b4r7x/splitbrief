# 01 - Language Registry + Config Types

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Create the `LanguageConfig` type and built-in language registry. Define configs for TypeScript, JavaScript, Python, Go, Rust. Export extension lookup and known-extensions set.

## Required Skills

- `/test-behavior-not-implementation`
- `/clean-code`

## Required Reading

- `CLAUDE.md`
- `src/engine/codebase/parse.ts` — current TS-specific declarations and import regex
- `src/engine/codebase/graph.ts` — current TS-specific resolution candidates

## Write Ownership

```
src/engine/codebase/languages.ts       (create)
src/engine/codebase/languages.test.ts  (create)
```

## Required Behavior

```typescript
// src/engine/codebase/languages.ts

export interface LanguageConfig {
  readonly id: string;
  readonly extensions: ReadonlySet<string>;
  readonly grammarPackage: string | null;
  resolveGrammarWasm(ext: string): string | null;
  readonly declarationNodeTypes: ReadonlySet<string>;
  readonly importRegex: RegExp | null;
  resolveImportCandidates(stripped: string): string[];
}

const TYPESCRIPT: LanguageConfig = {
  id: 'typescript',
  extensions: new Set(['.ts', '.tsx']),
  grammarPackage: 'tree-sitter-typescript',
  resolveGrammarWasm(ext) {
    return ext === '.tsx' ? 'tree-sitter-tsx.wasm' : 'tree-sitter-typescript.wasm';
  },
  declarationNodeTypes: new Set([
    'function_declaration', 'class_declaration', 'abstract_class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'lexical_declaration',
  ]),
  importRegex: /import\s+(?:[^'"`]+\s+from\s+)?['"]([^'"]+)['"]/g,
  resolveImportCandidates(stripped) {
    return [`${stripped}.ts`, `${stripped}.tsx`, stripped, `${stripped}/index.ts`];
  },
};

// JavaScript reuses TS grammar (parses JS fine)
const JAVASCRIPT: LanguageConfig = {
  id: 'javascript',
  extensions: new Set(['.js', '.jsx', '.mjs', '.cjs']),
  grammarPackage: 'tree-sitter-typescript',
  resolveGrammarWasm(ext) {
    return ext === '.jsx' ? 'tree-sitter-tsx.wasm' : 'tree-sitter-typescript.wasm';
  },
  declarationNodeTypes: TYPESCRIPT.declarationNodeTypes,
  importRegex: TYPESCRIPT.importRegex,
  resolveImportCandidates(stripped) {
    return [`${stripped}.js`, `${stripped}.jsx`, `${stripped}.mjs`, stripped, `${stripped}/index.js`];
  },
};

// Python, Go, Rust use tree-sitter-wasms or @vscode/tree-sitter-wasm
// IMPORTANT: verify WASM file paths after installing the package
const PYTHON: LanguageConfig = {
  id: 'python',
  extensions: new Set(['.py']),
  grammarPackage: 'tree-sitter-wasms', // or '@vscode/tree-sitter-wasm'
  resolveGrammarWasm() { return 'tree-sitter-python.wasm'; },
  declarationNodeTypes: new Set(['function_definition', 'class_definition']),
  importRegex: /(?:from\s+(\S+)\s+import|import\s+(\S+))/g,
  resolveImportCandidates(stripped) {
    return [`${stripped}.py`, `${stripped}/__init__.py`];
  },
};

const GO: LanguageConfig = {
  id: 'go',
  extensions: new Set(['.go']),
  grammarPackage: 'tree-sitter-wasms',
  resolveGrammarWasm() { return 'tree-sitter-go.wasm'; },
  declarationNodeTypes: new Set(['function_declaration', 'method_declaration', 'type_declaration']),
  importRegex: /import\s+"([^"]+)"/g,
  resolveImportCandidates() { return []; }, // Go uses package imports, not file-relative
};

const RUST: LanguageConfig = {
  id: 'rust',
  extensions: new Set(['.rs']),
  grammarPackage: 'tree-sitter-wasms',
  resolveGrammarWasm() { return 'tree-sitter-rust.wasm'; },
  declarationNodeTypes: new Set(['function_item', 'struct_item', 'enum_item', 'impl_item', 'trait_item', 'type_item']),
  importRegex: /use\s+(?:crate::)?([^;{]+)/g,
  resolveImportCandidates() { return []; }, // Rust uses module paths, not file-relative
};

const LANGUAGE_BY_EXT = new Map<string, LanguageConfig>();
for (const lang of [TYPESCRIPT, JAVASCRIPT, PYTHON, GO, RUST]) {
  for (const ext of lang.extensions) LANGUAGE_BY_EXT.set(ext, lang);
}

export const ALL_KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(LANGUAGE_BY_EXT.keys());

export function getLanguageForExtension(ext: string): LanguageConfig | null {
  return LANGUAGE_BY_EXT.get(ext) ?? null;
}
```

Fill in Go and Rust configs following the same pattern. For Go: `declarationNodeTypes = ['function_declaration', 'method_declaration', 'type_declaration']`, no file-relative imports (return `[]`). For Rust: `declarationNodeTypes = ['function_item', 'struct_item', 'enum_item', 'impl_item', 'trait_item']`, no file-relative imports.

## TDD Steps

- [ ] **Write tests**

```typescript
// src/engine/codebase/languages.test.ts
import { describe, it, expect } from 'vitest';
import { getLanguageForExtension, ALL_KNOWN_EXTENSIONS } from './languages.js';

describe('language registry', () => {
  it('.ts returns TypeScript config', () => {
    const lang = getLanguageForExtension('.ts');
    expect(lang?.id).toBe('typescript');
  });

  it('.tsx returns TypeScript with tsx grammar', () => {
    const lang = getLanguageForExtension('.tsx');
    expect(lang?.resolveGrammarWasm('.tsx')).toBe('tree-sitter-tsx.wasm');
  });

  it('.py returns Python config', () => {
    const lang = getLanguageForExtension('.py');
    expect(lang?.id).toBe('python');
  });

  it('.go returns Go config', () => {
    expect(getLanguageForExtension('.go')?.id).toBe('go');
  });

  it('.rs returns Rust config', () => {
    expect(getLanguageForExtension('.rs')?.id).toBe('rust');
  });

  it('.xyz returns null', () => {
    expect(getLanguageForExtension('.xyz')).toBeNull();
  });

  it('ALL_KNOWN_EXTENSIONS includes all language extensions', () => {
    expect(ALL_KNOWN_EXTENSIONS.has('.ts')).toBe(true);
    expect(ALL_KNOWN_EXTENSIONS.has('.py')).toBe(true);
    expect(ALL_KNOWN_EXTENSIONS.has('.go')).toBe(true);
    expect(ALL_KNOWN_EXTENSIONS.has('.rs')).toBe(true);
    expect(ALL_KNOWN_EXTENSIONS.has('.js')).toBe(true);
  });

  it('TypeScript import candidates match existing behavior', () => {
    const lang = getLanguageForExtension('.ts')!;
    const candidates = lang.resolveImportCandidates('./foo');
    expect(candidates).toEqual(['./foo.ts', './foo.tsx', './foo', './foo/index.ts']);
  });

  it('Go has no file-relative import candidates', () => {
    const lang = getLanguageForExtension('.go')!;
    expect(lang.resolveImportCandidates('./foo')).toEqual([]);
  });
});
```

- [ ] **Run tests to verify they fail** — `npx vitest run src/engine/codebase/languages.test.ts`
- [ ] **Implement languages.ts**
- [ ] **Run tests to verify they pass**
- [ ] **Run:** `npm run test-ci`

## Verification

- [ ] Every supported language has a config with id, extensions, declarationNodeTypes
- [ ] Extension lookup returns correct config for .ts, .tsx, .py, .go, .rs, .js, .jsx
- [ ] Unknown extensions return null
- [ ] TS import candidates match existing behavior exactly
- [ ] Go/Rust return empty import candidates (no file-relative imports)
- [ ] `npm run test-ci` passes
