import { describe, expect, it } from 'vitest';
import { entryId } from './schemas.js';
import {
  activePath,
  appendEntry,
  branchFrom,
  childrenOf,
  createEmptyTree,
  isOnActivePath,
  pathToRoot,
} from './store.js';

describe('session tree store', () => {
  it('starts a session and appends entries along the active path without mutating prior trees', () => {
    const rootTree = createEmptyTree(1000);
    const first = appendEntry(rootTree, {
      type: 'message',
      payload: { text: 'hello' },
      timestamp: 2000,
      display: false,
    });
    const second = appendEntry(first.tree, {
      type: 'action',
      payload: { command: 'test' },
      timestamp: 3000,
    });

    expect(rootTree.meta).toMatchObject({
      leafId: entryId('E0001'),
      entryCount: 1,
      branchCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(first.entry).toMatchObject({
      id: entryId('E0002'),
      parentId: entryId('E0001'),
      type: 'message',
      display: false,
    });
    expect(second.tree.meta).toMatchObject({
      leafId: second.entry.id,
      entryCount: 3,
      branchCount: 0,
      createdAt: 1000,
      updatedAt: 3000,
    });
    expect(activePath(second.tree).map(entry => entry.id)).toEqual([
      second.entry.id,
      first.entry.id,
      entryId('E0001'),
    ]);
    expect(childrenOf(second.tree, first.entry.id).map(entry => entry.id)).toEqual([second.entry.id]);
  });

  it('branches from an earlier entry and makes the new branch active', () => {
    let tree = createEmptyTree(1000);
    const main = appendEntry(tree, { type: 'main', payload: {}, timestamp: 2000 });
    tree = main.tree;
    const followUp = appendEntry(tree, { type: 'follow-up', payload: {}, timestamp: 3000 });
    tree = followUp.tree;

    const branched = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'recovery',
      payload: { reason: 'retry' },
      timestamp: 4000,
    });

    expect(branched.entry.parentId).toBe(entryId('E0001'));
    expect(branched.tree.meta).toMatchObject({
      leafId: branched.entry.id,
      entryCount: 4,
      branchCount: 1,
      updatedAt: 4000,
    });
    expect(childrenOf(branched.tree, entryId('E0001')).map(entry => entry.id)).toEqual([
      main.entry.id,
      branched.entry.id,
    ]);
    expect(activePath(branched.tree).map(entry => entry.id)).toEqual([
      branched.entry.id,
      entryId('E0001'),
    ]);
    expect(isOnActivePath(branched.tree, branched.entry.id)).toBe(true);
    expect(isOnActivePath(branched.tree, main.entry.id)).toBe(false);
    expect(tree.meta.branchCount).toBe(0);
  });

  it('reports missing branch and path lookups predictably', () => {
    const tree = createEmptyTree(1000);

    expect(() =>
      branchFrom(tree, {
        fromId: entryId('E9999'),
        type: 'fork',
        payload: {},
        timestamp: 2000,
      }),
    ).toThrow('Cannot branch from unknown entry');
    expect(pathToRoot(tree, entryId('E9999'))).toEqual([]);
    expect(childrenOf(tree, entryId('E9999'))).toEqual([]);
  });
});
