import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { checkDependencyGate } from './dependency-gate.js';

afterEach(cleanupTaskProjects);

describe('checkDependencyGate', () => {
  it('one prompt lists every dependent', async () => {
    const skipped = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], status: 'skipped' });
    const first = makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], dependsOn: ['T001'] });
    const second = makeTask({ id: 'T003', suggestedFiles: ['src/c.ts'], dependsOn: ['T001'] });
    const unrelated = makeTask({ id: 'T004', suggestedFiles: ['src/d.ts'] });
    const state = {
      ...implementingState([skipped, first, second, unrelated]),
      currentTaskIndex: 1,
    };
    const { bus, events } = makeBusRecorder();

    const gate = await checkDependencyGate({
      wctx: makeWorkflowContext({ bus }),
      state,
      setTrackedState: vi.fn(),
      task: first,
      taskIndex: 1,
    });

    expect(gate.stopped).toBe(true);
    expect(gate.state.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
      affectedTaskIds: ['T001', 'T002', 'T003'],
    });
    expect(events.filter((e) => e.type === 'recovery_prompted')).toHaveLength(1);
  });

  it('lets a task whose dependencies all succeeded through untouched', async () => {
    const done = makeTask({ id: 'T001', status: 'done' });
    const next = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const state = { ...implementingState([done, next]), currentTaskIndex: 1 };

    const gate = await checkDependencyGate({
      wctx: makeWorkflowContext(),
      state,
      setTrackedState: vi.fn(),
      task: next,
      taskIndex: 1,
    });

    expect(gate.stopped).toBe(false);
    expect(gate.state.pendingRecovery).toBeUndefined();
  });
});
