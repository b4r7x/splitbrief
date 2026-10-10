import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';

import {
  createBusTextHandler,
  publishPlannerStatus,
  publishReviewCheck,
  publishReviewChecksPlan,
  publishError,
  publishWarning,
  createImplementerPublisher,
  publishRecoveryActionFailed,
  publishRecoveryActionSelected,
  publishRecoveryResolved,
} from './events.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { parseEngineEvent } from '../events/schema.js';
import { taskId } from '../../core/schemas/task.js';

const TASK = taskId('T001');

describe('createBusTextHandler', () => {
  it('stamps an implementer role so streamed implementer output is not attributed to the planner', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'implementing' }, { role: 'implementer' });

    handler('writing src/a.ts');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'planner_text',
      text: 'writing src/a.ts',
      role: 'implementer',
    });
  });

  it('marks planner document output as markdown when requested', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'planning' }, { content: 'markdown' });

    handler('### Plan\n');

    expect(events[0]).toMatchObject({
      type: 'planner_text',
      text: '### Plan\n',
      content: 'markdown',
    });
  });

  it('omits the role when none is supplied so planner output keeps its default attribution', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'planning' });

    handler('drafting the plan');

    expect(events[0]).toMatchObject({ type: 'planner_text', text: 'drafting the plan' });
    expect('role' in (events[0] as Record<string, unknown>)).toBe(false);
  });
});

describe('implementer call activity', () => {
  it('spells workspace files relatively and keeps outside files absolute', () => {
    const { bus, events } = makeBusRecorder();
    const publisher = createImplementerPublisher(bus);
    const rootDir = '/state/trees/project/session';
    for (const field of ['file_path', 'path', 'AbsolutePath', 'TargetFile']) {
      for (const path of [`${rootDir}/src/features/login.ts`, '/other/src/login.ts']) {
        publisher.publishCallEvent({
          phase: 'implementing',
          taskId: TASK,
          rootDir,
          event: {
            type: 'call_tool_use_done',
            ts: 0,
            callId: 'implementer-path',
            role: 'implementer',
            backendKind: 'cli',
            channel: 'tool',
            toolUse: { id: field, name: 'Read', input: { [field]: path } },
          },
        });
      }
    }

    const activities = events.filter((event) => event.type === 'runner_call_activity');
    expect(activities.map((event) => [event.target, event.label])).toEqual(
      Array.from({ length: 4 }, () => [
        ['src/features/login.ts', 'reading src/features/login.ts'],
        ['/other/src/login.ts', 'reading /other/src/login.ts'],
      ]).flat(),
    );
  });
});

describe('publishPlannerStatus', () => {
  it('falls back to plannerTool / plannerModel from state when extra is not provided', () => {
    const { bus, events } = makeBusRecorder();
    const state = {
      ...createInitialState('test'),
      plannerTool: 'claude-code',
      plannerModel: 'opus-4',
    };

    publishPlannerStatus(bus, state, 'running');

    expect(events[0]).toMatchObject({
      type: 'planner_status',
      status: 'running',
      tool: 'claude-code',
      model: 'opus-4',
    });
  });

  it("never lends the planner's model to another seat's tool", () => {
    const { bus, events } = makeBusRecorder();
    const state = {
      ...createInitialState('test'),
      plannerTool: 'claude-code',
      plannerModel: 'opus-4',
    };

    publishPlannerStatus(bus, state, 'done', { tool: 'codex' });

    expect(events[0]).toMatchObject({ type: 'planner_status', tool: 'codex' });
    expect(events[0]).not.toHaveProperty('model');
  });

  it('omits tool and model when neither state nor extra provides them', () => {
    const { bus, events } = makeBusRecorder();

    publishPlannerStatus(bus, createInitialState('test'), 'done');

    const e = events[0];
    if (!e) throw new Error('expected one planner_status event');
    expect(e).toMatchObject({ type: 'planner_status', status: 'done' });
    expect('tool' in e).toBe(false);
    expect('model' in e).toBe(false);
  });

  it('extra.tool / extra.model override state values', () => {
    const { bus, events } = makeBusRecorder();
    const state = {
      ...createInitialState('test'),
      plannerTool: 'claude-code',
      plannerModel: 'opus-4',
    };

    publishPlannerStatus(bus, state, 'done', { tool: 'codex', model: 'sonnet-4' });

    expect(events[0]).toMatchObject({ tool: 'codex', model: 'sonnet-4' });
  });

  it('names the planner call a running status is on, and omits it when none is named', () => {
    const { bus, events } = makeBusRecorder();

    publishPlannerStatus(bus, createInitialState('test'), 'running', { call: 'tasks' });
    publishPlannerStatus(bus, createInitialState('test'), 'running');

    expect(events[0]).toMatchObject({ type: 'planner_status', status: 'running', call: 'tasks' });
    const bare = events[1];
    if (!bare) throw new Error('expected two planner_status events');
    expect('call' in bare).toBe(false);
  });
});

