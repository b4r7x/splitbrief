import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTaskComplete, makeTaskStart } from '#testing/helpers/events/task.js';
import {
  makeBusRecorder,
  makeWctx,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { taskId } from '../../core/schemas/task.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { loadEvents } from '../../stores/workflow/actions/load.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { selectRunningBrief, selectTaskListView, tasksStore } from '../../stores/workflow/tasks.js';
import { readRunEvents } from '../events/replay.js';
import { createJsonlSink } from '../events/sinks/jsonl.js';
import { publishTasksPlanned } from './events.js';
import { applyTriage, startFixCycle } from './triage.js';

const dirs: string[] = [];
afterEach(() => {
  resetWorkflow();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('review fix task order through the engine and stores', () => {
  it.each(['task', 'final'] as const)(
    'keeps the %s review order in the live store and the persisted replay',
    async (scope) => {
      resetWorkflow();
      const ref = setupProject(dirs);
      const passed = scope === 'task' ? 4 : 5;
      const tasks = Array.from({ length: 5 }, (_, index) =>
        makeTask({
          id: `T${String(index + 1).padStart(3, '0')}`,
          status: index < passed ? 'done' : 'pending',
        }),
      );
      const state = makeImplState(tasks, {
        phase: scope === 'task' ? 'implementing' : 'final-review',
        currentTaskIndex: passed,
      });
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      const unsubscribers = [bus.subscribe(createJsonlSink(ref)), bus.subscribe(addEvent)];
      try {
        publishTasksPlanned({ bus, phase: state.phase }, tasks);
        for (const [index, task] of tasks.slice(0, passed).entries()) {
          bus.publish(makeTaskStart({ taskId: task.id, title: task.title, index, total: 5 }));
          bus.publish(makeTaskComplete({ taskId: task.id, title: task.title }));
        }
        const wctx = makeWctx({ ...ref, bus });
        const inserted = applyTriage(
          { ...ref, workspaceDir: ref.projectDir, metadata: TEST_METADATA },
          state,
          undefined,
          [],
          {
            fixTasks: ['T006', 'T007'].map((id) => ({
              ...makeTaskSpec({ id }),
              findingIds: [],
            })),
            rejected: [],
            verify: [],
            ask: null,
          },
          undefined,
          scope === 'task' ? taskId('T004') : undefined,
        );
        const started = startFixCycle({
          wctx,
          state: inserted.state,
          setTrackedState: vi.fn(),
          taskIds: inserted.tasks.map((task) => task.id),
        });
        const order =
          scope === 'task'
            ? ['T001', 'T002', 'T003', 'T004', 'T006', 'T007', 'T005']
            : ['T001', 'T002', 'T003', 'T004', 'T005', 'T006', 'T007'];
        expect(tasksStore.get().tasks.map((task) => task.id)).toEqual(order);
        expect(loadState(ref)?.tasks.map((task) => task.id)).toEqual(order);
        const cycleIndex = events.findIndex((event) => event.type === 'review_fix_started');
        expect(events[cycleIndex - 1]).toMatchObject({
          type: 'tasks_planned',
          total: 7,
          tasks: order.map((id, index) => ({ id, index })),
        });
        bus.publish(
          makeTaskStart({
            taskId: taskId('T006'),
            index: started.currentTaskIndex,
            total: 7,
          }),
        );
        expect(selectRunningBrief(tasksStore.get(), started.phase)).toMatchObject({
          current: { id: 'T006' },
          next: { id: 'T007' },
        });
        expect(selectTaskListView(tasksStore.get())).toMatchObject({ passed, total: 7 });
        const live = tasksStore.get();
        const replay = await readRunEvents(ref);
        expect(replay.diagnostics.skipped).toBe(0);
        loadEvents(replay.events);
        expect(tasksStore.get()).toEqual(live);
      } finally {
        for (const unsubscribe of unsubscribers) unsubscribe();
      }
    },
  );
});
