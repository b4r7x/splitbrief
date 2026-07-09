import { beforeEach, describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import {
  type EventBlockCacheKey,
  getCachedActivityBatchBlock,
  getCachedEventRowBlock,
  rememberActivityBatchBlock,
  rememberEventRowBlock,
  resetEventBlockCache,
} from './block-cache.js';
import type { ConversationRowBlock } from './types.js';

function plannerText(index: number): EngineEventOf<'planner_text'> {
  return { type: 'planner_text', ts: index, phase: 'planning', text: `event ${index}` };
}

function taskStarted(): EngineEventOf<'task_started'> {
  return {
    type: 'task_started',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Route narrow task',
    index: 0,
    total: 1,
    file: 'src/app.ts',
    action: 'modify',
  };
}

function implementerGenerateRunning(): EngineEventOf<'implementer_generate_running'> {
  return {
    type: 'implementer_generate_running',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    file: 'src/app.ts',
  };
}

function activityEvent(sequence: number): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: 1_000 + sequence,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'xhigh',
    attempt: 0,
    sequence,
    activityId: `activity-${sequence}`,
    stage: 'completed',
    kind: 'command',
    label: 'ran command',
    target: 'npm test',
    redacted: false,
  };
}

function rowBlock(key: string): ConversationRowBlock {
  return { key, rowCount: 1, renderableUnits: 1, createRows: () => [] };
}

function eventKey(overrides?: Partial<EventBlockCacheKey>): EventBlockCacheKey {
  return {
    width: 80,
    viewportRows: 20,
    expanded: false,
    keyPrefix: '0',
    dedupTitle: undefined,
    ...overrides,
  };
}

function batchKey(
  overrides?: Partial<{ batchKey: string; count: number; width: number; expanded: boolean }>,
): { batchKey: string; count: number; width: number; expanded: boolean } {
  return { batchKey: 'activity-0-call-1', count: 3, width: 80, expanded: false, ...overrides };
}

describe('event row block cache', () => {
  beforeEach(() => {
    resetEventBlockCache();
  });

  it('reuses blocks by event identity', () => {
    const event = plannerText(1);
    const block = rowBlock('event-1');
    rememberEventRowBlock(event, eventKey(), block);

    // A rebuild constructs a fresh key object; equal fields must still hit.
    expect(getCachedEventRowBlock(event, eventKey())).toBe(block);
  });

  it('misses for a re-allocated event with identical content', () => {
    const event = plannerText(1);
    rememberEventRowBlock(event, eventKey(), rowBlock('event-1'));

    expect(getCachedEventRowBlock({ ...event }, eventKey())).toBeUndefined();
  });

  it.each([
    ['width', eventKey({ width: 60 })],
    ['viewportRows', eventKey({ viewportRows: 30 })],
    ['expanded', eventKey({ expanded: true })],
    ['keyPrefix', eventKey({ keyPrefix: '7' })],
    ['dedupTitle', eventKey({ dedupTitle: 'add markdown links' })],
  ] as const)('misses when %s changes for the same event object', (_field, changedKey) => {
    const event = plannerText(1);
    rememberEventRowBlock(event, eventKey(), rowBlock('event-1'));

    expect(getCachedEventRowBlock(event, changedKey)).toBeUndefined();
  });

  it('never caches task_started blocks', () => {
    const event = taskStarted();
    rememberEventRowBlock(event, eventKey(), rowBlock('task-header'));

    expect(getCachedEventRowBlock(event, eventKey())).toBeUndefined();
  });

  it('never caches implementer_generate_running blocks', () => {
    const event = implementerGenerateRunning();
    rememberEventRowBlock(event, eventKey(), rowBlock('running-preview'));

    expect(getCachedEventRowBlock(event, eventKey())).toBeUndefined();
  });

  it('remembers null as a cached "no block", distinct from a miss', () => {
    const event = plannerText(1);
    rememberEventRowBlock(event, eventKey(), null);

    expect(getCachedEventRowBlock(event, eventKey())).toBeNull();
  });

  it('drops event and batch entries on reset', () => {
    const event = plannerText(1);
    const lastEvent = activityEvent(2);
    rememberEventRowBlock(event, eventKey(), rowBlock('event-1'));
    rememberActivityBatchBlock(lastEvent, batchKey(), rowBlock('batch'));

    resetEventBlockCache();

    expect(getCachedEventRowBlock(event, eventKey())).toBeUndefined();
    expect(getCachedActivityBatchBlock(lastEvent, batchKey())).toBeUndefined();
  });
});

describe('activity batch block cache', () => {
  beforeEach(() => {
    resetEventBlockCache();
  });

  it('reuses batch blocks by last-event identity', () => {
    const lastEvent = activityEvent(3);
    const block = rowBlock('batch');
    rememberActivityBatchBlock(lastEvent, batchKey(), block);

    expect(getCachedActivityBatchBlock(lastEvent, batchKey())).toBe(block);
  });

  it.each([
    ['batchKey', batchKey({ batchKey: 'activity-9-call-2' })],
    ['count', batchKey({ count: 4 })],
    ['width', batchKey({ width: 60 })],
    ['expanded', batchKey({ expanded: true })],
  ] as const)('misses when batch %s changes for the same last event', (_field, changedKey) => {
    const lastEvent = activityEvent(3);
    rememberActivityBatchBlock(lastEvent, batchKey(), rowBlock('batch'));

    expect(getCachedActivityBatchBlock(lastEvent, changedKey)).toBeUndefined();
  });

  it('remembers null batch blocks, distinct from a miss', () => {
    const lastEvent = activityEvent(3);
    rememberActivityBatchBlock(lastEvent, batchKey(), null);

    expect(getCachedActivityBatchBlock(lastEvent, batchKey())).toBeNull();
  });
});
