import type { FileNode } from './types.js';
import { formatFileNode } from './format.js';
import { estimateTokens } from '../../core/tokens/estimate.js';

export { estimateTokens };

export function formatWithBudget(
  nodes: FileNode[],
  rankings: Map<string, number>,
  tokenBudget: number,
): string {
  if (tokenBudget <= 0) return '';

  const sorted = [...nodes].sort(
    (a, b) => (rankings.get(b.path) ?? 0) - (rankings.get(a.path) ?? 0),
  );

  const blocks: string[] = [];
  let usedTokens = 0;

  for (const node of sorted) {
    const block = formatFileNode(node);
    const sep = blocks.length > 0 ? '\n\n' : '';
    const tokens = estimateTokens(sep + block);
    // Always include the first (highest-ranked) file; respect budget for subsequent files
    if (blocks.length > 0 && usedTokens + tokens > tokenBudget) continue;
    blocks.push(block);
    usedTokens += tokens;
  }

  return blocks.join('\n\n');
}
