import { describe, it, expect } from 'vitest';
import {
  createEmptyTree,
  appendEntry,
  branchFrom,
  pathToRoot,
  activePath,
  childrenOf,
  isOnActivePath,
} from './store.js';
import { entryId } from './schemas.js';

describe('createEmptyTree', () => {
  it('creates a tree with a single root entry', () => {
    const tree = createEmptyTree(1000);
    expect(tree.entries.size).toBe(1);
    expect(tree.meta.entryCount).toBe(1);
    expect(tree.meta.branchCount).toBe(0);
  });

  it('sets the root as the leaf', () => {
    const tree = createEmptyTree(1000);
    expect(tree.meta.leafId).toBe(entryId('E0001'));
  });

  it('uses the provided timestamp for createdAt and updatedAt', () => {
    const tree = createEmptyTree(5000);
    expect(tree.meta.createdAt).toBe(5000);
    expect(tree.meta.updatedAt).toBe(5000);
  });

  it('creates root with correct properties', () => {
    const tree = createEmptyTree(1000);
    const root = tree.entries.get(entryId('E0001'));
    expect(root).toBeDefined();
    expect(root!.type).toBe('session-start');
    expect(root!.parentId).toBeNull();
    expect(root!.display).toBe(true);
  });

  it('registers root under null parent in children map', () => {
    const tree = createEmptyTree(1000);
    const rootChildren = tree.children.get(null);
    expect(rootChildren).toEqual([entryId('E0001')]);
  });
});

describe('appendEntry', () => {
  it('adds an entry to the tree', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: { text: 'hello' },
      timestamp: 2000,
    });
    expect(result.entry.type).toBe('message');
    expect(result.tree.entries.size).toBe(2);
  });

  it('links the new entry to the current leaf', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    expect(result.entry.parentId).toBe(entryId('E0001'));
  });

  it('updates the leaf to the new entry', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    expect(result.tree.meta.leafId).toBe(result.entry.id);
  });

  it('increments entryCount', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    expect(result.tree.meta.entryCount).toBe(2);
  });

  it('does not increment branchCount on append', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    expect(result.tree.meta.branchCount).toBe(0);
  });

  it('updates updatedAt timestamp', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 5000,
    });
    expect(result.tree.meta.updatedAt).toBe(5000);
  });

  it('preserves createdAt', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 5000,
    });
    expect(result.tree.meta.createdAt).toBe(1000);
  });

  it('includes display when provided', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
      display: false,
    });
    expect(result.entry.display).toBe(false);
  });

  it('omits display when not provided', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    expect(result.entry.display).toBeUndefined();
  });

  it('adds the new entry to its parent children list', () => {
    const tree = createEmptyTree(1000);
    const result = appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    const children = result.tree.children.get(entryId('E0001'));
    expect(children).toContain(result.entry.id);
  });

  it('does not mutate the original tree', () => {
    const tree = createEmptyTree(1000);
    appendEntry(tree, {
      type: 'message',
      payload: {},
      timestamp: 2000,
    });
    expect(tree.entries.size).toBe(1);
    expect(tree.meta.entryCount).toBe(1);
  });
});

