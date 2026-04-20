import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import { error } from '../../utils/error.js';
import type { FileNode, SymbolKind, SymbolRef } from './types.js';

export const parseError = {
  notInitialized: () =>
    error('codebase-parse-not-initialized', 'Parser not initialized — call initParser() first'),
  parseFailed: (absPath: string) =>
    error('codebase-parse-failed', `tree-sitter failed to parse: ${absPath}`, { absPath }),
} as const;

const require = createRequire(import.meta.url);

let tsLanguage: Language | null = null;
let tsxLanguage: Language | null = null;
let parserInitialized = false;

export async function initParser(): Promise<void> {
  if (parserInitialized) return;

  await Parser.init();

  const tsWasmPath: string = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
  const tsxWasmPath: string = require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');

  [tsLanguage, tsxLanguage] = await Promise.all([
    Language.load(tsWasmPath),
    Language.load(tsxWasmPath),
  ]);

  parserInitialized = true;
}

function getLanguage(absPath: string): Language {
  if (!tsLanguage || !tsxLanguage) {
    throw parseError.notInitialized();
  }
  return absPath.endsWith('.tsx') ? tsxLanguage : tsLanguage;
}

const DECLARATION_NODE_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
]);

function kindForNodeType(type: string): SymbolKind {
  switch (type) {
    case 'function_declaration': return 'function';
    case 'class_declaration':
    case 'abstract_class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'type_alias_declaration': return 'type';
    case 'enum_declaration': return 'enum';
    case 'lexical_declaration': return 'const';
    default: return 'const';
  }
}

function extractName(declNode: Node): string | null {
  if (declNode.type === 'lexical_declaration') {
    const declarator = declNode.namedChildren.find(c => c.type === 'variable_declarator');
    if (!declarator) return null;
    const nameNode = declarator.childForFieldName('name');
    return nameNode?.text ?? null;
  }

  const nameNode = declNode.childForFieldName('name');
  return nameNode?.text ?? null;
}

function extractSignature(declNode: Node, exported: boolean): string {
  const fullText = declNode.text;
  const braceIdx = fullText.indexOf('{');
  let sig: string;
  if (braceIdx === -1) {
    sig = fullText;
  } else {
    sig = fullText.slice(0, braceIdx).trimEnd();
  }
  const exportPrefix = exported ? 'export ' : '';
  const sigWithoutExport = sig.startsWith('export ') ? sig.slice(7) : sig;
  return (exportPrefix + sigWithoutExport).trim();
}

const IMPORT_RE = /import\s+(?:[^'"`]+\s+from\s+)?['"]([^'"]+)['"]/g;

function extractImports(source: string): string[] {
  const matches = [...source.matchAll(IMPORT_RE)];
  return matches.flatMap(m => (m[1] !== undefined ? [m[1]] : []));
}

export async function parseFile(absPath: string): Promise<FileNode> {
  if (!parserInitialized) {
    await initParser();
  }

  const stat = statSync(absPath);
  const source = readFileSync(absPath, 'utf8');

  const parser = new Parser();
  parser.setLanguage(getLanguage(absPath));
  const tree = parser.parse(source);

  if (!tree) {
    throw parseError.parseFailed(absPath);
  }

  const symbols: SymbolRef[] = [];
  const rootChildren = tree.rootNode.namedChildren;

  for (const child of rootChildren) {
    if (child.type === 'export_statement') {
      const declNode = child.namedChildren.find(c => DECLARATION_NODE_TYPES.has(c.type));
      if (!declNode) continue;

      const name = extractName(declNode);
      if (!name) continue;

      const kind = kindForNodeType(declNode.type);
      const signature = extractSignature(declNode, true);
      const line = declNode.startPosition.row + 1;

      symbols.push({ name, kind, signature, exported: true, line });
    } else if (DECLARATION_NODE_TYPES.has(child.type)) {
      const name = extractName(child);
      if (!name) continue;

      const kind = kindForNodeType(child.type);
      const signature = extractSignature(child, false);
      const line = child.startPosition.row + 1;

      symbols.push({ name, kind, signature, exported: false, line });
    }
  }

  parser.delete();
  tree.delete();

  return {
    path: absPath,
    symbols,
    imports: extractImports(source),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}
