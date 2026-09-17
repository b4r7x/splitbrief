import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../core/schemas/task.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { toEngineEventEntry } from '../../core/sessions/log-writer.js';
import { addEvent } from '../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
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
