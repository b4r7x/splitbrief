import type { FileNode, SymbolRef } from '../../../src/engine/codebase/types.js';

export function makeFileNode(path: string, overrides?: Partial<FileNode>): FileNode {
  return {
    path,
    symbols: [],
    imports: [],
    sizeBytes: 1,
    mtimeMs: 1,
    ...overrides,
  };
}

export function makeSymbol(name: string, overrides?: Partial<SymbolRef>): SymbolRef {
  return {
    name,
    kind: 'function',
    signature: `export function ${name}()`,
    exported: true,
    line: 1,
    ...overrides,
  };
}
