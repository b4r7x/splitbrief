import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { tick } from '#testing/helpers/ink.js';
import {
  createEmptyTree,
  appendEntry,
  branchFrom,
} from '../../core/sessions/tree/store.js';
import { entryId } from '../../core/sessions/tree/schemas.js';
import { TreeView } from './tree-view.js';

function buildSampleTree() {
  let tree = createEmptyTree(1000);
  const r1 = appendEntry(tree, {
    type: 'plan-step',
    payload: { title: 'Step 1', taskId: 'T1', file: 'f.ts', action: 'create', description: 'd', index: 0, total: 1 },
    timestamp: 2000,
  });
  tree = r1.tree;
  const r2 = appendEntry(tree, {
    type: 'file-state',
    payload: { path: 'app.ts', action: 'created' },
    timestamp: 3000,
  });
  tree = r2.tree;
  return tree;
}

function buildBranchedTree() {
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
  const r3 = appendEntry(tree, {
    type: 'file-state',
    payload: { path: 'branch-b-file.ts', action: 'created' },
    timestamp: 4000,
  });
  tree = r3.tree;
  return tree;
}

describe('TreeView', () => {
  it('renders header with entry and branch counts', async () => {
    const tree = buildSampleTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Session Tree');
    expect(frame).toContain('3 entries');
    expect(frame).toContain('0 branches');
    instance.unmount();
  });

  it('renders tree lines with entry labels', async () => {
    const tree = buildSampleTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[START]');
    expect(frame).toContain('Step 1');
    expect(frame).toContain('app.ts');
    instance.unmount();
  });

  it('renders branched tree with collapsed indicators', async () => {
    const tree = buildBranchedTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('[+]');
    expect(frame).toContain('2 branches');
    instance.unmount();
  });

  it('renders active-path markers (● for active)', async () => {
    const tree = buildSampleTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';
    const activeMarkers = (frame.match(/●/g) ?? []).length;
    expect(activeMarkers).toBeGreaterThanOrEqual(1);
    instance.unmount();
  });

  it('renders filter help text', async () => {
    const tree = buildSampleTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('filter: displayable');
    expect(frame).toContain('navigate');
    instance.unmount();
  });

  it('renders entry and branch counts in header', async () => {
    const tree = buildBranchedTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('4 entries');
    expect(frame).toContain('2 branches');
    instance.unmount();
  });
});