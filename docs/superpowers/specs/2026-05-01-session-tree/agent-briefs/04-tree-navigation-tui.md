# 04 - Tree Navigation TUI

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.
> Depends on: briefs 01 (tree data model) and 03 (custom entry types) must be implemented first.

## Goal

Build an Ink 6.x component that renders the session tree as an ASCII tree view with active-path markers, fold/unfold for branches, and filter modes for entry types. This gives users visibility into execution topology and recovery history.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- No imperative handles.
- Ink 6.x, React 19.
- Prefer existing stores/selectors over Context bloat.
- Zod 4.x for schemas.
- Tests must verify rendered output or public state.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `docs/HOOKS.md`
- `docs/STORES.md`
- `src/core/sessions/tree/schemas.ts` — `TreeEntryEnvelope`, `EntryId`
- `src/core/sessions/tree/store.ts` — `SessionTree`, `activePath`, `childrenOf`, `isOnActivePath`
- `src/core/sessions/tree/entry-types.ts` — `ENTRY_TYPES`, payload schemas
- `src/core/sessions/tree/registry.ts` — `parseEntry`
- `src/features/summary/components/` — existing TUI component patterns
- `src/components/` — existing shared components

## Write Ownership

Primary files:

```text
src/features/tree-view/tree-view.tsx
src/features/tree-view/tree-view.test.tsx
src/features/tree-view/tree-node.tsx
src/features/tree-view/tree-store.ts
src/features/tree-view/tree-store.test.ts
src/features/tree-view/format.ts
src/features/tree-view/format.test.ts
```

Do not edit tree data model files. Do not edit other feature components. Do not edit stores outside this feature.

## Tree Store

A lightweight store managing TUI state (which nodes are expanded, current filter, scroll position):

```typescript
// src/features/tree-view/tree-store.ts
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
```

## ASCII Tree Formatting

Pure functions that convert tree data into renderable lines:

```typescript
// src/features/tree-view/format.ts
import type { SessionTree } from '../../core/sessions/tree/store.js';
import type { TreeEntryEnvelope, EntryId } from '../../core/sessions/tree/schemas.js';
import { isOnActivePath, childrenOf } from '../../core/sessions/tree/store.js';
import type { TreeViewState } from './tree-store.js';
import type { EntryType } from '../../core/sessions/tree/entry-types.js';
import { ENTRY_TYPES } from '../../core/sessions/tree/entry-types.js';

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

/** Format a tree into renderable lines respecting expand/collapse and filter state. */
export function formatTree(tree: SessionTree, viewState: TreeViewState): TreeLine[] {
  const lines: TreeLine[] = [];
  const rootChildren = tree.children.get(null) ?? [];

  for (const rootId of rootChildren) {
    const root = tree.entries.get(rootId);
    if (root) {
      formatSubtree(tree, root, 0, '', viewState, lines);
    }
  }

  return lines;
}

function formatSubtree(
  tree: SessionTree,
  entry: TreeEntryEnvelope,
  depth: number,
  prefix: string,
  viewState: TreeViewState,
  lines: TreeLine[],
): void {
  if (!passesFilter(entry, viewState.filter)) return;

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

  const visibleChildren = children.filter(c => passesFilter(c, viewState.filter));
  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i]!;
    const isLast = i === visibleChildren.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    formatSubtree(tree, child, depth + 1, connector, viewState, lines);
  }
}

function passesFilter(entry: TreeEntryEnvelope, filter: TreeViewState['filter']): boolean {
  if (filter === 'all') return true;
  if (filter === 'displayable') return entry.display !== false;
  return entry.type === filter;
}

function formatEntryLabel(entry: TreeEntryEnvelope): string {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const typeLabel = formatTypeLabel(entry.type);

  const detail = extractDetail(entry);
  return detail ? `${time} ${typeLabel} ${detail}` : `${time} ${typeLabel}`;
}

function formatTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'session-start': '[START]',
    'plan-step': '[PLAN]',
    'agent-invocation': '[AGENT]',
    'recovery-decision': '[RECOVERY]',
    'file-state': '[FILE]',
    'cost-checkpoint': '[COST]',
    'branch-summary': '[SUMMARY]',
  };
  return labels[type] ?? `[${type.toUpperCase()}]`;
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

/** Get all branch point IDs (entries with multiple children). */
export function getBranchPointIds(tree: SessionTree): EntryId[] {
  const branchPoints: EntryId[] = [];
  for (const [parentId, childIds] of tree.children) {
    if (parentId !== null && childIds.length > 1) {
      branchPoints.push(parentId);
    }
  }
  return branchPoints;
}
```

