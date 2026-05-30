import { describe, expect, it } from 'vitest';
import type { CostPrediction, PlannerEstimateReview } from '../../core/schemas/summary.js';
import type { TaskId } from '../../core/schemas/task.js';
import { taskId } from '../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { autoSplitOverflowTasks } from './auto-split-overflow.js';

type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;

function estimateFor(
  tasks: Array<{
    taskId: TaskId;
    contextFit: 'fits' | 'tight' | 'overflow' | 'unknown';
    contextConfidence?: DeterministicEstimate['tasks'][number]['contextConfidence'];
  }>,
): DeterministicEstimate {
  return {
    taskCount: tasks.length,
    taskFitCounts: {
      fits: tasks.filter((task) => task.contextFit === 'fits').length,
      tight: tasks.filter((task) => task.contextFit === 'tight').length,
      overflow: tasks.filter((task) => task.contextFit === 'overflow').length,
      unknown: tasks.filter((task) => task.contextFit === 'unknown').length,
    },
    contextConfidenceCounts: {
      contextExplicit: tasks.filter(
        (task) => (task.contextConfidence ?? 'context-explicit') === 'context-explicit',
      ).length,
      contextKnownCatalog: 0,
      contextCachedProvider: tasks.filter(
        (task) => task.contextConfidence === 'context-cached-provider',
      ).length,
      contextConservativeFallback: tasks.filter(
        (task) => task.contextConfidence === 'context-conservative-fallback',
      ).length,
      profileUnavailable: tasks.filter((task) => task.contextConfidence === 'profile-unavailable')
        .length,
    },
    priceConfidenceCounts: { priceKnown: tasks.length, priceUnknown: 0, profileUnavailable: 0 },
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      title: `Task ${task.taskId}`,
      estimatedPromptTokens: 1000,
      selectedProfileId: 'cheap-worker',
      contextFit: task.contextFit,
      contextConfidence: task.contextConfidence ?? 'context-explicit',
      priceConfidence: 'price-known',
      estimatedImplementerCost: 0.01,
      hypotheticalPlannerCost: 0.05,
    })),
    totals: {
      knownActualEstimate: 0.01,
      hypotheticalAllPlanner: 0.05,
      estimatedSavings: 0.04,
      unknownCostReason: [],
    },
  };
}

function splittableTask() {
  return makeTask({
    id: 'T001',
    title: 'Update parser behavior',
    description: 'Update parser behavior in src/parser.ts without changing unrelated files.',
    file: 'src/parser.ts',
    tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
    implementationSteps: [
      'Update src/parser.ts token handling.',
      'Update src/parser.ts error reporting.',
    ],
    constraints: ['Keep public parse API stable.'],
    scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
    evidence: ['Parser tests pass.'],
  });
}

