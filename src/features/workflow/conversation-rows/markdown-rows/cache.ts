import type {
  ActiveMarkdownRowsProjectionKeys,
  MarkdownConversationRowsIdentityInput,
  MarkdownRowsCacheEntry,
} from './types.js';

const MAX_MARKDOWN_ROW_CACHE_ENTRIES = 24;

const markdownRowsCache = new Map<string, MarkdownRowsCacheEntry>();
let activeMarkdownRowsProjectionKeys: ActiveMarkdownRowsProjectionKeys | null = null;

export function getMarkdownRowsCacheEntry(key: string): MarkdownRowsCacheEntry | undefined {
  return markdownRowsCache.get(key);
}

export function rememberMarkdownRows(key: string, entry: MarkdownRowsCacheEntry): void {
  if (markdownRowsCache.has(key)) markdownRowsCache.delete(key);
  markdownRowsCache.set(key, entry);
  trimMarkdownRowsCache(key);
}

export function resetMarkdownRowsCache(): void {
  markdownRowsCache.clear();
}

export function markdownRowsIdentityKey(input: MarkdownConversationRowsIdentityInput): string {
  return [input.keyPrefix, input.width].join('\u0001');
}

export function markdownConversationRowsCacheKey(
  input: MarkdownConversationRowsIdentityInput,
): string {
  return markdownRowsIdentityKey(input);
}

export function beginMarkdownConversationRowsProjectionPass(
  activeKeys: Iterable<string>,
): () => void {
  const previous = activeMarkdownRowsProjectionKeys;
  const ordered = [...(previous?.ordered ?? [])];
  const set = new Set(previous?.set ?? []);
  for (const key of activeKeys) {
    if (set.has(key)) continue;
    set.add(key);
    ordered.push(key);
  }
  activeMarkdownRowsProjectionKeys = {
    ordered,
    set,
    ranks: markdownRowsProjectionKeyRanks(ordered),
  };
  return () => {
    activeMarkdownRowsProjectionKeys = previous;
  };
}

function trimMarkdownRowsCache(insertedKey: string): void {
  while (markdownRowsCache.size > MAX_MARKDOWN_ROW_CACHE_ENTRIES) {
    const oldest =
      oldestEvictableMarkdownRowsKey() ??
      oldestActiveMarkdownRowsKey() ??
      oldestMarkdownRowsKeyExcept(insertedKey) ??
      insertedKey;
    markdownRowsCache.delete(oldest);
  }
}

function oldestEvictableMarkdownRowsKey(): string | undefined {
  for (const key of markdownRowsCache.keys()) {
    if (activeMarkdownRowsProjectionKeys?.set.has(key)) continue;
    return key;
  }
  return undefined;
}

function oldestActiveMarkdownRowsKey(): string | undefined {
  const active = activeMarkdownRowsProjectionKeys;
  if (active === null) return undefined;

  let oldestKey: string | undefined;
  let oldestRank = Number.POSITIVE_INFINITY;
  for (const key of markdownRowsCache.keys()) {
    const rank = active.ranks.get(key);
    if (rank === undefined || rank >= oldestRank) continue;
    oldestRank = rank;
    oldestKey = key;
  }
  return oldestKey;
}

function oldestMarkdownRowsKeyExcept(retainedKey: string): string | undefined {
  for (const key of markdownRowsCache.keys()) {
    if (key !== retainedKey) return key;
  }
  return undefined;
}

function markdownRowsProjectionKeyRanks(keys: readonly string[]): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const [rank, key] of keys.entries()) ranks.set(key, rank);
  return ranks;
}
