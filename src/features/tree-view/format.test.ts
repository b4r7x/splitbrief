import { describe, it, expect } from 'vitest';
import {
  createEmptyTree,
  appendEntry,
  branchFrom,
} from '../../core/sessions/tree/store.js';
import { formatTree, getBranchPointIds } from './format.js';
import { createTreeViewState, toggleExpanded, setFilter } from './tree-store.js';
import { entryId } from '../../core/sessions/tree/schemas.js';

describe('formatTree', () => {
  it('formats a single-root tree', () => {
    const tree = createEmptyTree(1000);
    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(entryId('E0001'));
    expect(lines[0]!.depth).toBe(0);
    expect(lines[0]!.isActive).toBe(true);
    expect(lines[0]!.isBranchPoint).toBe(false);
    expect(lines[0]!.label).toContain('[START]');
  });

  it('formats a linear chain with connectors', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'plan-step', payload: { title: 'Step 1', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 }, timestamp: 2000 });
    tree = r1.tree;

    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    expect(lines).toHaveLength(2);
    expect(lines[0]!.id).toBe(entryId('E0001'));
    expect(lines[1]!.id).toBe(r1.entry.id);
    expect(lines[1]!.prefix).toBe('└── ');
    expect(lines[1]!.label).toContain('Step 1');
  });

  it('hides collapsed branch children', () => {
    let tree = createEmptyTree(1000);
    const r1 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'plan-step',
      payload: { title: 'Branch A', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 2000,
    });
    tree = r1.tree;
    const r2 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'plan-step',
      payload: { title: 'Branch B', taskId: 'T2', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 3000,
    });
    tree = r2.tree;

    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.isBranchPoint).toBe(true);
    expect(lines[0]!.isCollapsed).toBe(true);
  });

  it('shows expanded branch children', () => {
    let tree = createEmptyTree(1000);
    const r1 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'plan-step',
      payload: { title: 'Branch A', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 2000,
    });
    tree = r1.tree;
    const r2 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'plan-step',
      payload: { title: 'Branch B', taskId: 'T2', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 3000,
    });
    tree = r2.tree;

    let state = createTreeViewState();
    state = toggleExpanded(state, entryId('E0001'));
    const lines = formatTree(tree, state);

    expect(lines).toHaveLength(3);
    expect(lines[1]!.prefix).toBe('├── ');
    expect(lines[2]!.prefix).toBe('└── ');
  });

  it('filters by displayable entries: hidden entries are excluded', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'plan-step', payload: { title: 'Visible', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 }, timestamp: 2000 });
    tree = r1.tree;

    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    expect(lines).toHaveLength(2);
    expect(lines[0]!.type).toBe('session-start');
    expect(lines[1]!.label).toContain('Visible');
  });

  it('filters by displayable entries: display=false entries excluded', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'agent-invocation', payload: { role: 'planner', tool: 't', phase: 'planning', status: 'completed' }, timestamp: 2000, display: false });
    tree = r1.tree;

    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.type).toBe('session-start');
  });

  it('filters by type: shows entries matching the type filter', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'plan-step', payload: { title: 'Plan', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 }, timestamp: 2000 });
    tree = r1.tree;
    const r2 = appendEntry(tree, { type: 'file-state', payload: { path: 'file.ts', action: 'created' }, timestamp: 3000 });
    tree = r2.tree;

    let state = createTreeViewState();
    state = setFilter(state, 'plan-step');
    const lines = formatTree(tree, state);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every(l => l.type === 'plan-step' || l.type === 'session-start')).toBe(true);
  });

  it('marks active path entries correctly', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'plan-step', payload: { title: 'Plan', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 }, timestamp: 2000 });
    tree = r1.tree;

    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    const rootLine = lines.find(l => l.id === entryId('E0001'));
    const planLine = lines.find(l => l.id === r1.entry.id);

    expect(rootLine!.isActive).toBe(true);
    expect(planLine!.isActive).toBe(true);
  });

  it('formats entry labels with type and detail', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'file-state', payload: { path: 'src/app.ts', action: 'created' }, timestamp: new Date('2024-01-01T12:30:00').getTime() });
    tree = r1.tree;

    const state = createTreeViewState();
    const lines = formatTree(tree, state);

    expect(lines[1]!.label).toContain('[FILE]');
    expect(lines[1]!.label).toContain('src/app.ts');
    expect(lines[1]!.label).toContain('12:30:00');
  });
});

describe('getBranchPointIds', () => {
  it('returns empty for linear tree', () => {
    const tree = createEmptyTree(1000);
    expect(getBranchPointIds(tree)).toEqual([]);
  });

  it('returns ids of nodes with multiple children', () => {
    let tree = createEmptyTree(1000);
    const r1 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'plan-step',
      payload: { title: 'A', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 2000,
    });
    tree = r1.tree;
    const r2 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'plan-step',
      payload: { title: 'B', taskId: 'T2', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
      timestamp: 3000,
    });
    tree = r2.tree;

    expect(getBranchPointIds(tree)).toEqual([entryId('E0001')]);
  });
});
