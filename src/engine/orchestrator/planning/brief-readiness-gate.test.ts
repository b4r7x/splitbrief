import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { evaluateBriefReadiness, firstBriefReadinessBlockMessage } from './brief-readiness-gate.js';

function readyTask() {
  return makeTask({
    id: 'T001',
    evidence: ['proof is recorded'],
    scope: { inBounds: ['src/hello.ts'], outOfBounds: [] },
  });
}

describe('evaluateBriefReadiness', () => {
  it.each([
    [
      'overflow',
      {
        taskId: taskId('T001'),
        contextFit: 'overflow' as const,
        estimatedTokens: 50_000,
        contextLength: 8_000,
      },
      'split the task or route it to a larger worker',
    ],
    [
      'no-capable-worker',
      {
        taskId: taskId('T001'),
        contextFit: 'fits' as const,
        estimatedTokens: 500,
        routingBlockKind: 'no-capable-worker' as const,
      },
      'route a larger worker or split the task',
    ],
    [
      'stale-conflict',
      {
        taskId: taskId('T001'),
        contextFit: 'fits' as const,
        workerProfile: 'local',
        estimatedTokens: 500,
        stale: true,
      },
      'resolve the conflict or revise the brief with current code context',
    ],
    ['routing-pending', undefined, 'refresh routing readiness before approval'],
  ])('blocks %s with a next action', (kind, metadata, nextAction) => {
    const task = readyTask();
    const report = evaluateBriefReadiness([task], metadata ? [metadata] : []);

    expect(report.ok).toBe(false);
    expect(report.blocks[0]).toMatchObject({ kind, taskId: 'T001', nextAction });
    expect(firstBriefReadinessBlockMessage(report)).toContain('Next best action');
  });

  it('blocks incomplete worker routing metadata as pending', () => {
    const task = readyTask();
    const report = evaluateBriefReadiness(
      [task],
      [
        {
          taskId: task.id,
          contextFit: 'fits',
          estimatedTokens: 500,
          contextLength: 32_000,
        },
      ],
    );

    expect(report.ok).toBe(false);
    expect(report.blocks[0]).toMatchObject({
      kind: 'routing-pending',
      taskId: 'T001',
      nextAction: 'refresh routing readiness before approval',
    });
  });

  it('blocks modify tasks without current-code estimate status as pending', () => {
    const task = readyTask();
    const report = evaluateBriefReadiness(
      [{ ...task, action: 'modify' }],
      [
        {
          taskId: task.id,
          contextFit: 'fits',
          workerProfile: 'local',
          estimatedTokens: 500,
          contextLength: 32_000,
        },
      ],
    );

    expect(report.ok).toBe(false);
    expect(report.blocks[0]).toMatchObject({ kind: 'routing-pending', taskId: 'T001' });
  });

  it('passes when routing metadata is refreshed and complete', () => {
    const task = readyTask();
    const report = evaluateBriefReadiness(
      [task],
      [
        {
          taskId: task.id,
          contextFit: 'fits',
          workerProfile: 'local',
          estimatedTokens: 500,
          contextLength: 32_000,
        },
      ],
    );

    expect(report.ok).toBe(true);
    expect(report.blocks).toHaveLength(0);
  });
});