## Ink Components

### Tree Node

```tsx
// src/features/tree-view/tree-node.tsx
import React from 'react';
import { Text, Box } from 'ink';
import type { TreeLine } from './format.js';

interface TreeNodeProps {
  line: TreeLine;
  isSelected: boolean;
}

export function TreeNode({ line, isSelected }: TreeNodeProps): React.ReactElement {
  const activeMarker = line.isActive ? '●' : '○';
  const branchIndicator = line.isBranchPoint
    ? (line.isCollapsed ? ' [+]' : ' [-]')
    : '';

  const color = getNodeColor(line);

  return (
    <Box>
      <Text dimColor={!line.isActive}>
        {line.prefix}
      </Text>
      <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
        {activeMarker}
      </Text>
      <Text color={color} bold={line.isActive} dimColor={!line.isActive}>
        {' '}{line.label}{branchIndicator}
      </Text>
    </Box>
  );
}

function getNodeColor(line: TreeLine): string | undefined {
  if (line.type === 'recovery-decision') return 'yellow';
  if (line.type === 'branch-summary') return 'magenta';
  if (line.type === 'agent-invocation') return 'blue';
  if (line.type === 'cost-checkpoint') return 'green';
  if (line.type === 'file-state') return 'white';
  return undefined;
}
```

### Tree View (main component)

```tsx
// src/features/tree-view/tree-view.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionTree } from '../../core/sessions/tree/store.js';
import type { EntryId } from '../../core/sessions/tree/schemas.js';
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
import type { EntryType } from '../../core/sessions/tree/entry-types.js';

interface TreeViewProps {
  tree: SessionTree;
  maxHeight?: number;
}

export function TreeView({ tree, maxHeight = 20 }: TreeViewProps): React.ReactElement {
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
      if (viewState.selectedNodeId) {
        setViewState(s => toggleExpanded(s, viewState.selectedNodeId!));
      }
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
```

## Tests

### Format tests (`format.test.ts`)

- `formatTree` on empty tree (root only) produces one line.
- `formatTree` on linear chain produces sequential lines with correct depth.
- `formatTree` on tree with branch produces correct indentation and connectors.
- `formatTree` respects `displayable` filter (hides entries with `display: false`).
- `formatTree` respects type filter (shows only matching type).
- `formatTree` hides children of collapsed branch points.
- `formatTree` shows children of expanded branch points.
- `formatEntryLabel` includes timestamp and type label.
- `formatEntryLabel` extracts title from plan-step payloads.
- `formatEntryLabel` extracts path from file-state payloads.
- `getBranchPointIds` returns entries with multiple children.
- Active-path markers are correct for branch-then-continue scenario.

### Store tests (`tree-store.test.ts`)

- `createTreeViewState` initializes with empty expanded set and `displayable` filter.
- `toggleExpanded` adds node on first call, removes on second.
- `setFilter` updates filter value.
- `selectNode` updates selected node ID.
- `expandAll` sets all provided IDs as expanded.
- `collapseAll` clears expanded set.

### Component tests (`tree-view.test.tsx`)

- `TreeView` renders tree header with entry and branch counts.
- `TreeView` renders active-path markers (`●` for active, `○` for inactive).
- `TreeNode` renders branch indicators (`[+]` for collapsed, `[-]` for expanded).
- `TreeNode` applies color for recovery-decision entries.
- `TreeNode` dims inactive path entries.
- `TreeView` renders filter help text.

## Validation Commands

```bash
npm test -- src/features/tree-view/format.test.ts
npm test -- src/features/tree-view/tree-store.test.ts
npm test -- src/features/tree-view/tree-view.test.tsx
npm run typecheck
npm run lint
```

## Non-Goals

- No real session data integration (component takes `SessionTree` prop).
- No keyboard shortcut configuration.
- No diff viewer or entry detail panel.
- No file writing or persistence from TUI.
- No integration with existing summary screen.

## Expected Final Report

Report:

- files changed
- components implemented and their props
- tree rendering verified (indentation, connectors, markers)
- filter and expand/collapse behavior tested
- validation commands run and results
- risks or follow-ups (e.g., integration with session resume flow, slash command to open tree view)
