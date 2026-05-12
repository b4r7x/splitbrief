import { useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionTree } from '../../core/sessions/tree/store.js';
import { TreeNode } from './tree-node.js';
import { formatTree, getBranchPointIds } from './format.js';
import {
  createTreeViewState,
  toggleExpanded,
  setFilter,
  selectNode,
  expandAll,
  collapseAll,
  type TreeViewState,
} from './tree-store.js';

interface TreeViewProps {
  tree: SessionTree;
  maxHeight?: number;
}

export function TreeView({ tree, maxHeight = 20 }: TreeViewProps): ReactElement {
  const [viewState, setViewState] = useState<TreeViewState>(createTreeViewState);

  const lines = formatTree(tree, viewState);
  const selectedIndex = viewState.selectedNodeId
    ? lines.findIndex(l => l.id === viewState.selectedNodeId)
    : 0;

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      const newIndex = Math.max(0, selectedIndex - 1);
      const target = lines[newIndex];
      if (target) setViewState(s => selectNode(s, target.id));
    }
    if (key.downArrow || input === 'j') {
      const newIndex = Math.min(lines.length - 1, selectedIndex + 1);
      const target = lines[newIndex];
      if (target) setViewState(s => selectNode(s, target.id));
    }
    if (key.return || input === ' ') {
      const id = viewState.selectedNodeId;
      if (id) setViewState(s => toggleExpanded(s, id));
    }
    if (input === 'e') {
      setViewState(s => expandAll(s, getBranchPointIds(tree)));
    }
    if (input === 'c') {
      setViewState(s => collapseAll(s));
    }
    if (input === 'a') {
      setViewState(s => setFilter(s, 'all'));
    }
    if (input === 'd') {
      setViewState(s => setFilter(s, 'displayable'));
    }
    if (input === 'r') {
      setViewState(s => setFilter(s, 'recovery-decision'));
    }
    if (input === 'f') {
      setViewState(s => setFilter(s, 'file-state'));
    }
  });

  const visibleLines = lines.slice(
    Math.max(0, selectedIndex - maxHeight + 5),
    Math.max(maxHeight, selectedIndex + 5),
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Session Tree</Text>
        <Text dimColor> ({tree.meta.entryCount} entries, {tree.meta.branchCount} branches)</Text>
        <Text dimColor> filter: {viewState.filter}</Text>
      </Box>
      <Box flexDirection="column">
        {visibleLines.map(line => (
          <TreeNode
            key={line.id}
            line={line}
            isSelected={line.id === viewState.selectedNodeId}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  ⏎ toggle  e/c expand/collapse all  a/d/r/f filter</Text>
      </Box>
    </Box>
  );
}
