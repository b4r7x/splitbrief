import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { EngineEventSchema } from '../../events/schema.js';
import { createContinuationHolder } from '../continuation.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';

const capture = vi.hoisted(() => ({ snapshotFails: false }));
vi.mock('../approval/file-snapshots/capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/file-snapshots/capture.js')>();
  return {
    ...actual,
    getChangedFilesSnapshot: async (...args: Parameters<typeof actual.getChangedFilesSnapshot>) => {
      if (capture.snapshotFails) throw new Error('git status exited 128');
      return actual.getChangedFilesSnapshot(...args);
    },
  };
});

afterEach(() => {
  capture.snapshotFails = false;
  cleanupTaskProjects();
});

describe('runPreTaskHooksAndPublish', () => {
  it('records the identity of the implementer that starts the task and replays it', async () => {
    const task = makeTask({ id: 'T001' });
    const { bus, events } = makeBusRecorder();
    await runPreTaskHooksAndPublish({
      wctx: makeWorkflowContext({
        bus,
        config: makeConfig({
          implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5', effort: 'high' },
        }),
      }),
      task,
      state: implementingState([task]),
      index: 0,
      totalTasks: 1,
      setTrackedState: vi.fn(),
    });
    const event = events.find((event) => event.type === 'task_started');
    expect(EngineEventSchema.parse(event)).toMatchObject({
      tool: 'codex',
      model: 'gpt-5',
      axes: ['high'],
      backendKind: 'cli',
    });
  });

  it('raises a snapshot-failed recovery when the task baseline cannot be captured', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const { bus, events } = makeBusRecorder();
    const setTrackedState = vi.fn();
    capture.snapshotFails = true;

    const result = await runPreTaskHooksAndPublish({
      wctx: makeWorkflowContext({ bus }),
      task,
      state,
      index: 0,
      totalTasks: 1,
      setTrackedState,
    });

    expect(result.proceed).toBe(false);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'snapshot-failed',
      taskId: 'T001',
      recommendedAction: 'retry-same-worker',
    });
    expect(
      events.some(
        (e) => e.type === 'error' && e.message.startsWith('Failed to capture task baseline'),
      ),
    ).toBe(true);
  });

  it("announces the brief with its lineage's attempt number and allowance", async () => {
    const task = makeTask({ id: 'T001' });
    const state = {
      ...implementingState([task]),
      lineages: {
        T001: {
          consults: 0,
          consultAllowance: 2,
          attempts: 3,
          attemptAllowance: 12,
          staleConsultedRevision: {},
          dispatchedRevision: {},
          consultRecords: [],
          replacedParents: [],
          notes: [],
        },
      },
    };
    const { bus, events } = makeBusRecorder();

    await runPreTaskHooksAndPublish({
      wctx: makeWorkflowContext({ bus }),
      task,
      state,
      index: 0,
      totalTasks: 1,
      setTrackedState: vi.fn(),
    });

    expect(events.find((e) => e.type === 'task_started')).toMatchObject({
      lineageAttempt: 4,
      attemptAllowance: 12,
    });
  });

  it('a resumed cut attempt keeps the task-start snapshot its brief began from', async () => {
    const task = makeTask({ id: 'T001' });
    const started = {
      head: 'abc123',
      files: ['src/before.ts'],
      dirtyFileContents: {},
      restoreFiles: ['src/written.ts'],
    };
    const state = {
      ...implementingState([task]),
      changedFilesBaseline: {
        head: 'abc123',
        runStartChangedFiles: [],
        fingerprints: {},
        activeTaskSnapshot: started,
      },
    };
    const continuation = createContinuationHolder({
      step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
      keepWorkspace: true,
      briefFingerprint: hashTaskBrief([task]),
    });

    const result = await runPreTaskHooksAndPublish({
      wctx: makeWorkflowContext({ continuation }),
      task,
      state,
      index: 0,
      totalTasks: 1,
      setTrackedState: vi.fn(),
    });

    expect(result.proceed && result.taskStartSnapshot).toEqual(started);
  });
});
