import { mkdirSync, writeFileSync } from 'node:fs';
import { arrowSep } from '../../core/separators.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../core/schemas/task.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { toEngineEventEntry } from '../../core/sessions/log-writer.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { buildConversationRows } from './conversation-rows/build.js';
import { rowText } from './conversation-rows/row-format/rows.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { operationsStore } from '../../stores/workflow/operations/state.js';
import { hydrateRun, readRunHistory } from './run-history.js';

let projectDir = '';
const SESSION_ID = 'run-history-session';

const RUN: readonly EngineEvent[] = [
  { type: 'workflow_started', ts: 1_000, phase: 'planning', feature: 'replay me' },
  {
    type: 'task_started',
    ts: 2_000,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add validator',
    index: 0,
    total: 2,
    file: 'src/validate.ts',
    action: 'create',
  },
  {
    type: 'task_completed',
    ts: 3_000,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add validator',
    method: 'local',
    retries: 0,
    duration: 1_000,
  },
];

function savedState(): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'replay me',
    currentTaskIndex: 1,
    attempt: 0,
    tasks: [
      makeTask({ id: 'T001', status: 'done', title: 'Add validator' }),
      makeTask({ id: 'T002', status: 'pending', title: 'Wire it in' }),
    ],
    plannerSessionId: null,
    startedAt: new Date(1_000).toISOString(),
    tokenUsage: makeUsage({ plannerInput: 400, plannerOutput: 100 }),
    plannerTool: 'claude-code',
    implementerTool: 'ollama',
    awaitingContinue: false,
    messageQueue: [],
  };
}