describe('createImplementerPublisher', () => {
  it('publishes failures without fabricating an absent model', () => {
    const { bus, events } = makeBusRecorder();

    createImplementerPublisher(bus).publishFailed({
      phase: 'implementing',
      taskId: makeTask().id,
      error: 'Implementer call failed',
    });

    expect(events[0]).toMatchObject({ type: 'implementer_generate_failed' });
    expect(events[0] && 'model' in events[0]).toBe(false);
  });

  it('publishes the cause a failed attempt carries, and the event schema keeps it', () => {
    const { bus, events } = makeBusRecorder();
    const cause = 'Tool implementer (opencode) exited without changing any files';

    createImplementerPublisher(bus).publishFailed({
      phase: 'implementing',
      taskId: makeTask().id,
      model: 'opencode-go/deepseek-v4.1-flash',
      error: cause,
    });

    expect(events[0]).toMatchObject({ type: 'implementer_generate_failed', error: cause });
    expect(parseEngineEvent(events[0])).toMatchObject({ error: cause });
  });
});

describe('publishReviewChecksPlan', () => {
  it('publishes an off record with no plan fields', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewChecksPlan({ bus, phase: 'final-review' }, { scope: 'final', status: 'off' });

    expect(parseEngineEvent(events[0])).toEqual({
      type: 'review_checks',
      ts: expect.any(Number),
      phase: 'final-review',
      scope: 'final',
      status: 'off',
    });
  });

  it('publishes the chosen commands, the declined tests and the reason', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewChecksPlan(
      { bus, phase: 'implementing' },
      {
        scope: 'task',
        status: 'planned',
        plan: {
          commands: [{ id: 'V1', command: 'npm test', reason: 'runs the changed tests' }],
          declined: [{ target: 'e2e/app.spec.ts', reason: 'needs a browser' }],
          reason: null,
        },
      },
    );

    expect(parseEngineEvent(events[0])).toMatchObject({
      type: 'review_checks',
      scope: 'task',
      status: 'planned',
      commands: [{ id: 'V1', command: 'npm test', reason: 'runs the changed tests' }],
      declined: [{ target: 'e2e/app.spec.ts', reason: 'needs a browser' }],
      reason: null,
    });
  });
});

describe('publishReviewCheck', () => {
  it('publishes a full_suite record with the check id and the detail of a refusal', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'refused',
        id: 'V2',
        command: 'make test',
        moment: 'pre-review',
        detail: 'runs make on Makefile, which this run changed',
      },
    );

    const event = parseEngineEvent(events[0]);
    expect(event).toMatchObject({
      type: 'full_suite',
      status: 'refused',
      id: 'V2',
      command: 'make test',
      moment: 'pre-review',
      detail: 'runs make on Makefile, which this run changed',
    });
    expect(event).not.toHaveProperty('stage');
    expect(event).not.toHaveProperty('passed');
  });

  it('carries the verdict and duration of a finished base re-run', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'done',
        id: 'V1',
        command: 'npm test',
        moment: 'base',
        passed: false,
        duration: 12,
      },
    );

    expect(parseEngineEvent(events[0])).toMatchObject({
      type: 'full_suite',
      status: 'done',
      id: 'V1',
      moment: 'base',
      passed: false,
      duration: 12,
    });
  });
});

describe('publish* payload forwarding', () => {
  it('publishError — forwards message and timestamp', () => {
    const { bus, events } = makeBusRecorder();
    publishError({ bus: bus, phase: 'implementing', message: 'something went wrong' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'something went wrong' });
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it('publishWarning — carries explicit operational warning safety metadata', () => {
    const { bus, events } = makeBusRecorder();
    publishWarning({
      bus: bus,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      safety: {
        category: 'queue',
        code: 'queue_full',
      },
    });

    const warning = events[0];
    if (warning === undefined) {
      expect(warning).toBeDefined();
      return;
    }

    expect(warning).toMatchObject({
      type: 'warning',
      message: 'Queue full (50 messages).',
      category: 'queue',
      code: 'queue_full',
    });
  });
});

describe('recovery events name the halted seat', () => {
  function publishAll(issue: ReturnType<typeof makeRecoveryIssue>) {
    const { bus, events } = makeBusRecorder();
    const opts = { bus, phase: issue.phase, issue, action: 'switch-seat' } as const;
    publishRecoveryActionSelected(opts);
    publishRecoveryActionFailed({ ...opts, message: 'blocked' });
    publishRecoveryResolved({ ...opts, outcome: 'continued' });
    return events;
  }

  it('carries the seat the swap offer moves', () => {
    const events = publishAll(
      makeRecoveryIssue({
        reason: 'runner-usage-limit',
        phase: 'planning',
        seat: 'plan',
        switchSeat: { seat: 'plan', candidates: [{ tool: 'codex' }] },
      }),
    );

    expect(events.map((event) => ('seat' in event ? event.seat : undefined))).toEqual([
      'plan',
      'plan',
      'plan',
    ]);
  });

  it('falls back to the seat the issue names when it offers no swap', () => {
    const events = publishAll(makeRecoveryIssue({ seat: 'review' }));

    expect(events.map((event) => ('seat' in event ? event.seat : undefined))).toEqual([
      'review',
      'review',
      'review',
    ]);
  });

  it('omits the seat when the halt is about the run rather than a seat', () => {
    const events = publishAll(makeRecoveryIssue());

    expect(events).toHaveLength(3);
    for (const event of events) expect(event).not.toHaveProperty('seat');
  });
});