describe('autoSplitOverflowTasks', () => {
  it('leaves tasks unchanged when the feature is off by default', () => {
    const task = splittableTask();
    const result = autoSplitOverflowTasks({
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'overflow' }]),
    });

    expect(result.changed).toBe(false);
    expect(result.tasks).toEqual([task]);
    expect(result.skippedSplits).toEqual([]);
  });

  it('splits an overflow task when enabled', () => {
    const task = splittableTask();
    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'overflow' }]),
    });

    expect(result.changed).toBe(true);
    expect(result.previews).toEqual([
      { parentTaskId: task.id, childTaskIds: [taskId('T002'), taskId('T003')], reason: 'overflow' },
    ]);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((child) => child.id)).toEqual([taskId('T002'), taskId('T003')]);
    expect(result.tasks.map((child) => child.file)).toEqual(['src/parser.ts', 'src/parser.ts']);
    expect(result.tasks.every((child) => child.description.includes('Parent T001 intent'))).toBe(
      true,
    );
  });

  it('does not split a task that already fits the selected worker', () => {
    const task = splittableTask();
    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'fits' }]),
    });

    expect(result.changed).toBe(false);
    expect(result.tasks).toEqual([task]);
    expect(result.skippedSplits).toEqual([]);
  });

  it('splits a tight task only when the context estimate has low confidence', () => {
    const task = splittableTask();
    const explicit = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([
        { taskId: task.id, contextFit: 'tight', contextConfidence: 'context-explicit' },
      ]),
    });
    const fallback = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([
        {
          taskId: task.id,
          contextFit: 'tight',
          contextConfidence: 'context-conservative-fallback',
        },
      ]),
    });

    expect(explicit.changed).toBe(false);
    expect(fallback.changed).toBe(true);
    expect(fallback.previews[0]).toMatchObject({
      parentTaskId: task.id,
      reason: 'tight-low-confidence',
    });
  });

  it('preserves parent acceptance criteria across child tasks', () => {
    const task = splittableTask();
    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'overflow' }]),
    });

    expect([...result.tasks.flatMap((child) => child.tests)].sort()).toEqual(
      [...task.tests].sort(),
    );
  });

  it('keeps unchanged task ids stable and rewrites removed parent dependencies to fresh child ids', () => {
    const setup = makeTask({ id: 'T001', title: 'Setup shared helper', file: 'src/setup.ts' });
    const parent = { ...splittableTask(), id: taskId('T002'), dependsOn: [setup.id] };
    const downstream = makeTask({
      id: 'T003',
      title: 'Use parser behavior',
      file: 'src/use-parser.ts',
      dependsOn: ['T002'],
    });

    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [setup, parent, downstream],
      estimate: estimateFor([
        { taskId: setup.id, contextFit: 'fits' },
        { taskId: parent.id, contextFit: 'overflow' },
        { taskId: downstream.id, contextFit: 'fits' },
      ]),
    });

    const taskById = new Map(result.tasks.map((task) => [task.id, task]));

    expect(result.changed).toBe(true);
    expect(result.previews).toEqual([
      {
        parentTaskId: parent.id,
        childTaskIds: [taskId('T004'), taskId('T005')],
        reason: 'overflow',
      },
    ]);
    expect(result.tasks.map((task) => task.id)).toEqual([
      taskId('T001'),
      taskId('T004'),
      taskId('T005'),
      taskId('T003'),
    ]);
    expect(taskById.get(setup.id)?.title).toBe('Setup shared helper');
    expect(taskById.get(downstream.id)?.title).toBe('Use parser behavior');
    expect(taskById.has(parent.id)).toBe(false);
    expect(taskById.get(taskId('T004'))?.dependsOn).toEqual([setup.id]);
    expect(taskById.get(taskId('T005'))?.dependsOn).toEqual([setup.id, taskId('T004')]);
    expect(taskById.get(downstream.id)?.dependsOn).toEqual([taskId('T004'), taskId('T005')]);
  });

  it('skips unsafe splits that would duplicate the same file ownership across too many children', () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/parser.ts',
      tests: ['case one', 'case two', 'case three'],
      implementationSteps: ['Handle case one.', 'Handle case two.', 'Handle case three.'],
    });

    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'overflow' }]),
    });

    expect(result.changed).toBe(false);
    expect(result.tasks).toEqual([task]);
    expect(result.skippedSplits[0]).toMatchObject({
      taskId: task.id,
      code: 'excessive-duplicated-ownership',
    });
  });

  it('skips file-group splits that would create too many child tasks', () => {
    const task = makeTask({
      id: 'T001',
      file: 'src/parser.ts',
      description:
        'Update src/parser.ts, src/writer.ts, src/compiler.ts, src/review.ts, and src/router.ts.',
      tests: ['all named files keep their public behavior'],
      implementationSteps: ['Apply the coordinated change to the named files.'],
    });

    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'overflow' }]),
    });

    expect(result.changed).toBe(false);
    expect(result.tasks).toEqual([task]);
    expect(result.skippedSplits[0]).toMatchObject({
      taskId: task.id,
      code: 'too-many-child-tasks',
    });
  });

  it('splits planner-review split-suggested tasks even when deterministic fit is not overflow', () => {
    const task = splittableTask();
    const plannerReview: PlannerEstimateReview = {
      extraPlannerCall: true,
      status: 'completed',
      classification: 'split-suggested',
      affectedTaskIds: [task.id],
      reason: 'Planner says this should be split before implementation.',
      recommendedUserDecision: 'Review split output.',
    };

    const result = autoSplitOverflowTasks({
      enabled: true,
      tasks: [task],
      estimate: estimateFor([{ taskId: task.id, contextFit: 'fits' }]),
      plannerReview,
    });

    expect(result.changed).toBe(true);
    expect(result.previews[0]).toMatchObject({
      parentTaskId: task.id,
      reason: 'planner-split-suggested',
    });
  });
});
