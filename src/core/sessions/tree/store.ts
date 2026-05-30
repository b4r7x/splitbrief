import type { EntryId, TreeEntryEnvelope, TreeMeta } from './schemas.js';
import { entryId, nextEntryId } from './schemas.js';
import { error } from '../../../utils/error.js';

export const sessionTreeError = {
  unknownBranchEntry: (fromId: EntryId) =>
    error('session-tree-unknown-branch-entry', `Cannot branch from unknown entry: ${fromId}`, {
      fromId,
    }),
} as const;

export interface SessionTree {
  readonly entries: ReadonlyMap<EntryId, TreeEntryEnvelope>;
  readonly children: ReadonlyMap<EntryId | null, readonly EntryId[]>;
  readonly meta: TreeMeta;
}

export function createEmptyTree(sessionCreatedAt: number): SessionTree {
  const rootId = entryId('E0001');
  const root: TreeEntryEnvelope = {
    id: rootId,
    parentId: null,
    type: 'session-start',
    timestamp: sessionCreatedAt,
    payload: null,
    display: true,
  };
  const entries = new Map<EntryId, TreeEntryEnvelope>([[rootId, root]]);
  const children = new Map<EntryId | null, EntryId[]>([[null, [rootId]]]);
  const meta: TreeMeta = {
    leafId: rootId,
    entryCount: 1,
    branchCount: 0,
    createdAt: sessionCreatedAt,
    updatedAt: sessionCreatedAt,
  };
  return { entries, children, meta };
}

export interface AppendOptions {
  type: string;
  payload: unknown;
  timestamp: number;
  display?: boolean;
}

function insertEntry(
  tree: SessionTree,
  opts: {
    parentId: EntryId;
    type: string;
    payload: unknown;
    timestamp: number;
    display?: boolean | undefined;
    incrementBranch: boolean;
  },
): { tree: SessionTree; entry: TreeEntryEnvelope } {
  const id = nextEntryId(tree.meta.entryCount);
  const entry: TreeEntryEnvelope = {
    id,
    parentId: opts.parentId,
    type: opts.type,
    timestamp: opts.timestamp,
    payload: opts.payload,
    ...(opts.display !== undefined && { display: opts.display }),
  };

  const entries = new Map(tree.entries);
  entries.set(id, entry);

  const children = new Map(tree.children);
  children.set(opts.parentId, [...(children.get(opts.parentId) ?? []), id]);

  const meta: TreeMeta = {
    ...tree.meta,
    leafId: id,
    entryCount: tree.meta.entryCount + 1,
    ...(opts.incrementBranch && { branchCount: tree.meta.branchCount + 1 }),
    updatedAt: opts.timestamp,
  };

  return { tree: { entries, children, meta }, entry };
}

export function appendEntry(
  tree: SessionTree,
  opts: AppendOptions,
): {
  tree: SessionTree;
  entry: TreeEntryEnvelope;
} {
  return insertEntry(tree, {
    parentId: tree.meta.leafId,
    type: opts.type,
    payload: opts.payload,
    timestamp: opts.timestamp,
    display: opts.display,
    incrementBranch: false,
  });
}

export interface BranchOptions {
  fromId: EntryId;
  type: string;
  payload: unknown;
  timestamp: number;
  display?: boolean;
}

export function branchFrom(
  tree: SessionTree,
  opts: BranchOptions,
): {
  tree: SessionTree;
  entry: TreeEntryEnvelope;
} {
  if (!tree.entries.has(opts.fromId)) {
    throw sessionTreeError.unknownBranchEntry(opts.fromId);
  }

  return insertEntry(tree, {
    parentId: opts.fromId,
    type: opts.type,
    payload: opts.payload,
    timestamp: opts.timestamp,
    display: opts.display,
    incrementBranch: true,
  });
}
