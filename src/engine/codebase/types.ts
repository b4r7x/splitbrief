export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum';

export interface SymbolRef {
  name: string;
  kind: SymbolKind;
  /** Stripped signature string, e.g. "export function foo(x: number): string" */
  signature: string;
  exported: boolean;
  /** Line number, 1-indexed */
  line: number;
}

export interface FileNode {
  /** Path relative to projectDir (when applicable) or absolute */
  path: string;
  symbols: SymbolRef[];
  /** Raw module specifiers from `import` statements */
  imports: string[];
  sizeBytes: number;
  mtimeMs: number;
}
