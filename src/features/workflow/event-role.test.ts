import { describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { getGutterRole } from './event-role.js';

describe('getGutterRole', () => {
  it('maps renderable workflow events to their conversation gutter role', () => {
    const planningEvent: EngineEvent = { type: 'planner_status', ts: 0, phase: 'planning', status: 'running' };
    const implementingEvent: EngineEvent = { type: 'planner_status', ts: 0, phase: 'implementing', status: 'running' };
    const taskStarted: EngineEvent = {
      type: 'task_started',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'task',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'modify',
    };
    const validate: EngineEvent = {
      type: 'validate',
      ts: 0,
      phase: 'implementing',
      taskId: taskId('T001'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    };
    const warning: EngineEvent = { type: 'warning', ts: 0, phase: 'implementing', message: 'heads up' };

    expect(getGutterRole(planningEvent)).toBe('planner');
    expect(getGutterRole(implementingEvent)).toBe('implementer');
    expect(getGutterRole(taskStarted)).toBe('planner');
    expect(getGutterRole(validate)).toBe('implementer');
    expect(getGutterRole(warning)).toBeNull();
  });
});
