import { describe, it, expect, beforeEach } from 'vitest';
import { loadEvents } from './load.js';
import { addEvent } from './event.js';
import { resetWorkflow } from './reset.js';
import { eventsStore, MAX_EVENTS } from '../events.js';
import { lifecycleStore } from '../lifecycle.js';
import { operationsStore } from '../operations/state.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { parseEngineEvent } from '../../../engine/events/schema.js';
import type { EngineEvent } from '../../../engine/events/types.js';

const TS = 1_764_000_000_000;

function event(candidate: Record<string, unknown>): EngineEvent {
  const parsed = parseEngineEvent({ ts: TS, ...candidate });
  if (parsed === null) throw new Error(`invalid event: ${JSON.stringify(candidate)}`);
  return parsed;
}

function snapshot(): Record<string, unknown> {
  return {
    events: eventsStore.get().events,
    tasks: tasksStore.get(),
    tokens: tokensStore.get(),
    lifecycle: lifecycleStore.get(),
    operations: operationsStore.get(),
  };
}

function mixedFixture(): EngineEvent[] {
  const events: EngineEvent[] = [
    event({ type: 'workflow_started', ts: TS, phase: 'researching', feature: 'replay' }),
    event({
      type: 'workflow_config',
      ts: TS + 1,
      phase: 'researching',
      mode: 'standard',
      plannerTool: 'claude-code',
      implementerTool: 'codex',
    }),
    event({ type: 'planner_status', ts: TS + 2, phase: 'researching', status: 'running' }),
    event({ type: 'planner_text', ts: TS + 3, phase: 'researching', text: 'thinking ' }),
    event({ type: 'planner_text', ts: TS + 4, phase: 'researching', text: 'out loud' }),
    event({ type: 'planner_status', ts: TS + 5, phase: 'planning', status: 'done' }),
    event({
      type: 'tasks_planned',
      ts: TS + 6,
      phase: 'planning',
      tasks: [
        { id: 'T001', title: 'one', index: 0, file: 'src/a.ts', action: 'create' },
        { id: 'T002', title: 'two', index: 1, file: 'src/b.ts', action: 'modify' },
      ],
      total: 2,
    }),
  ];

  let ts = TS + 10;
  for (const id of ['T001', 'T002']) {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      events.push(
        event({
          type: 'task_started',
          ts: ts++,
          phase: 'implementing',
          taskId: id,
          title: id,
          index: 0,
          total: 2,
          file: 'src/a.ts',
          action: 'modify',
        }),
        event({
          type: 'runner_call_started',
          ts: ts++,
          phase: 'implementing',
          callId: `call-${id}-${attempt}`,
          role: 'implementer',
          backendKind: 'cli',
          sequence: attempt,
        }),
        event({
          type: 'validate',
          ts: ts++,
          phase: 'validating-task',
          taskId: id,
          status: 'running',
          passed: false,
          stages: { typecheck: false, lint: false, test: false },
        }),
        event({
          type: 'cost_update',
          ts: ts++,
          phase: 'implementing',
          tokenUsage: {
            plannerInput: attempt,
            plannerOutput: attempt,
            implementerInput: attempt,
            implementerOutput: attempt,
            escalationInput: 0,
            escalationOutput: 0,
            reviewerInput: 0,
            reviewerOutput: 0,
          },
        }),
        event({
          type: 'task_tokens',
          ts: ts++,
          phase: 'implementing',
          taskId: id,
          method: 'local',
          implementerTokens: 100 + attempt,
          escalationTokens: 0,
          retryCount: attempt,
        }),
        event({
          type: 'task_completed',
          ts: ts++,
          phase: 'implementing',
          taskId: id,
          title: id,
          method: 'local',
          retries: 0,
          duration: 1_000,
        }),
      );
    }
  }

  events.push(
    event({ type: 'all_tasks_done', ts: ts++, phase: 'implementing' }),
    event({ type: 'workflow_complete', ts: ts++, phase: 'complete', review: 'passed' }),
  );
  return events;
}

