import type { EngineEvent } from '../../../engine/events/types.js';
import type { ConversationRowBlock } from './types.js';

export interface EventBlockCacheKey {
  width: number;
  viewportRows: number;
  expanded: boolean;
  keyPrefix: string;
  dedupTitle: string | undefined;
}

interface ActivityBatchCacheKey {
  batchKey: string;
  count: number;
  width: number;
  expanded: boolean;
}

interface CacheEntry<Key> {
  key: Key;
  block: ConversationRowBlock | null;
}

// Object identity is the change signal: mergeEvent (src/stores/workflow/events.ts) re-allocates
// every changed event and the events array, so a changed event misses here by identity and an
// evicted event's entry is GC'd with it.
let eventBlocks = new WeakMap<EngineEvent, CacheEntry<EventBlockCacheKey>>();
let activityBatchBlocks = new WeakMap<EngineEvent, CacheEntry<ActivityBatchCacheKey>>();

export function getCachedEventRowBlock(
  event: EngineEvent,
  key: EventBlockCacheKey,
): ConversationRowBlock | null | undefined {
  // implementer_generate_running blocks read per-pass streaming context (ctx.streaming) that no
  // key field captures, so a cached block would freeze a stale stream.
  if (event.type === 'task_started' || event.type === 'implementer_generate_running') {
    return undefined;
  }
  const entry = eventBlocks.get(event);
  if (entry === undefined || !sameEventKey(entry.key, key)) return undefined;
  return entry.block;
}

export function rememberEventRowBlock(
  event: EngineEvent,
  key: EventBlockCacheKey,
  block: ConversationRowBlock | null,
): void {
  if (event.type === 'task_started' || event.type === 'implementer_generate_running') return;
  eventBlocks.set(event, { key, block });
}

export function getCachedActivityBatchBlock(
  lastEvent: EngineEvent,
  key: ActivityBatchCacheKey,
): ConversationRowBlock | null | undefined {
  const entry = activityBatchBlocks.get(lastEvent);
  if (entry === undefined || !sameBatchKey(entry.key, key)) return undefined;
  return entry.block;
}

export function rememberActivityBatchBlock(
  lastEvent: EngineEvent,
  key: ActivityBatchCacheKey,
  block: ConversationRowBlock | null,
): void {
  activityBatchBlocks.set(lastEvent, { key, block });
}

export function resetEventBlockCache(): void {
  eventBlocks = new WeakMap();
  activityBatchBlocks = new WeakMap();
}

function sameEventKey(a: EventBlockCacheKey, b: EventBlockCacheKey): boolean {
  return (
    a.width === b.width &&
    a.viewportRows === b.viewportRows &&
    a.expanded === b.expanded &&
    a.keyPrefix === b.keyPrefix &&
    a.dedupTitle === b.dedupTitle
  );
}

function sameBatchKey(a: ActivityBatchCacheKey, b: ActivityBatchCacheKey): boolean {
  return (
    a.batchKey === b.batchKey &&
    a.count === b.count &&
    a.width === b.width &&
    a.expanded === b.expanded
  );
}
