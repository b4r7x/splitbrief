export interface LanguageConfig {
  readonly id: string;
  readonly extensions: ReadonlySet<string>;
  readonly grammarPackage: string | null;
  resolveGrammarWasm(ext: string): string | null;
  readonly declarationNodeTypes: ReadonlySet<string>;
  readonly importRegex: RegExp | null;
  resolveImportCandidates(stripped: string): string[];
  /** Language-specific export detection. TS uses `export_statement` wrapper (handled separately). */
  isExported?(name: string, nodeText: string): boolean;
}

const TYPESCRIPT: LanguageConfig = {
  id: 'typescript',
  extensions: new Set(['.ts', '.tsx']),
  grammarPackage: 'tree-sitter-typescript',
  resolveGrammarWasm(ext) {
    return ext === '.tsx' ? 'tree-sitter-tsx.wasm' : 'tree-sitter-typescript.wasm';
  },
  declarationNodeTypes: new Set([
    'function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'lexical_declaration',
  ]),
  importRegex: /import\s+(?:[^'"`]+\s+from\s+)?['"]([^'"]+)['"]/g,
  resolveImportCandidates(stripped) {
    return [`${stripped}.ts`, `${stripped}.tsx`, stripped, `${stripped}/index.ts`];
  },
};

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
    return [
      `${stripped}.js`,
      `${stripped}.jsx`,
      `${stripped}.mjs`,
      stripped,
      `${stripped}/index.js`,
    ];
  },
};

const PYTHON: LanguageConfig = {
  id: 'python',
  extensions: new Set(['.py']),
  grammarPackage: 'tree-sitter-python',
  resolveGrammarWasm() {
    return 'tree-sitter-python.wasm';
  },
  declarationNodeTypes: new Set(['function_definition', 'class_definition']),
  importRegex: /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g,
  resolveImportCandidates(stripped) {
    return [`${stripped}.py`, `${stripped}/__init__.py`];
  },
  isExported() {
    return true;
  },
};

const GO: LanguageConfig = {
  id: 'go',
  extensions: new Set(['.go']),
  grammarPackage: 'tree-sitter-go',
  resolveGrammarWasm() {
    return 'tree-sitter-go.wasm';
  },
  declarationNodeTypes: new Set(['function_declaration', 'method_declaration', 'type_declaration']),
  importRegex: null,
  resolveImportCandidates() {
    return [];
  },
  isExported(name) {
    const ch = name[0];
    return ch !== undefined && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
  },
};

const RUST: LanguageConfig = {
  id: 'rust',
  extensions: new Set(['.rs']),
  grammarPackage: 'tree-sitter-rust',
  resolveGrammarWasm() {
    return 'tree-sitter-rust.wasm';
  },
  declarationNodeTypes: new Set([
    'function_item',
    'struct_item',
    'enum_item',
    'impl_item',
    'trait_item',
    'type_item',
  ]),
  importRegex: null,
  resolveImportCandidates() {
    return [];
  },
  isExported(_name, nodeText) {
    return nodeText.startsWith('pub ') || nodeText.startsWith('pub(');
  },
};

const LANGUAGE_BY_EXT = new Map<string, LanguageConfig>();
for (const lang of [TYPESCRIPT, JAVASCRIPT, PYTHON, GO, RUST]) {
  for (const ext of lang.extensions) LANGUAGE_BY_EXT.set(ext, lang);
}

export const ALL_KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(LANGUAGE_BY_EXT.keys());

export function getLanguageForExtension(ext: string): LanguageConfig | null {
  return LANGUAGE_BY_EXT.get(ext) ?? null;
}
