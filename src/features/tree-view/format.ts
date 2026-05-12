import type { SessionTree } from '../../core/sessions/tree/store.js';
import type { TreeEntryEnvelope, EntryId } from '../../core/sessions/tree/schemas.js';
import { isOnActivePath, childrenOf } from '../../core/sessions/tree/store.js';
import type { TreeViewState } from './tree-store.js';

export interface TreeLine {
  id: EntryId;
  depth: number;
  prefix: string;
  label: string;
  isActive: boolean;
  isBranchPoint: boolean;
  isCollapsed: boolean;
  type: string;
  timestamp: number;
}

export function formatTree(tree: SessionTree, viewState: TreeViewState): TreeLine[] {
  const lines: TreeLine[] = [];
  const rootChildren = tree.children.get(null) ?? [];

  for (const rootId of rootChildren) {
    const root = tree.entries.get(rootId);
    if (root && passesFilter(root, viewState.filter, true)) {
      formatNode(tree, root, 0, '', viewState, lines);
    }
  }

  return lines;
}

function formatNode(
  tree: SessionTree,
  entry: TreeEntryEnvelope,
  depth: number,
  prefix: string,
  viewState: TreeViewState,
  lines: TreeLine[],
): void {
  if (!passesFilter(entry, viewState.filter, depth === 0)) return;

  const children = childrenOf(tree, entry.id);
  const isBranchPoint = children.length > 1;
  const isExpanded = viewState.expandedNodes.has(entry.id);
  const isActive = isOnActivePath(tree, entry.id);

  lines.push({
    id: entry.id,
    depth,
    prefix,
    label: formatEntryLabel(entry),
    isActive,
    isBranchPoint,
    isCollapsed: isBranchPoint && !isExpanded,
    type: entry.type,
    timestamp: entry.timestamp,
  });

  if (isBranchPoint && !isExpanded) return;

  const visibleChildren = children.filter(c => passesFilter(c, viewState.filter, false));
  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i]!;
    const isLast = i === visibleChildren.length - 1;
    const childPrefix = prefix + (isLast ? '└── ' : '├── ');
    formatNode(tree, child, depth + 1, childPrefix, viewState, lines);
  }
}

function passesFilter(entry: TreeEntryEnvelope, filter: TreeViewState['filter'], isRoot: boolean): boolean {
  if (filter === 'all') return true;
  if (isRoot) return true;
  if (filter === 'displayable') return entry.display !== false;
  return entry.type === filter;
}

function formatEntryLabel(entry: TreeEntryEnvelope): string {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const typeLabel = formatTypeLabel(entry.type);

  const detail = extractDetail(entry);
  return detail ? `${time} ${typeLabel} ${detail}` : `${time} ${typeLabel}`;
}

const TYPE_LABELS: Record<string, string> = {
  'session-start': '[START]',
  'plan-step': '[PLAN]',
  'agent-invocation': '[AGENT]',
  'recovery-decision': '[RECOVERY]',
  'file-state': '[FILE]',
  'cost-checkpoint': '[COST]',
  'branch-summary': '[SUMMARY]',
};

function formatTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? `[${type.toUpperCase()}]`;
}

function extractDetail(entry: TreeEntryEnvelope): string {
  if (entry.payload === null || entry.payload === undefined) return '';
  if (typeof entry.payload !== 'object') return '';
  const obj = entry.payload as Record<string, unknown>;

  if ('title' in obj && typeof obj.title === 'string') return obj.title;
  if ('path' in obj && typeof obj.path === 'string') return obj.path;
  if ('message' in obj && typeof obj.message === 'string') return obj.message.slice(0, 60);
  if ('feature' in obj && typeof obj.feature === 'string') return obj.feature;
  if ('role' in obj && typeof obj.role === 'string') {
    const status = 'status' in obj && typeof obj.status === 'string' ? ` (${obj.status})` : '';
    return `${obj.role}${status}`;
  }
  return '';
}

export function getBranchPointIds(tree: SessionTree): EntryId[] {
  const branchPoints: EntryId[] = [];
  for (const [parentId, childIds] of tree.children) {
    if (parentId !== null && childIds.length > 1) {
      branchPoints.push(parentId);
    }
  }
  return branchPoints;
}
