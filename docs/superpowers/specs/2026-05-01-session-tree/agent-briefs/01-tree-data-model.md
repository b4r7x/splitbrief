# 01 - Tree Data Model

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Create the append-only tree data model: Zod schemas for tree entries, JSONL reader/writer, `leafId` management via sidecar metadata, and core append/branch operations.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Zod 4.x for all schemas.
- Tests must verify behavior, artifacts, or filesystem effects.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/core/schemas/session-log.ts` — existing JSONL entry pattern
- `src/core/sessions/log-reader.ts` — existing JSONL streaming reader
- `src/core/sessions/io.ts` — session directory structure
- `src/core/sessions/lifecycle.ts` — session ID generation
- `src/engine/events/types.ts` — `EngineEvent` union pattern
- `docs/superpowers/specs/2026-05-01-session-tree/decisions.md` — ADR-001 through ADR-006

## Write Ownership

Primary files:

```text
src/core/sessions/tree/schemas.ts
src/core/sessions/tree/schemas.test.ts
src/core/sessions/tree/store.ts
src/core/sessions/tree/store.test.ts
src/core/sessions/tree/io.ts
src/core/sessions/tree/io.test.ts
```

Do not edit existing session files. Do not edit TUI files. Do not edit recovery files.

## Schemas

### Entry ID

```typescript
// src/core/sessions/tree/schemas.ts
import { z } from 'zod';

