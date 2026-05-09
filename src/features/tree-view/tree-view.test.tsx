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
  it('renders the session summary, visible entries, active marker, and navigation help', async () => {
    const tree = buildSampleTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('Session Tree');
    expect(frame).toContain('3 entries');
    expect(frame).toContain('0 branches');
    expect(frame).toContain('filter: displayable');
    expect(frame).toContain('[START]');
    expect(frame).toContain('Step 1');
    expect(frame).toContain('app.ts');
    expect(frame).toContain('●');
    expect(frame).toContain('navigate');
    instance.unmount();
  });

  it('expands and collapses branched sessions from the keyboard', async () => {
    const tree = buildBranchedTree();
    const instance = render(<TreeView tree={tree} maxHeight={10} />);
    await tick(20);
    const collapsedFrame = instance.lastFrame() ?? '';
    expect(collapsedFrame).toContain('4 entries');
    expect(collapsedFrame).toContain('2 branches');
    expect(collapsedFrame).toContain('[+]');

    instance.stdin.write('e');
    await tick(20);

    const expandedFrame = instance.lastFrame() ?? '';
    expect(expandedFrame).toContain('[-]');
    expect(expandedFrame).toContain('Branch A');
    expect(expandedFrame).toContain('Branch B');

    instance.stdin.write('c');
    await tick(20);

    expect(instance.lastFrame() ?? '').toContain('[+]');
    instance.unmount();
  });
});