describe('loadEvents', () => {
  beforeEach(() => resetWorkflow());

  it('keeps the last MAX_EVENTS rows and never evicts a structural one', () => {
    const structural = [
      event({ type: 'workflow_started', phase: 'researching', feature: 'replay' }),
      event({
        type: 'workflow_config',
        phase: 'researching',
        mode: 'standard',
        plannerTool: 'claude-code',
        implementerTool: 'codex',
      }),
      event({
        type: 'task_started',
        phase: 'implementing',
        taskId: 'T001',
        title: 'one',
        index: 0,
        total: 1,
        file: 'src/a.ts',
        action: 'create',
      }),
      event({
        type: 'task_completed',
        phase: 'implementing',
        taskId: 'T001',
        title: 'one',
        method: 'local',
        retries: 0,
        duration: 1,
      }),
    ];
    const chatter = Array.from({ length: 11_996 }, (_, index) =>
      event({
        type: 'planner_status',
        ts: TS + index,
        phase: 'researching',
        status: 'running',
        summary: `status-${index}`,
      }),
    );

    loadEvents([...structural, ...chatter]);

    const { events } = eventsStore.get();
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events.slice(0, 4)).toEqual(structural);
    expect(events[4]).toMatchObject({ summary: 'status-2000' });
    expect(events[events.length - 1]).toMatchObject({ summary: 'status-11995' });
  });

  it('merges consecutive planner_text chunks into one row', () => {
    loadEvents([
      event({ type: 'planner_text', ts: TS, phase: 'researching', text: 'one ' }),
      event({ type: 'planner_text', ts: TS + 1, phase: 'researching', text: 'two ' }),
      event({ type: 'planner_status', ts: TS + 2, phase: 'researching', status: 'running' }),
      event({ type: 'planner_text', ts: TS + 3, phase: 'researching', text: 'three' }),
    ]);

    const { events } = eventsStore.get();
    expect(events.map((row) => row.type)).toEqual([
      'planner_text',
      'planner_status',
      'planner_text',
    ]);
    expect(events[0]).toMatchObject({ text: 'one two ' });
  });

  it('takes phaseFirstSeenTs from the replayed timestamps', () => {
    loadEvents([
      event({ type: 'workflow_started', ts: TS, phase: 'researching', feature: 'replay' }),
      event({ type: 'planner_status', ts: TS + 500, phase: 'planning', status: 'done' }),
      event({
        type: 'task_started',
        ts: TS + 900,
        phase: 'implementing',
        taskId: 'T001',
        title: 'one',
        index: 0,
        total: 1,
        file: 'src/a.ts',
        action: 'create',
      }),
      event({ type: 'planner_status', ts: TS + 1_500, phase: 'implementing', status: 'running' }),
    ]);

    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({
      researching: TS,
      planning: TS + 500,
      implementing: TS + 900,
    });
    expect(lifecycleStore.get().startedAt).toBe(TS);
  });

  it('leaves the stores where feeding the same events through addEvent leaves them', () => {
    const fixture = mixedFixture();
    expect(fixture.length).toBeGreaterThan(200);

    for (const item of fixture) addEvent(item);
    const oneByOne = snapshot();

    resetWorkflow();
    loadEvents(fixture);

    expect(snapshot()).toEqual(oneByOne);
  });

  it('replays rowless replay_started and replay_complete without touching the lifecycle', () => {
    loadEvents([
      event({ type: 'replay_started', ts: TS, phase: 'idle', totalEvents: 1 }),
      event({ type: 'workflow_started', ts: TS + 1, phase: 'researching', feature: 'replay' }),
      event({ type: 'replay_complete', ts: TS + 2, phase: 'idle', totalEvents: 1, durationMs: 2 }),
    ]);

    const { events } = eventsStore.get();
    expect(events.map((row) => row.type)).toEqual([
      'replay_started',
      'workflow_started',
      'replay_complete',
    ]);
    expect(lifecycleStore.get().phase).toBe('researching');
    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({ researching: TS + 1 });
  });

  it('replaces the event log rather than appending to it', () => {
    addEvent(event({ type: 'user_message', ts: TS, phase: 'implementing', text: 'before' }));
    loadEvents([event({ type: 'user_message', ts: TS + 1, phase: 'implementing', text: 'after' })]);

    const { events } = eventsStore.get();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'after' });
  });

  it('leaves no trace of the previous run when a second log is loaded', () => {
    loadEvents(mixedFixture());
    const afterFirst = snapshot();

    loadEvents([
      event({ type: 'workflow_started', ts: TS + 1, phase: 'researching', feature: 'second' }),
      event({
        type: 'task_started',
        ts: TS + 2,
        phase: 'implementing',
        taskId: 'T009',
        title: 'only task of the second run',
        index: 0,
        total: 1,
        file: 'src/z.ts',
        action: 'create',
      }),
      event({
        type: 'task_tokens',
        ts: TS + 3,
        phase: 'implementing',
        taskId: 'T009',
        method: 'local',
        implementerTokens: 7,
        escalationTokens: 0,
        retryCount: 0,
      }),
    ]);

    expect(snapshot()).not.toEqual(afterFirst);
    expect(tasksStore.get().tasks.map((task) => task.id)).toEqual(['T009']);
    expect(tasksStore.get().totalTasks).toBe(1);
    expect(Object.keys(tokensStore.get().perTask)).toEqual(['T009']);
    expect(tokensStore.get().tokenUsage).toBeNull();
    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({
      researching: TS + 1,
      implementing: TS + 2,
    });
    expect(lifecycleStore.get().status).toBe('running');
  });

  it('evicts in the same order as addEvent when structural rows fill the cap', () => {
    const structural = Array.from({ length: MAX_EVENTS }, (_, index) =>
      event({
        type: 'task_started',
        ts: TS + index,
        phase: 'implementing',
        taskId: 'T001',
        title: `brief ${index}`,
        index: 0,
        total: 1,
        file: 'src/a.ts',
        action: 'modify',
      }),
    );
    const batch = [
      event({ type: 'user_message', ts: TS, phase: 'implementing', text: 'first' }),
      ...structural,
      event({ type: 'user_message', ts: TS + MAX_EVENTS, phase: 'implementing', text: 'last' }),
    ];

    for (const item of batch) addEvent(item);
    const oneByOne = eventsStore.get().events;

    resetWorkflow();
    loadEvents(batch);

    expect(eventsStore.get().events).toEqual(oneByOne);
    expect(eventsStore.get().events[MAX_EVENTS - 1]).toMatchObject({ text: 'last' });
  });
});