export const EntryIdSchema = z.string().brand<'EntryId'>();
export type EntryId = z.infer<typeof EntryIdSchema>;
export const entryId = (s: string): EntryId => EntryIdSchema.parse(s);
```

### Tree Entry Envelope

The envelope is the persisted shape. Every entry in the JSONL has this structure:

```typescript
export const TreeEntryEnvelopeSchema = z.object({
  id: EntryIdSchema,
  parentId: EntryIdSchema.nullable(),
  type: z.string(),
  timestamp: z.number(),
  payload: z.unknown(),
  display: z.boolean().optional(),
});
export type TreeEntryEnvelope = z.infer<typeof TreeEntryEnvelopeSchema>;
```

### Tree Metadata (sidecar)

```typescript
export const TreeMetaSchema = z.object({
  leafId: EntryIdSchema,
  entryCount: z.number().int().nonnegative(),
  branchCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TreeMeta = z.infer<typeof TreeMetaSchema>;
```

### Entry ID Generation

Use a monotonic counter with a prefix: `E001`, `E002`, etc. The counter is derived from `entryCount` in the metadata.

```typescript
export function nextEntryId(currentCount: number): EntryId {
  const num = currentCount + 1;
  const padded = String(num).padStart(4, '0');
  return entryId(`E${padded}`);
}
```

## In-Memory Tree Store

### Data Structure

```typescript
// src/core/sessions/tree/store.ts
import type { EntryId, TreeEntryEnvelope, TreeMeta } from './schemas.js';

export interface SessionTree {
  readonly entries: ReadonlyMap<EntryId, TreeEntryEnvelope>;
  readonly children: ReadonlyMap<EntryId | null, readonly EntryId[]>;
  readonly meta: TreeMeta;
}
```

### Factory

```typescript
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
```

### Append Operation

Append a new entry as a child of the current `leafId`. Returns the updated tree.

```typescript
export interface AppendOptions {
  type: string;
  payload: unknown;
  timestamp: number;
  display?: boolean;
}

export function appendEntry(tree: SessionTree, opts: AppendOptions): {
  tree: SessionTree;
  entry: TreeEntryEnvelope;
} {
  const id = nextEntryId(tree.meta.entryCount);
  const parentId = tree.meta.leafId;
  const entry: TreeEntryEnvelope = {
    id,
    parentId,
    type: opts.type,
    timestamp: opts.timestamp,
    payload: opts.payload,
    ...(opts.display !== undefined && { display: opts.display }),
  };

  const entries = new Map(tree.entries);
  entries.set(id, entry);

  const children = new Map(tree.children);
  const parentChildren = [...(children.get(parentId) ?? []), id];
  children.set(parentId, parentChildren);

  const meta: TreeMeta = {
    ...tree.meta,
    leafId: id,
    entryCount: tree.meta.entryCount + 1,
    updatedAt: opts.timestamp,
  };

  return { tree: { entries, children, meta }, entry };
}
```

### Branch Operation

Create a new branch starting from a given ancestor entry. This moves the `leafId` to a new entry appended under the ancestor, incrementing the branch count.

```typescript
export interface BranchOptions {
  fromId: EntryId;
  type: string;
  payload: unknown;
  timestamp: number;
  display?: boolean;
}

export function branchFrom(tree: SessionTree, opts: BranchOptions): {
  tree: SessionTree;
  entry: TreeEntryEnvelope;
} {
  if (!tree.entries.has(opts.fromId)) {
    throw new Error(`Cannot branch from unknown entry: ${opts.fromId}`);
  }

  const id = nextEntryId(tree.meta.entryCount);
  const entry: TreeEntryEnvelope = {
    id,
    parentId: opts.fromId,
    type: opts.type,
    timestamp: opts.timestamp,
    payload: opts.payload,
    ...(opts.display !== undefined && { display: opts.display }),
  };

  const entries = new Map(tree.entries);
  entries.set(id, entry);

  const children = new Map(tree.children);
  const parentChildren = [...(children.get(opts.fromId) ?? []), id];
  children.set(opts.fromId, parentChildren);

  const meta: TreeMeta = {
    ...tree.meta,
    leafId: id,
    entryCount: tree.meta.entryCount + 1,
    branchCount: tree.meta.branchCount + 1,
    updatedAt: opts.timestamp,
  };

  return { tree: { entries, children, meta }, entry };
}
```

### Path Queries

```typescript
/** Walk from an entry up to root, returning the path (leaf-first). */
export function pathToRoot(tree: SessionTree, fromId: EntryId): TreeEntryEnvelope[] {
  const path: TreeEntryEnvelope[] = [];
  let current: EntryId | null = fromId;
  while (current !== null) {
    const entry = tree.entries.get(current);
    if (!entry) break;
    path.push(entry);
    current = entry.parentId;
  }
  return path;
}

/** Get the active path: from leafId to root. */
export function activePath(tree: SessionTree): TreeEntryEnvelope[] {
  return pathToRoot(tree, tree.meta.leafId);
}

/** Get direct children of an entry. */
export function childrenOf(tree: SessionTree, entryId: EntryId): TreeEntryEnvelope[] {
  const childIds = tree.children.get(entryId) ?? [];
  return childIds.map(id => tree.entries.get(id)).filter((e): e is TreeEntryEnvelope => e !== undefined);
}

/** Check if an entry is on the active path. */
export function isOnActivePath(tree: SessionTree, id: EntryId): boolean {
  const active = activePath(tree);
  return active.some(e => e.id === id);
}
```

## JSONL I/O

### Writer

```typescript
// src/core/sessions/tree/io.ts
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { SessionTree, TreeMeta, TreeEntryEnvelope } from './schemas.js';
import { TreeEntryEnvelopeSchema, TreeMetaSchema, entryId } from './schemas.js';
import type { EntryId } from './schemas.js';

const TREE_JSONL = 'session-tree.jsonl';
const TREE_META = 'tree-meta.json';

export function treeJsonlPath(sessionDir: string): string {
  return join(sessionDir, TREE_JSONL);
}

export function treeMetaPath(sessionDir: string): string {
  return join(sessionDir, TREE_META);
}

/** Append a single entry to the JSONL file. */
export function appendTreeEntry(sessionDir: string, entry: TreeEntryEnvelope): void {
  const filePath = treeJsonlPath(sessionDir);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/** Write tree metadata atomically (write-to-temp + rename). */
export function writeTreeMeta(sessionDir: string, meta: TreeMeta): void {
  const filePath = treeMetaPath(sessionDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(meta) + '\n');
  const { renameSync } = await import('node:fs');
  renameSync(tmpPath, filePath);
}
```

**Important:** The `writeTreeMeta` function above uses dynamic import for illustration. In the actual implementation, import `renameSync` statically at the top of the file:

```typescript
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
```

And use it directly:

```typescript
export function writeTreeMeta(sessionDir: string, meta: TreeMeta): void {
  const filePath = treeMetaPath(sessionDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(meta) + '\n');
  renameSync(tmpPath, filePath);
}
```

### Reader

```typescript
/** Read tree metadata from sidecar. Returns null if missing. */
export function readTreeMeta(sessionDir: string): TreeMeta | null {
  const filePath = treeMetaPath(sessionDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    const result = TreeMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Read all entries from the JSONL file. Returns entries in append order. */
export function readTreeEntries(sessionDir: string): TreeEntryEnvelope[] {
  const filePath = treeJsonlPath(sessionDir);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const entries: TreeEntryEnvelope[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      const result = TreeEntryEnvelopeSchema.safeParse(raw);
      if (result.success) entries.push(result.data);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
```

### Reconstruction

```typescript
/** Reconstruct a SessionTree from persisted entries and metadata. */
export function reconstructTree(sessionDir: string): SessionTree | null {
  const meta = readTreeMeta(sessionDir);
  const entries = readTreeEntries(sessionDir);
  if (entries.length === 0) return null;

  const entryMap = new Map<EntryId, TreeEntryEnvelope>();
  const childMap = new Map<EntryId | null, EntryId[]>();

  for (const entry of entries) {
    entryMap.set(entry.id, entry);
    const siblings = childMap.get(entry.parentId) ?? [];
    siblings.push(entry.id);
    childMap.set(entry.parentId, siblings);
  }

  // If meta is missing, reconstruct leafId as the last entry
  const resolvedMeta: TreeMeta = meta ?? {
    leafId: entries[entries.length - 1]!.id,
    entryCount: entries.length,
    branchCount: countBranches(childMap),
    createdAt: entries[0]!.timestamp,
    updatedAt: entries[entries.length - 1]!.timestamp,
  };

  return { entries: entryMap, children: childMap, meta: resolvedMeta };
}

/** Count branch points (entries with more than one child). */
function countBranches(children: Map<EntryId | null, EntryId[]>): number {
  let count = 0;
  for (const [, childList] of children) {
    if (childList.length > 1) count += childList.length - 1;
  }
  return count;
}
```

### Persist helpers (combine append + meta write)

```typescript
/** Persist an append operation: write entry to JSONL, update meta. */
export function persistAppend(sessionDir: string, entry: TreeEntryEnvelope, meta: TreeMeta): void {
  appendTreeEntry(sessionDir, entry);
  writeTreeMeta(sessionDir, meta);
}

/** Persist a branch operation: write entry to JSONL, update meta. */
export function persistBranch(sessionDir: string, entry: TreeEntryEnvelope, meta: TreeMeta): void {
  appendTreeEntry(sessionDir, entry);
  writeTreeMeta(sessionDir, meta);
}
```

## Tests

### Schema tests (`schemas.test.ts`)

- `nextEntryId` produces correct padded IDs: `nextEntryId(0)` -> `E0001`, `nextEntryId(99)` -> `E0100`.
- `TreeEntryEnvelopeSchema` accepts valid envelopes.
- `TreeEntryEnvelopeSchema` rejects entries missing `id` or `type`.
- `TreeMetaSchema` round-trips correctly.
- `EntryIdSchema` brand works.

### Store tests (`store.test.ts`)

- `createEmptyTree` creates a tree with one root entry, `leafId` pointing to root.
- `appendEntry` adds entry as child of current leaf, advances `leafId`.
- Sequential appends form a linear chain.
- `branchFrom` creates a sibling under the specified ancestor, advances `leafId`, increments `branchCount`.
- `branchFrom` with unknown `fromId` throws.
- `pathToRoot` returns correct ancestors in leaf-first order.
- `activePath` returns path from current leaf to root.
- `isOnActivePath` returns true for entries on active path, false for abandoned branch entries.
- `childrenOf` returns direct children only.

### I/O tests (`io.test.ts`)

- `appendTreeEntry` creates file if missing, appends line.
- `writeTreeMeta` writes valid JSON, atomic rename (old file replaced).
- `readTreeMeta` returns null for missing file, parses valid file.
- `readTreeEntries` skips malformed lines, returns valid entries in order.
- `reconstructTree` rebuilds tree from persisted entries.
- `reconstructTree` handles missing meta (falls back to last entry as leaf).
- `persistAppend` writes both entry and meta.
- Round-trip: create tree, append entries, persist, reconstruct, verify structure matches.

## Validation Commands

```bash
npm test -- src/core/sessions/tree/schemas.test.ts
npm test -- src/core/sessions/tree/store.test.ts
npm test -- src/core/sessions/tree/io.test.ts
npm run typecheck
npm run lint
```

## Non-Goals

- No TUI rendering in this brief.
- No branch summarization in this brief.
- No custom entry type registry in this brief.
- No integration with existing `session.jsonl` or `state.json`.
- No migration of existing sessions to tree format.

## Expected Final Report

Report:

- files changed
- schema shapes implemented
- store operations tested
- I/O round-trip verified
- validation commands run and results
- any risks or follow-ups for downstream briefs
