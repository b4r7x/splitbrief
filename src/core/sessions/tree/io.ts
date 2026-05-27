import { appendFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { SECURE_FILE_MODE, writeSecureFile } from '../../../lib/fs.js';
import { TreeEntryEnvelopeSchema, TreeMetaSchema, type EntryId, type TreeEntryEnvelope, type TreeMeta } from './schemas.js';
import type { SessionTree } from './store.js';
import { warnError, warnStderr } from '../../../lib/warn.js';

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
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  appendFileSync(filePath, JSON.stringify(entry) + '\n', { mode: SECURE_FILE_MODE });
  chmodSync(filePath, SECURE_FILE_MODE);
}

export function writeTreeMeta(sessionDir: string, meta: TreeMeta): void {
  const filePath = treeMetaPath(sessionDir);
  writeSecureFile(filePath, JSON.stringify(meta) + '\n');
}

export function readTreeMeta(sessionDir: string): TreeMeta | null {
  const filePath = treeMetaPath(sessionDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    const result = TreeMetaSchema.safeParse(raw);
    if (!result.success) {
      warnStderr(`Warning: invalid session tree metadata ${filePath}: ${result.error.message}`);
      return null;
    }
    return result.data;
  } catch (err) {
    warnError(`Failed to read session tree metadata ${filePath}`, err);
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
      if (result.success) {
        entries.push(result.data);
      } else {
        warnStderr(`Warning: invalid session tree entry ${filePath}: ${result.error.message}`);
      }
    } catch (err) {
      warnError(`Failed to read session tree entry ${filePath}`, err);
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
  return match ? parseInt(match[1] ?? '0', 10) : 0;
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
  const [firstEntry] = entries;
  const lastEntry = entries.at(-1);
  if (!firstEntry || !lastEntry) return null;

  const resolvedLeafId = meta && entryMap.has(meta.leafId) ? meta.leafId : lastEntry.id;

  const resolvedMeta: TreeMeta = meta && entryMap.has(meta.leafId)
    ? meta
    : {
        leafId: resolvedLeafId,
        entryCount: maxCount,
        branchCount: countBranches(childMap),
        createdAt: firstEntry.timestamp,
        updatedAt: lastEntry.timestamp,
      };

  return { entries: entryMap, children: childMap, meta: resolvedMeta };
}

export function persistAppend(sessionDir: string, entry: TreeEntryEnvelope, meta: TreeMeta): void {
  appendTreeEntry(sessionDir, entry);
  writeTreeMeta(sessionDir, meta);
}
