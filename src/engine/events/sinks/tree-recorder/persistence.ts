import type { z } from 'zod';
import {
  TreeEntryEnvelopeSchema,
  type TreeEntryEnvelope,
} from '../../../../core/sessions/tree/schemas.js';
import type { SessionTree } from '../../../../core/sessions/tree/store.js';
import { createEmptyTree, appendEntry, branchFrom } from '../../../../core/sessions/tree/store.js';
import {
  persistAppend,
  writeTreeMeta,
  appendTreeEntry,
  reconstructTree,
} from '../../../../core/sessions/tree/io.js';
import { warnError } from '../../../../lib/warn.js';
import { protectConsumerPayload } from '../../../../core/consumer-policy.js';

export type TreeAppendResult = ReturnType<typeof appendEntry>;
export type TreeBranchResult = ReturnType<typeof branchFrom>;

export interface ProtectedAppendOptions<TPayload> {
  type: string;
  payload: TPayload;
  schema: z.ZodType<TPayload>;
  timestamp: number;
  display?: boolean | undefined;
}

export interface ProtectedBranchOptions<TPayload> extends ProtectedAppendOptions<TPayload> {
  fromId: TreeEntryEnvelope['id'];
}

export type TreePersistence = {
  getTree: () => SessionTree | null;
  setTree: (tree: SessionTree | null) => void;
  initializeTree: (ts: number) => SessionTree | null;
  commitAppendResult: (result: TreeAppendResult | TreeBranchResult | null) => boolean;
};

export function createTreePersistence(dir: string): TreePersistence {
  let tree: SessionTree | null = null;

  function persist(entry: TreeEntryEnvelope, meta: SessionTree['meta']): boolean {
    if (!tree) return false;
    const protectedEntry = protectTreeEntry(entry);
    if (protectedEntry === null) return false;
    try {
      persistAppend(dir, protectedEntry, meta);
      return true;
    } catch (err) {
      warnError('session-tree: persist failed', err);
      return false;
    }
  }

  function commitAppendResult(result: TreeAppendResult | TreeBranchResult | null): boolean {
    if (result === null) return false;
    if (!persist(result.entry, result.tree.meta)) return false;
    tree = result.tree;
    return true;
  }

  function initializeTree(ts: number): SessionTree | null {
    const existing = reconstructTree(dir);
    if (existing) {
      tree = existing;
      return existing;
    }

    const fresh = createEmptyTree(ts);
    const root = fresh.entries.get(fresh.meta.leafId);
    if (!root) return null;
    try {
      appendTreeEntry(dir, root);
      writeTreeMeta(dir, fresh.meta);
    } catch (err) {
      warnError('session-tree: initial write failed', err);
    }
    tree = fresh;
    return fresh;
  }

  return {
    getTree: () => tree,
    setTree: (next) => {
      tree = next;
    },
    initializeTree,
    commitAppendResult,
  };
}

export function appendProtectedEntry<TPayload>(
  tree: SessionTree,
  opts: ProtectedAppendOptions<TPayload>,
): TreeAppendResult | null {
  const payload = protectTreePayload(opts.type, opts.payload, opts.schema);
  if (payload === null) return null;
  return appendEntry(tree, {
    type: opts.type,
    payload,
    timestamp: opts.timestamp,
    ...(opts.display !== undefined && { display: opts.display }),
  });
}

export function branchProtectedEntry<TPayload>(
  tree: SessionTree,
  opts: ProtectedBranchOptions<TPayload>,
): TreeBranchResult | null {
  const payload = protectTreePayload(opts.type, opts.payload, opts.schema);
  if (payload === null) return null;
  return branchFrom(tree, {
    fromId: opts.fromId,
    type: opts.type,
    payload,
    timestamp: opts.timestamp,
    ...(opts.display !== undefined && { display: opts.display }),
  });
}

function protectTreePayload<TPayload>(
  entryType: string,
  payload: TPayload,
  schema: z.ZodType<TPayload>,
): TPayload | null {
  const protectedPayload = protectConsumerPayload({ context: 'tree', payload });
  if (protectedPayload.oversized) {
    warnError(`session-tree: omitted oversized ${entryType} payload`);
    return null;
  }
  const parsed = schema.safeParse(protectedPayload.payload);
  if (!parsed.success) {
    warnError(`session-tree: omitted invalid ${entryType} payload after protection`);
    return null;
  }
  return parsed.data;
}

function protectTreeEntry(entry: TreeEntryEnvelope): TreeEntryEnvelope | null {
  const protectedEntry = protectConsumerPayload({ context: 'tree', payload: entry });
  if (protectedEntry.oversized) {
    warnError(`session-tree: omitted oversized ${entry.type} entry`);
    return null;
  }
  const parsed = TreeEntryEnvelopeSchema.safeParse(protectedEntry.payload);
  if (!parsed.success) {
    warnError(`session-tree: omitted invalid ${entry.type} entry after protection`);
    return null;
  }
  return parsed.data;
}