describe('branchFrom', () => {
  it('throws when branching from an unknown entry', () => {
    const tree = createEmptyTree(1000);
    expect(() =>
      branchFrom(tree, {
        fromId: entryId('E9999'),
        type: 'fork',
        payload: {},
        timestamp: 2000,
      }),
    ).toThrow('Cannot branch from unknown entry');
  });

  it('creates a branch from the specified entry', () => {
    const tree = createEmptyTree(1000);
    const result = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 2000,
    });
    expect(result.entry.parentId).toBe(entryId('E0001'));
  });

  it('increments branchCount', () => {
    const tree = createEmptyTree(1000);
    const result = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 2000,
    });
    expect(result.tree.meta.branchCount).toBe(1);
  });

  it('increments entryCount', () => {
    const tree = createEmptyTree(1000);
    const result = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 2000,
    });
    expect(result.tree.meta.entryCount).toBe(2);
  });

  it('updates leaf to the branched entry', () => {
    const tree = createEmptyTree(1000);
    const result = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 2000,
    });
    expect(result.tree.meta.leafId).toBe(result.entry.id);
  });

  it('adds branched entry to parent children list', () => {
    const tree = createEmptyTree(1000);
    const result = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 2000,
    });
    const children = result.tree.children.get(entryId('E0001'));
    expect(children).toContain(result.entry.id);
  });

  it('does not mutate the original tree', () => {
    const tree = createEmptyTree(1000);
    branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 2000,
    });
    expect(tree.entries.size).toBe(1);
    expect(tree.meta.branchCount).toBe(0);
  });
});

describe('pathToRoot', () => {
  it('returns entries from leaf to root for a linear tree', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const r2 = appendEntry(tree, { type: 'b', payload: {}, timestamp: 3000 });
    tree = r2.tree;

    const path = pathToRoot(tree, r2.entry.id);
    expect(path).toHaveLength(3);
    expect(path[0]!.id).toBe(r2.entry.id);
    expect(path[1]!.id).toBe(r1.entry.id);
    expect(path[2]!.id).toBe(entryId('E0001'));
  });

  it('returns just the root for root id', () => {
    const tree = createEmptyTree(1000);
    const path = pathToRoot(tree, entryId('E0001'));
    expect(path).toHaveLength(1);
    expect(path[0]!.id).toBe(entryId('E0001'));
  });

  it('stops at missing entries', () => {
    const tree = createEmptyTree(1000);
    const path = pathToRoot(tree, entryId('E9999'));
    expect(path).toHaveLength(0);
  });
});

describe('activePath', () => {
  it('returns the path from leaf to root', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    const path = activePath(tree);
    expect(path).toHaveLength(2);
    expect(path[0]!.id).toBe(r1.entry.id);
    expect(path[1]!.id).toBe(entryId('E0001'));
  });
});

describe('childrenOf', () => {
  it('returns children of an entry', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const r2 = appendEntry(tree, { type: 'b', payload: {}, timestamp: 3000 });
    tree = r2.tree;

    const children = childrenOf(tree, r1.entry.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.id).toBe(r2.entry.id);
  });

  it('returns empty array for leaf entries', () => {
    const tree = createEmptyTree(1000);
    const children = childrenOf(tree, entryId('E0001'));
    expect(children).toEqual([]);
  });

  it('returns multiple children for branched entries', () => {
    let tree = createEmptyTree(1000);
    const r1 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork1',
      payload: {},
      timestamp: 2000,
    });
    tree = r1.tree;
    const r2 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork2',
      payload: {},
      timestamp: 3000,
    });
    tree = r2.tree;

    const children = childrenOf(tree, entryId('E0001'));
    expect(children).toHaveLength(2);
  });
});

describe('isOnActivePath', () => {
  it('returns true for entries on the active path', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'a', payload: {}, timestamp: 2000 });
    tree = r1.tree;

    expect(isOnActivePath(tree, entryId('E0001'))).toBe(true);
    expect(isOnActivePath(tree, r1.entry.id)).toBe(true);
  });

  it('returns false for entries not on the active path', () => {
    let tree = createEmptyTree(1000);
    const r1 = appendEntry(tree, { type: 'main', payload: {}, timestamp: 2000 });
    tree = r1.tree;
    const r2 = branchFrom(tree, {
      fromId: entryId('E0001'),
      type: 'fork',
      payload: {},
      timestamp: 3000,
    });
    tree = r2.tree;
    const r3 = appendEntry(tree, { type: 'main', payload: {}, timestamp: 4000 });
    tree = r3.tree;

    expect(isOnActivePath(tree, r1.entry.id)).toBe(false);
  });
});