function writeLog(events: readonly EngineEvent[]): void {
  const dir = sessionDir(projectDir, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(toEngineEventEntry(event))}\n`).join('');
  writeFileSync(join(dir, SESSION_LOG_FILE), lines);
}

beforeEach(() => {
  projectDir = createTempDir('run-history');
  resetWorkflow();
});

afterEach(() => {
  resetWorkflow();
  if (projectDir) cleanupTempDir(projectDir);
  projectDir = '';
});

describe('hydrateRun', () => {
  it('settles a fix check cut by Stop before a replayed retry and an in-place continuation', async () => {
    const fix: EngineEventOf<'full_suite'> = {
      type: 'full_suite',
      ts: 4_000,
      phase: 'implementing',
      id: 'V1',
      moment: 'brief',
      command: 'npm run test-ci',
      status: 'running',
    };
    const log: EngineEvent[] = [
      ...RUN,
      fix,
      { type: 'turn_interrupted', ts: 5_000, phase: 'implementing', source: 'user' },
      {
        type: 'task_retry',
        ts: 3_000_000,
        phase: 'implementing',
        taskId: taskId('T002'),
        attempt: 2,
        maxRetries: 3,
        error: 'retry after Stop',
      },
    ];
    writeLog(log);
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    expect(operationsStore.get().suiteStage).toBeNull();
    expect(operationsStore.get().validationStage).toBeNull();
    expect(eventsStore.get().events).toContainEqual({ ...fix, status: 'stopped' });
    const rows = eventsStore.get().events.flatMap((event, globalIndex) =>
      eventRows({
        event,
        globalIndex,
        expanded: false,
        ctx: {
          width: 120,
          viewportRows: 40,
          streaming: { taskId: null, lines: [], active: false },
        },
      }),
    );
    const text = rows.map(rowText).join('\n');
    expect(text).toContain('Fix check V1 · npm run test-ci · stopped');
    expect(text).not.toContain('Fix check V1 · npm run test-ci · running');
    addEvent({ type: 'workflow_resumed', ts: 3_001_000, phase: 'implementing' });
    expect(operationsStore.get().suiteStage).toBeNull();
    addEvent({ ...fix, ts: 3_002_000 });
    expect(operationsStore.get().suiteStage?.stageStartedTs).toBe(3_002_000);
  });

  it('puts the stores where a live run of the same log would have left them', async () => {
    writeLog(RUN);
    for (const event of RUN) addEvent(event);
    const live = {
      events: eventsStore.get().events.map((event) => event.type),
      tasks: tasksStore.get().taskMap.get('T001')?.status,
      phase: lifecycleStore.get().phase,
    };
    resetWorkflow();

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(eventsStore.get().events.map((event) => event.type)).toEqual([
      'replay_started',
      ...live.events,
      'replay_complete',
    ]);
    expect(tasksStore.get().taskMap.get('T001')?.status).toBe(live.tasks);
    expect(lifecycleStore.get().phase).toBe(live.phase);
  });

  it('lays the saved state over the replay: the brief list and the spend come from it', async () => {
    writeLog(RUN);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(tasksStore.get().totalTasks).toBe(2);
    expect(tasksStore.get().taskMap.get('T002')?.status).toBe('pending');
    expect(tokensStore.get().tokenUsage?.plannerInput).toBe(400);
    expect(lifecycleStore.get().status).toBe('paused');
  });

  it('replaces whatever run was on screen before it', async () => {
    addEvent({ type: 'workflow_started', ts: 500, phase: 'planning', feature: 'the other run' });
    writeLog(RUN);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    const texts = JSON.stringify(eventsStore.get().events);
    expect(texts).not.toContain('the other run');
    expect(texts).toContain('replay me');
  });

  it('stops the clock on the run record when the run left no log', async () => {
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        startedAt: new Date(1_000).toISOString(),
        hydration: { kind: 'loaded', state: { ...savedState(), phase: 'complete' } },
        summary: makeSummary({ totalTime: 90_000 }),
      }),
    );

    // The replay's own two markers are not the run's history, so they never answer for its clock.
    expect(lifecycleStore.get().durationMs).toBe(90_000);
  });

  it('keeps each gate approval in the replayed history and draws no row for it', async () => {
    const approvals: readonly EngineEvent[] = [
      { type: 'spec_approved', ts: 1_200, phase: 'reviewing-spec' },
      { type: 'plan_approved', ts: 1_400, phase: 'reviewing-plan' },
      { type: 'briefs_approved', ts: 1_600, phase: 'reviewing-briefs' },
    ];
    writeLog([...RUN.slice(0, 1), ...approvals, ...RUN.slice(1)]);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(eventsStore.get().events.filter((event) => event.type.endsWith('_approved'))).toEqual(
      approvals,
    );
    const rows = approvals.flatMap((event, globalIndex) =>
      eventRows({
        event,
        globalIndex,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
      }),
    );
    expect(rows).toEqual([]);
    expect(lifecycleStore.get().phase).toBe('implementing');
  });

  it('ends the clock of a run at rest at the stop its log recorded', async () => {
    const stop: EngineEvent = {
      type: 'turn_interrupted',
      ts: 9_000,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    };
    writeLog([...RUN, stop]);

    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    expect(lifecycleStore.get().durationMs).toBe(9_000 - 1_000);
  });

  it('shows a run whose state cannot be read as the log alone', async () => {
    writeLog(RUN);

    await hydrateRun(makeRunRecord({ ref: { projectDir, sessionId: SESSION_ID } }));

    // Everything the events carry still replays; only what lives on the state that could not be
    // read — the brief the run never started, and its token usage — is absent.
    expect(eventsStore.get().events.length).toBe(RUN.length + 2);
    expect(tasksStore.get().totalTasks).toBe(2);
    expect(tasksStore.get().taskMap.get('T001')?.status).toBe('done');
    expect(tasksStore.get().taskMap.get('T002')).toBeUndefined();
    expect(tokensStore.get().tokenUsage).toBeNull();
  });
});

describe('hydrateRun replaying a seat swap', () => {
  function writeRawLog(lines: readonly string[]): void {
    const dir = sessionDir(projectDir, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_LOG_FILE), lines.map((line) => `${line}\n`).join(''));
  }

  async function replayedTranscript(): Promise<string> {
    await hydrateRun(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );
    const { rows } = buildConversationRows({
      sections: [{ type: 'events', startIndex: 0, items: [...eventsStore.get().events] }],
      expandedDiffs: new Set(),
      expandedActivityBatches: new Set(),
      cols: 80,
      viewportHeight: 20,
      streaming: { taskId: null, lines: [], active: false },
    });
    return rows.map(rowText).join('\n');
  }

  it('names no seat for a swap a log recorded before the seat was on the event', async () => {
    // Written by a build whose recovery events carried no seat.
    writeRawLog([
      '{"kind":"event","ts":"2026-09-01T10:00:00.000Z","type":"recovery_action_selected","phase":"planning","data":{"issueId":"rec-1","reason":"runner-usage-limit","action":"switch-seat"}}',
      '{"kind":"event","ts":"2026-09-01T10:00:01.000Z","type":"recovery_resolved","phase":"planning","data":{"issueId":"rec-1","reason":"runner-usage-limit","action":"switch-seat","outcome":"continued"}}',
    ]);

    const text = await replayedTranscript();

    expect(text).toBe(`Recovery  Change tool${arrowSep()}continued`);
    expect(text).not.toContain('Change BUILD tool');
  });

  it('names the seat a swap recorded', async () => {
    const base = {
      ts: 1_000,
      phase: 'planning',
      issueId: 'rec-1',
      reason: 'runner-usage-limit',
      action: 'switch-seat',
      seat: 'plan',
    } as const;
    writeLog([
      { type: 'recovery_action_selected', ...base },
      { type: 'recovery_resolved', ...base, outcome: 'continued' },
    ]);

    const text = await replayedTranscript();

    expect(text).toBe(`Recovery  Change PLAN tool${arrowSep()}continued`);
  });
});

describe('readRunHistory', () => {
  it('reads without touching a store, and the run lands only when it is published', async () => {
    addEvent({ type: 'workflow_started', ts: 500, phase: 'planning', feature: 'the other run' });
    writeLog(RUN);
    const stores = [eventsStore, tasksStore, lifecycleStore, tokensStore];
    const before = stores.map((store) => store.get());

    const publish = await readRunHistory(
      makeRunRecord({
        ref: { projectDir, sessionId: SESSION_ID },
        hydration: { kind: 'loaded', state: savedState() },
      }),
    );

    stores.forEach((store, index) => {
      expect(store.get()).toBe(before[index]);
    });

    publish();

    const texts = JSON.stringify(eventsStore.get().events);
    expect(texts).not.toContain('the other run');
    expect(texts).toContain('replay me');
    expect(tasksStore.get().totalTasks).toBe(2);
    expect(tokensStore.get().tokenUsage?.plannerInput).toBe(400);
    expect(lifecycleStore.get().status).toBe('paused');
  });
});
