import { describe, it, expect } from 'vitest';
import { parseLegacyWorkflowState } from './legacy-state.js';
import { mapV3StateToV4 } from './map-v3.js';
import type { NormalBriefRecoveryV1 } from '../../schemas/brief-recovery/document.js';
import type { QueuedMessage } from '../../schemas/workflow.js';
import { makeLegacyV3State } from '#testing/helpers/factories/workflow-state.js';

const SESSION_ID = '2024-01-01-test-feature';

function legacyMessage(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id,
    text: `${id} text`,
    queuedAt: '2026-08-13T10:00:00.000Z',
    phase: 'reviewing-briefs',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
    origin: 'user-input',
    ...overrides,
  };
}

function migrateLegacyQueue(messageQueue: QueuedMessage[]): {
  state: ReturnType<typeof mapV3StateToV4>;
  recovery: NormalBriefRecoveryV1;
} {
  const state = parseLegacyWorkflowState({ ...makeLegacyV3State('legacy-queue'), messageQueue });
  if (state === null) throw new Error('expected a valid v3 queue fixture');
  const migrated = mapV3StateToV4({
    ref: { projectDir: '/tmp/project', sessionId: SESSION_ID },
    state,
    briefBytes: Buffer.from('# Task Briefs\n'),
    reportBytes: Buffer.from(JSON.stringify({ version: 1, passed: true, score: 1, issues: [] })),
    ownerId: 'migration-owner',
    fence: 1,
    stateRevision: 1,
  });
  const recovery = migrated.briefRecovery;
  if (
    recovery === undefined ||
    recovery === null ||
    recovery.status === 'storage-blocked' ||
    recovery.status === 'rejected'
  ) {
    throw new Error('expected a normal migrated Brief recovery');
  }
  return { state: migrated, recovery };
}

describe('v3 queue migration', () => {
  it('keeps an empty legacy queue empty', () => {
    const migrated = migrateLegacyQueue([]);

    expect(migrated.recovery.inputs).toEqual([]);
    expect(migrated.recovery.nextInputSequence).toBe(1);
    expect(migrated.state.messageQueue).toEqual([]);
  });

  it('migrates pending user input as queued typed feedback', () => {
    const migrated = migrateLegacyQueue([legacyMessage('pending')]);

    expect(migrated.recovery.inputs).toEqual([
      expect.objectContaining({
        inputId: 'pending',
        kind: 'feedback',
        source: 'typed',
        state: 'queued',
        appliedRevision: null,
        history: [expect.objectContaining({ state: 'queued' })],
      }),
    ]);
    expect(migrated.state.messageQueue).toEqual([]);
  });

  it('preserves a native-delivered message as applied history instead of replaying it', () => {
    const migrated = migrateLegacyQueue([
      legacyMessage('delivered', {
        deliveredViaNative: true,
        nativeDeliveryState: 'delivered',
      }),
    ]);

    expect(migrated.recovery.inputs).toEqual([
      expect.objectContaining({
        inputId: 'delivered',
        kind: 'native-injection',
        source: 'native-injection',
        state: 'applied',
        appliedRevision: 1,
        history: [
          expect.objectContaining({ state: 'queued' }),
          expect.objectContaining({ state: 'applied' }),
        ],
      }),
    ]);
    expect(migrated.state.messageQueue).toEqual([]);
  });

  it('keeps only explicitly pending entries queued in a mixed legacy history', () => {
    const migrated = migrateLegacyQueue([
      legacyMessage('pending'),
      legacyMessage('drained-clarification', {
        origin: 'clarification',
        question: 'Which database?',
        drainedAt: '2026-08-13T10:01:00.000Z',
      }),
      legacyMessage('delivered', {
        deliveredViaNative: true,
        nativeDeliveryState: 'delivered',
      }),
      legacyMessage('injecting', { nativeDeliveryState: 'injecting' }),
    ]);

    expect(migrated.recovery.inputs).toEqual([
      expect.objectContaining({ inputId: 'pending', source: 'typed', state: 'queued' }),
      expect.objectContaining({
        inputId: 'drained-clarification',
        source: 'interactive',
        state: 'applied',
      }),
      expect.objectContaining({
        inputId: 'delivered',
        source: 'native-injection',
        state: 'applied',
      }),
      expect.objectContaining({
        inputId: 'injecting',
        source: 'native-injection',
        state: 'held',
      }),
    ]);
    expect(migrated.recovery.inputs.filter((input) => input.state === 'queued')).toHaveLength(1);
    expect(migrated.state.messageQueue).toEqual([]);
  });
});
