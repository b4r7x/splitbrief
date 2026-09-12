import { describe, it, expect } from 'vitest';
import { parseLegacyWorkflowState } from './legacy-state.js';
import { mapV3StateToV4 } from './map-v3.js';
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

describe('v3 queue migration', () => {
  it('v3 reviewing-briefs state migrates without a recovery map', () => {
    const messageQueue = [legacyMessage('pending')];
    const legacy = parseLegacyWorkflowState({
      ...makeLegacyV3State('legacy-queue'),
      messageQueue,
    });
    if (legacy === null) throw new Error('expected a valid v3 state fixture');
    const migrated = mapV3StateToV4({
      ref: { projectDir: '/tmp/project', sessionId: SESSION_ID },
      state: legacy,
      stateRevision: 1,
    });
    if (migrated === null) throw new Error('expected the v3 state to migrate');
    expect(migrated.stateVersion).toBe(4);
    expect(migrated.messageQueue).toEqual(messageQueue);
    expect(migrated).not.toHaveProperty('briefRecovery');
  });
});
