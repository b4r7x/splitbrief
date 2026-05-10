import { describe, expect, it } from 'vitest';
import { taskId } from '../../schemas/task.js';
import { entryId, type EntryId } from './schemas.js';
import {
  createAgentInvocationEntry,
  createCostCheckpointEntry,
  createFileStateEntry,
  createPlanStepEntry,
  createRecoveryDecisionEntry,
} from './entry-types.js';

const baseOpts = {
  parentId: entryId('E0001') as EntryId,
  entryCount: 2,
  timestamp: 2000,
};

describe('entry factories', () => {
  it('creates plan-step entries with the supplied envelope data', () => {
    const payload = {
      taskId: taskId('T001'),
      title: 'Add login',
      file: 'src/auth.ts',
      action: 'create' as const,
      description: 'Implement login form',
      index: 0,
      total: 3,
    };

    const entry = createPlanStepEntry(payload, baseOpts);

    expect(entry).toMatchObject({
      id: entryId('E0003'),
      parentId: entryId('E0001'),
      type: 'plan-step',
      timestamp: 2000,
      display: true,
      payload,
    });
  });

  it('honors plan-step display overrides', () => {
    const entry = createPlanStepEntry(
      { taskId: taskId('T001'), title: 'x', file: 'x.ts', action: 'create', description: 'd', index: 0, total: 1 },
      { ...baseOpts, display: false },
    );

    expect(entry.display).toBe(false);
  });

  it('uses display defaults by entry type', () => {
    expect(createAgentInvocationEntry(
      { role: 'planner', tool: 'claude-code', phase: 'planning', status: 'started' },
      baseOpts,
    ).display).toBe(false);
    expect(createRecoveryDecisionEntry(
      {
        issueId: 'i1',
        reason: 'implementation-error',
        selectedAction: 'retry-same-worker',
        availableActions: ['retry-same-worker'],
        message: 'm',
      },
      baseOpts,
    ).display).toBe(true);
    expect(createFileStateEntry(
      { path: 'src/x.ts', action: 'created' },
      baseOpts,
    ).display).toBe(false);
    expect(createCostCheckpointEntry(
      { totalCost: 1, inputTokens: 1, outputTokens: 1, phase: 'planning' },
      baseOpts,
    ).display).toBe(false);
  });

  it('allows display overrides on non-visible entries', () => {
    const entry = createAgentInvocationEntry(
      { role: 'planner', tool: 't', phase: 'planning', status: 'started' },
      { ...baseOpts, display: true },
    );

    expect(entry.display).toBe(true);
  });
});
