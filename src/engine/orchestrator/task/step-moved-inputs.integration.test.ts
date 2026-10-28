import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { runSingleTask } from './step.js';

afterEach(() => {
  cleanupTaskProjects();
});

const SHARED = 'export const shared = 1;\n';
const EDITED_SHARED = 'export const shared = 2;\n';

describe('runSingleTask — a brief whose input files moved since planning', () => {
  it('dispatches with the current code of the moved file and asks the planner nothing', async () => {
    const { projectDir, sessionId } = setupTaskProject({ 'src/shared.ts': SHARED });
    const task = taskFromSpec(
      makeTaskSpec({
        id: 'T002',
        suggestedFiles: ['src/b.ts'],
        contextFiles: ['src/shared.ts'],
        criteria: ['C1'],
      }),
      projectDir,
    );
    const trailing = makeTask({
      id: 'T003',
      action: 'create',
      suggestedFiles: ['src/c.ts'],
      criteria: ['C1'],
    });
    const state = implementingState([task, trailing]);
    const typedCall = vi.fn();
    const planner = makePlanner({ typedCall });
    const implement = vi.fn(async (opts: ImplementerOptions) => {
      writeFileSync(join(opts.projectDir, 'src/b.ts'), 'export const b = 1;\n');
      return { success: true, output: 'done' };
    });
    const { bus, events } = makeBusRecorder();

    // Another change moved T002's context file after the plan was written.
    writeFileSync(join(projectDir, 'src/shared.ts'), EDITED_SHARED);

    const after = await runSingleTask({
      wctx: makeTaskWorkflowContext({
        projectDir,
        sessionId,
        planner,
        implementer: makeImplementer({ capabilities: { writesFiles: 'direct' }, implement }),
        callbacks: makeCallbacks().callbacks,
        bus,
      }),
      task,
      index: 0,
      totalTasks: state.tasks.length,
      state,
      taskBreakdowns: [],
      setTrackedState: () => {},
      setCurrentTask: () => {},
    });

    expect(typedCall).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'consult_answered')).toEqual([]);
    expect(after.lineages?.T002?.consultRecords ?? []).toEqual([]);
    expect(implement).toHaveBeenCalledTimes(1);
    expect(implement.mock.calls[0]?.[0].task.contextCodeByFile?.['src/shared.ts']).toBe(
      EDITED_SHARED,
    );
  });
});
