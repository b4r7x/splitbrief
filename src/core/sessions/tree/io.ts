import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TreeMeta, TreeEntryEnvelope } from './schemas.js';
import { TreeEntryEnvelopeSchema, TreeMetaSchema } from './schemas.js';
import type { EntryId } from './schemas.js';
import type { SessionTree } from './store.js';

const TREE_JSONL = 'session-tree.jsonl';
const TREE_META = 'tree-meta.json';

export function treeJsonlPath(sessionDir: string): string {
  return join(sessionDir, TREE_JSONL);
}

export function treeMetaPath(sessionDir: string): string {
  return join(sessionDir, TREE_META);
}

export function appendTreeEntry(sessionDir: string, entry: TreeEntryEnvelope): void {
  const filePath = treeJsonlPath(sessionDir);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

export function writeTreeMeta(sessionDir: string, meta: TreeMeta): void {
  const filePath = treeMetaPath(sessionDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(meta) + '\n');
  renameSync(tmpPath, filePath);
}

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

function countBranches(children: Map<EntryId | null, EntryId[]>): number {
  let count = 0;
  for (const [, childList] of children) {
    if (childList.length > 1) count += childList.length - 1;
  }
  return count;
}

function parseEntryNumber(id: EntryId): number {
  const match = id.match(/^E(\d+)$/);
  return match ? parseInt(match[1]!, 10) : 0;
}

function maxEntryCount(entries: TreeEntryEnvelope[]): number {
  let max = 0;
  for (const entry of entries) {
    const num = parseEntryNumber(entry.id);
    if (num > max) max = num;
  }
  return max;
}

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

  const maxCount = maxEntryCount(entries);
  const lastEntry = entries[entries.length - 1]!;

  const resolvedLeafId = meta && entryMap.has(meta.leafId) ? meta.leafId : lastEntry.id;

  const resolvedMeta: TreeMeta = meta && entryMap.has(meta.leafId)
    ? meta
    : {
        leafId: resolvedLeafId,
        entryCount: maxCount,
        branchCount: countBranches(childMap),
        createdAt: entries[0]!.timestamp,
        updatedAt: lastEntry.timestamp,
      };

  return { entries: entryMap, children: childMap, meta: resolvedMeta };
}

export function persistAppend(sessionDir: string, entry: TreeEntryEnvelope, meta: TreeMeta): void {
  appendTreeEntry(sessionDir, entry);
  writeTreeMeta(sessionDir, meta);
}

export function persistBranch(sessionDir: string, entry: TreeEntryEnvelope, meta: TreeMeta): void {
  appendTreeEntry(sessionDir, entry);
  writeTreeMeta(sessionDir, meta);
}
