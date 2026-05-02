import type { EntryId } from '../../core/sessions/tree/schemas.js';
import type { EntryType } from '../../core/sessions/tree/entry-types.js';

export interface TreeViewState {
  expandedNodes: Set<EntryId>;
  filter: EntryType | 'all' | 'displayable';
  selectedNodeId: EntryId | null;
  scrollOffset: number;
}

export function createTreeViewState(): TreeViewState {
  return {
    expandedNodes: new Set(),
    filter: 'displayable',
    selectedNodeId: null,
    scrollOffset: 0,
  };
}

export function toggleExpanded(state: TreeViewState, nodeId: EntryId): TreeViewState {
  const expanded = new Set(state.expandedNodes);
  if (expanded.has(nodeId)) {
    expanded.delete(nodeId);
  } else {
    expanded.add(nodeId);
  }
  return { ...state, expandedNodes: expanded };
}

export function setFilter(state: TreeViewState, filter: TreeViewState['filter']): TreeViewState {
  return { ...state, filter };
}

export function selectNode(state: TreeViewState, nodeId: EntryId | null): TreeViewState {
  return { ...state, selectedNodeId: nodeId };
}

export function expandAll(state: TreeViewState, allBranchNodes: EntryId[]): TreeViewState {
  return { ...state, expandedNodes: new Set(allBranchNodes) };
}

export function collapseAll(state: TreeViewState): TreeViewState {
  return { ...state, expandedNodes: new Set() };
}
