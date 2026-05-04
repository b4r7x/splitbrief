import { describe, expect, it } from 'vitest';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { taskId } from '../../../../core/schemas/task.js';
import { getGutterRole } from './event-role.js';

describe('getGutterRole', () => {
  it('uses phase role for planner status events', () => {
    const planningEvent: EngineEventOf<'planner_status'> = {
      type: 'planner_status',
      ts: 1,
      phase: 'planning',
      status: 'running',
    };
    const implementingEvent: EngineEventOf<'planner_status'> = {
      ...planningEvent,
      phase: 'implementing',
    };

    expect(getGutterRole(planningEvent)).toBe('planner');
    expect(getGutterRole(implementingEvent)).toBe('implementer');
  });

  it('maps planner and implementer events to their gutter roles', () => {
    const taskStarted: EngineEventOf<'task_started'> = {
      type: 'task_started',
      ts: 1,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Task',
      index: 0,
      total: 1,
      file: 'src/app.tsx',
      action: 'modify',
    };
    const validate: EngineEventOf<'validate'> = {
      type: 'validate',
      ts: 1,
      phase: 'validating-task',
      taskId: taskId('T001'),
      status: 'running',
      passed: false,
      stages: { typecheck: false, lint: false, test: false },
    };

    expect(getGutterRole(taskStarted)).toBe('planner');
    expect(getGutterRole(validate)).toBe('implementer');
  });

  it('returns null for ungrouped status events', () => {
    const warning: EngineEventOf<'warning'> = {
      type: 'warning',
      ts: 1,
      phase: 'planning',
      message: 'heads up',
    };

    expect(getGutterRole(warning)).toBeNull();
  });
});
