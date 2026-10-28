import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { evidenceLedgerPath } from '../../../core/evidence/ledger-storage.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { eventPhase } from '../../../core/event-phase.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { applyRecoveryAction } from './actions.js';
import { buildRetryExhaustedRecoveryIssue } from './builders/task.js';

const createdAt = '2026-04-28T12:00:00.000Z';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(name = 'recovery-action'): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeBus(projectDir: string, sessionId: string): { bus: EventBus; events: EngineEvent[] } {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  bus.subscribe(createJsonlSink({ projectDir, sessionId }));
  return { bus, events };
}

function implementingState(tasks: Task[], currentTaskIndex = 0): WorkflowState {
  return makeImplState(tasks, { currentTaskIndex });
}

function readSessionLog(projectDir: string, sessionId: string): string {
  return readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8');
}

describe('applyRecoveryAction: persisted success effects', () => {
  it('ends the run without mutating task status', async () => {
    const { projectDir, sessionId } = setupSession('end-run');
    const completedTask = makeTask({ id: 'T032', status: 'done' });
    const task = makeTask({ id: 'T033', status: 'in_progress' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'all retries failed',
      attempts: 3,
    });
    const state = { ...implementingState([completedTask, task], 1), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'end-run',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'closed' });
    expect(result.state.closed?.as).toBe('ended');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.tasks.map((task) => task.id)).toEqual(['T032', 'T033']);
    expect(result.state.currentTaskIndex).toBe(1);
    expect(result.state.tasks[1]?.status).toBe('in_progress');
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.closed?.as).toBe('ended');
    expect(persisted?.phase).toBe('implementing');
    expect(persisted?.pendingRecovery).toBeUndefined();
    expect(persisted?.tasks.map((task) => task.id)).toEqual(['T032', 'T033']);
    expect(persisted?.currentTaskIndex).toBe(1);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });

  it('skips the current task, records evidence, clears recovery, and does not overwrite user edits', async () => {
    const { projectDir, sessionId } = setupSession('skip-task');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const filePath = join(projectDir, 'src/user.ts');
    writeFileSync(filePath, 'export const owner = "user edit";\n');

    const task = makeTask({ id: 'T034', suggestedFiles: ['src/user.ts'] });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'failed after retries',
      attempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'skip-current-task',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'skipped-current-task' });
    expect(readFileSync(filePath, 'utf-8')).toBe('export const owner = "user edit";\n');
    expect(result.state.currentTaskIndex).toBe(1);
    expect(result.state.tasks[0]?.status).toBe('skipped');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'task_skipped', 'recovery_resolved']),
    );
  });

  it('blocks skip with a dedicated skip-evidence-failed code when evidence cannot be written', async () => {
    const { projectDir, sessionId } = setupSession('skip-evidence-fail');
    mkdirSync(evidenceLedgerPath({ projectDir, sessionId }), { recursive: true });

    const task = makeTask({ id: 'T099', suggestedFiles: ['src/x.ts'] });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'failed after retries',
      attempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus } = makeBus(projectDir, sessionId);

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'skip-current-task',
      bus,
    });

    expect(result).toMatchObject({ ok: false, code: 'skip-evidence-failed' });
  });

  it('prepares retry-same-worker by resetting only the current task without advancing', async () => {
    const { projectDir, sessionId } = setupSession('retry-same-worker');
    const task = makeTask({ id: 'T035', status: 'in_progress' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'lint failed',
      attempts: 1,
      selectedImplementerProfile: 'local-qwen',
      allowRetryOverride: true,
    });
    const state = {
      ...implementingState([task]),
      attempt: 2,
      pendingRecovery: issue,
    };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = await applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'retry-same-worker',
      bus,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'retry-current-task',
      implementerProfile: 'local-qwen',
    });
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.attempt).toBe(0);
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.tasks[0]?.status).toBe('pending');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
    expect(readSessionLog(projectDir, sessionId)).toContain('"type":"recovery_resolved"');
  });
});

describe('applyRecoveryAction: the phase of what it publishes', () => {
  it.each(['retry-same-worker', 'skip-current-task'] as const)(
    '%s stamps the events after the action with the phase the run moved to',
    async (action) => {
      const { projectDir, sessionId } = setupSession(`recovery-phase-${action}`);
      const task = makeTask({ id: 'T040', status: 'in_progress' });
      const issue = buildRetryExhaustedRecoveryIssue({ task, createdAt, allowRetryOverride: true });
      const state: WorkflowState = {
        ...implementingState([task]),
        phase: 'escalating',
        pendingRecovery: issue,
      };
      saveState({ projectDir, sessionId }, state);
      const { bus, events } = makeBus(projectDir, sessionId);

      const result = await applyRecoveryAction({ projectDir, sessionId, state, action, bus });

      expect(result.state.phase).toBe('implementing');
      expect(
        events
          .filter((event) => event.type !== 'recovery_action_selected')
          .map((event) => [event.type, eventPhase(event)]),
      ).toEqual([
        [action === 'skip-current-task' ? 'task_skipped' : 'task_reset', 'implementing'],
        ['recovery_resolved', 'implementing'],
      ]);
    },
  );
});
