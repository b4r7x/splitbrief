import { describe, it, expect } from 'vitest';
import { groupEventsIntoSections } from './event-sections.js';
import type { Phase } from '../schemas/enums.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { taskId } from '../schemas/task.js';
import { makeTaskStart, makeTaskComplete } from '#testing/helpers/events/task.js';

function at(
  ts: number,
  phase: Phase,
  type: string,
  fields: Record<string, unknown> = {},
): EngineEvent {
  return {
    type,
    ts,
    phase,
    ...fields,
  } as unknown as EngineEvent;
}

describe('groupEventsIntoSections review tail', () => {
  const brief = [makeTaskStart({ ts: 1_000 }), makeTaskComplete({ ts: 2_000 })];

  it('keeps pause rows in an events section before the review section', () => {
    const events: EngineEvent[] = [
      ...brief,
      at(2_100, 'implementing', 'task_tokens', { taskId: taskId('T001') }),
      at(2_200, 'implementing', 'turn_interrupted', {
        source: 'user',
        at: 'boundary',
        step: { kind: 'review', cycle: 0 },
      }),
      at(2_300, 'implementing', 'workflow_resumed', { inProcess: true }),
      at(2_400, 'implementing', 'tasks_planned', {
        tasks: [
          {
            id: taskId('T001'),
            title: 'Test task',
            index: 0,
            file: 'src/test.ts',
            action: 'modify',
          },
        ],
        total: 1,
      }),
      at(2_500, 'implementing', 'snapshot_created', {
        snapshotId: 'snap-1',
        name: 'pre-final-review',
        fileCount: 1,
      }),
      at(2_600, 'final-review', 'full_suite', {
        status: 'running',
        id: 'K1',
        command: 'node --test',
        moment: 'plan',
      }),
      at(2_700, 'final-review', 'review_started', {
        scope: 'final',
        tool: 'codex',
        model: 'gpt-6.1-sol',
      }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections.map((section) => section.type)).toEqual([
      'completed-task',
      'events',
      'active-review',
    ]);
    expect(sections[1]?.items.map((event) => event.type)).toEqual([
      'task_tokens',
      'turn_interrupted',
      'workflow_resumed',
      'tasks_planned',
      'snapshot_created',
    ]);
    expect(sections[2]?.items.map((event) => event.type)).toEqual(['full_suite', 'review_started']);
  });

  it('keeps seat save rows in an events section before the review section', () => {
    const events: EngineEvent[] = [
      ...brief,
      at(2_100, 'implementing', 'task_tokens', { taskId: taskId('T001') }),
      at(2_200, 'implementing', 'turn_interrupted', {
        source: 'user',
        at: 'boundary',
        step: { kind: 'review', cycle: 0 },
      }),
      at(2_250, 'implementing', 'seat_switched', {
        seat: 'build',
        from: 'Claude Code CLI · Haiku 5.5',
        to: 'Claude Code CLI · Sonnet 5.5',
        cause: 'crew-changed',
        auto: false,
      }),
      at(2_300, 'implementing', 'workflow_resumed', { inProcess: true }),
      at(2_310, 'implementing', 'workflow_config', {
        plannerTool: 'claude-code',
        plannerModel: 'haiku',
        implementerTool: 'claude-code',
        implementerModel: 'sonnet',
        reviewerTool: 'codex',
        reviewerModel: 'gpt-6.1-sol',
      }),
      at(2_400, 'implementing', 'tasks_planned', {
        tasks: [
          {
            id: taskId('T001'),
            title: 'Test task',
            index: 0,
            file: 'src/test.ts',
            action: 'modify',
          },
        ],
        total: 1,
      }),
      at(2_500, 'implementing', 'snapshot_created', {
        snapshotId: 'snap-1',
        name: 'pre-final-review',
        fileCount: 1,
      }),
      at(2_600, 'final-review', 'full_suite', {
        status: 'running',
        id: 'K1',
        command: 'node --test',
        moment: 'plan',
      }),
      at(2_700, 'final-review', 'review_started', {
        scope: 'final',
        tool: 'codex',
        model: 'gpt-6.1-sol',
      }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections.map((section) => section.type)).toEqual([
      'completed-task',
      'events',
      'active-review',
    ]);
    expect(sections[1]?.items.map((event) => event.type)).toEqual([
      'task_tokens',
      'turn_interrupted',
      'seat_switched',
      'workflow_resumed',
      'workflow_config',
      'tasks_planned',
      'snapshot_created',
    ]);
    expect(sections[2]?.items.map((event) => event.type)).toEqual(['full_suite', 'review_started']);
  });

  it('keeps Stop and continue rows in an events section before the review section', () => {
    const events: EngineEvent[] = [
      ...brief,
      at(2_100, 'implementing', 'task_tokens', { taskId: taskId('T001') }),
      at(2_200, 'implementing', 'turn_interrupted', {
        source: 'user',
        at: 'boundary',
        step: { kind: 'review', cycle: 0 },
      }),
      at(2_250, 'implementing', 'workflow_cancelled', { reason: 'user' }),
      at(2_300, 'implementing', 'workflow_resumed'),
      at(2_400, 'implementing', 'tasks_planned', {
        tasks: [
          {
            id: taskId('T001'),
            title: 'Test task',
            index: 0,
            file: 'src/test.ts',
            action: 'modify',
          },
        ],
        total: 1,
      }),
      at(2_500, 'implementing', 'snapshot_created', {
        snapshotId: 'snap-1',
        name: 'pre-final-review',
        fileCount: 1,
      }),
      at(2_600, 'final-review', 'full_suite', {
        status: 'running',
        id: 'K1',
        command: 'node --test',
        moment: 'plan',
      }),
      at(2_700, 'final-review', 'review_started', {
        scope: 'final',
        tool: 'codex',
        model: 'gpt-6.1-sol',
      }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections.map((section) => section.type)).toEqual([
      'completed-task',
      'events',
      'active-review',
    ]);
    expect(sections[1]?.items.map((event) => event.type)).toEqual([
      'task_tokens',
      'turn_interrupted',
      'workflow_cancelled',
      'workflow_resumed',
      'tasks_planned',
      'snapshot_created',
    ]);
    expect(sections[2]?.items.map((event) => event.type)).toEqual(['full_suite', 'review_started']);
  });

  it('keeps halt and continue rows in an events section before the review section', () => {
    const events: EngineEvent[] = [
      ...brief,
      at(2_100, 'implementing', 'task_tokens', { taskId: taskId('T001') }),
      at(2_200, 'implementing', 'recovery_prompted', {
        issueId: 'issue-1',
        reason: 'seat-down',
        headline: 'Implementer failed',
      }),
      at(2_250, 'implementing', 'recovery_action_selected', {
        issueId: 'issue-1',
        action: 'retry',
      }),
      at(2_300, 'implementing', 'workflow_resumed'),
      at(2_400, 'implementing', 'tasks_planned', {
        tasks: [
          {
            id: taskId('T001'),
            title: 'Test task',
            index: 0,
            file: 'src/test.ts',
            action: 'modify',
          },
        ],
        total: 1,
      }),
      at(2_500, 'implementing', 'snapshot_created', {
        snapshotId: 'snap-1',
        name: 'pre-final-review',
        fileCount: 1,
      }),
      at(2_600, 'final-review', 'full_suite', {
        status: 'running',
        id: 'K1',
        command: 'node --test',
        moment: 'plan',
      }),
      at(2_700, 'final-review', 'review_started', {
        scope: 'final',
        tool: 'codex',
        model: 'gpt-6.1-sol',
      }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections.map((section) => section.type)).toEqual([
      'completed-task',
      'events',
      'active-review',
    ]);
    expect(sections[1]?.items.map((event) => event.type)).toEqual([
      'task_tokens',
      'recovery_prompted',
      'recovery_action_selected',
      'workflow_resumed',
      'tasks_planned',
      'snapshot_created',
    ]);
    expect(sections[2]?.items.map((event) => event.type)).toEqual(['full_suite', 'review_started']);
  });

  it('keeps a brief review in a build phase inside its review section', () => {
    const events: EngineEvent[] = [
      ...brief,
      at(2_100, 'implementing', 'review_started', {
        scope: 'task',
        tool: 'codex',
        model: 'gpt-6.1-sol',
        afterTaskId: taskId('T001'),
      }),
      at(2_200, 'implementing', 'review_completed', {
        scope: 'task',
        tool: 'codex',
        verdict: 'pass',
        duration: 1_000,
        afterTaskId: taskId('T001'),
      }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections.map((section) => section.type)).toEqual(['completed-task', 'settled-stage']);
    expect(sections[1]).toMatchObject({
      type: 'settled-stage',
      summary: { stage: 'review', scope: 'task' },
      items: [events[2], events[3]],
    });
  });

  it('keeps a brief review plan-check rows under its heading', () => {
    const events: EngineEvent[] = [
      ...brief,
      at(2_100, 'implementing', 'full_suite', {
        status: 'running',
        id: 'K1',
        command: 'node --test',
        moment: 'plan',
      }),
      at(2_200, 'implementing', 'checks_run', {
        taskId: taskId('T001'),
        results: [{ id: 'K1', status: 'pass' }],
      }),
      at(2_300, 'implementing', 'review_started', {
        scope: 'task',
        tool: 'codex',
        model: 'gpt-6.1-sol',
        afterTaskId: taskId('T001'),
      }),
      at(2_400, 'implementing', 'review_completed', {
        scope: 'task',
        tool: 'codex',
        verdict: 'pass',
        duration: 1_000,
        afterTaskId: taskId('T001'),
      }),
    ];
    const sections = groupEventsIntoSections(events);
    expect(sections.map((section) => section.type)).toEqual(['completed-task', 'settled-stage']);
    expect(sections[1]).toMatchObject({
      type: 'settled-stage',
      summary: { stage: 'review', scope: 'task' },
      items: events.slice(2),
    });
  });
});
