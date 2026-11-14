import { describe, it, expect } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { TASK } from '#testing/helpers/publish-task.js';
import { parseEngineEvent } from '../../events/schema.js';
import {
  createBusTextHandler,
  createImplementerPublisher,
  publishPlannerStatus,
} from './runner.js';

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

  it('puts the sub-agent id on the text event and keeps it through the event schema', () => {
    const { bus, events } = makeBusRecorder();
    const handler = createBusTextHandler({ bus, phase: 'implementing' }, { role: 'implementer' });

    handler('Found', { subagentId: 'toolu_a', continues: true });
    handler('Done.');

    expect(events[0]).toMatchObject({ subagentId: 'toolu_a', continues: true });
    expect(parseEngineEvent(events[0])).toMatchObject({ subagentId: 'toolu_a', continues: true });
    expect('subagentId' in (events[1] as Record<string, unknown>)).toBe(false);
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

  it('publishes the files a continued call kept, and leaves the field off when it kept none', () => {
    const { bus, events } = makeBusRecorder();
    const done = {
      phase: 'implementing' as const,
      taskId: makeTask().id,
      file: 'src/a.ts',
      files: [],
      duration: 1_200,
      noChange: true,
    };

    createImplementerPublisher(bus).publishDone({ ...done, kept: ['src/a.ts', 'src/b.ts'] });
    createImplementerPublisher(bus).publishDone({ ...done, kept: [] });

    expect(events[0]).toMatchObject({ noChange: true, kept: ['src/a.ts', 'src/b.ts'] });
    expect(parseEngineEvent(events[0])).toMatchObject({ kept: ['src/a.ts', 'src/b.ts'] });
    expect(events[1] && 'kept' in events[1]).toBe(false);
  });
});
