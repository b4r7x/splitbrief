import type { FileNode } from './types.js';

export function formatFileNode(node: FileNode): string {
  const lines = [`${node.path}:`];
  for (const sym of node.symbols) {
    lines.push(`  ${sym.signature}`);
  }
  return lines.join('\n');
}
