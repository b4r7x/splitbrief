import { stat, readFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, type Node, type Tree } from 'web-tree-sitter';
import { error } from '../../utils/error.js';
import type { FileNode, SymbolKind, SymbolRef } from './types.js';
import { getLanguageForExtension, type LanguageConfig } from './languages.js';

const parseError = {
  parseFailed: (absPath: string) =>
    error('codebase-parse-failed', `tree-sitter failed to parse: ${absPath}`, { absPath }),
} as const;

const loadedGrammars = new Map<string, Promise<Language | null>>();

let initPromise: Promise<void> | null = null;

export function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

function loadGrammar(lang: LanguageConfig, ext: string): Promise<Language | null> {
  const wasmFile = lang.resolveGrammarWasm(ext);
  if (!wasmFile || !lang.grammarPackage) return Promise.resolve(null);

  const cached = loadedGrammars.get(wasmFile);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve(`${lang.grammarPackage}/${wasmFile}`);
      return await Language.load(wasmPath);
    } catch {
      return null;
    }
  })();

  loadedGrammars.set(wasmFile, promise);
  return promise;
}

export function kindForNodeType(type: string): SymbolKind {
  switch (type) {
    case 'function_declaration':
    case 'function_definition':
    case 'method_declaration':
    case 'function_item':
      return 'function';
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class_definition':
    case 'struct_item':
    case 'impl_item':
      return 'class';
    case 'interface_declaration':
    case 'trait_item':
      return 'interface';
    case 'type_alias_declaration':
    case 'type_declaration':
    case 'type_item':
      return 'type';
    case 'enum_declaration':
    case 'enum_item':
      return 'enum';
    case 'lexical_declaration':
      return 'const';
    default:
      return 'const';
  }
}

function extractName(declNode: Node): string | null {
  if (declNode.type === 'lexical_declaration') {
    const declarator = declNode.namedChildren.find((c: Node) => c.type === 'variable_declarator');
    if (!declarator) return null;
    const nameNode = declarator.childForFieldName('name');
    return nameNode?.text ?? null;
  }

  const nameNode = declNode.childForFieldName('name');
  return nameNode?.text ?? null;
}

function extractSignature(declNode: Node, opts: { exported: boolean }): string {
  const fullText = declNode.text;
  const braceIdx = fullText.indexOf('{');
  let sig: string;
  if (braceIdx === -1) {
    sig = fullText;
  } else {
    sig = fullText.slice(0, braceIdx).trimEnd();
  }
  const exportPrefix = opts.exported ? 'export ' : '';
  const sigWithoutExport = sig.startsWith('export ') ? sig.slice(7) : sig;
  return (exportPrefix + sigWithoutExport).trim();
}

function extractImports(source: string, regex: RegExp | null): string[] {
  if (!regex) return [];
  const matches = [...source.matchAll(regex)];
  return matches
    .map((m) => {
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined) return m[i];
      }
      return undefined;
    })
    .filter((s): s is string => s !== undefined);
}

function extractSymbols(tree: Tree, lang: LanguageConfig): SymbolRef[] {
  const symbols: SymbolRef[] = [];
  const rootChildren = tree.rootNode.namedChildren;

  for (const child of rootChildren) {
    if (child.type === 'export_statement') {
      const declNode = child.namedChildren.find((c: Node) => lang.declarationNodeTypes.has(c.type));
      if (!declNode) continue;

      const name = extractName(declNode);
      if (!name) continue;

      const kind = kindForNodeType(declNode.type);
      const signature = extractSignature(declNode, { exported: true });
      const line = declNode.startPosition.row + 1;

      symbols.push({ name, kind, signature, exported: true, line });
    } else if (lang.declarationNodeTypes.has(child.type)) {
      const name = extractName(child);
      if (!name) continue;

      const exported = lang.isExported ? lang.isExported(name, child.text) : false;
      const kind = kindForNodeType(child.type);
      const signature = extractSignature(child, { exported });
      const line = child.startPosition.row + 1;

      symbols.push({ name, kind, signature, exported, line });
    }
  }

  return symbols;
}

export async function parseFile(absPath: string, fileStat?: Stats): Promise<FileNode | null> {
  await initParser();

  const ext = extname(absPath);
  const lang = getLanguageForExtension(ext);
  if (!lang) return null;

  let resolvedStat = fileStat;
  let source: string;
  try {
    if (resolvedStat === undefined) resolvedStat = await stat(absPath);
    source = await readFile(absPath, 'utf8');
  } catch {
    return null;
  }

  const grammar = await loadGrammar(lang, ext);
  if (!grammar) {
    return {
      path: absPath,
      symbols: [],
      imports: [],
      sizeBytes: resolvedStat.size,
      mtimeMs: resolvedStat.mtimeMs,
    };
  }

  const parser = new Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(source);

    if (!tree) {
      throw parseError.parseFailed(absPath);
    }

    const symbols = extractSymbols(tree, lang);
    const imports = extractImports(source, lang.importRegex);

    return {
      path: absPath,
      symbols,
      imports,
      sizeBytes: resolvedStat.size,
      mtimeMs: resolvedStat.mtimeMs,
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}
