import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { evidenceLedgerPath, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import { applyRecoveryAction } from './actions.js';
import {
  buildContextOverflowRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
} from './builders/task.js';
import { buildBudgetPausedRecoveryIssue } from './builders/workflow.js';

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
  bus.subscribe(createJsonlSink({ projectDir, sessionId, persistTranscript: true }));
  return { bus, events };
}

function implementingState(tasks: Task[], currentTaskIndex = 0): WorkflowState {
  return makeImplState(tasks, { currentTaskIndex });
}

function readSessionLog(projectDir: string, sessionId: string): string {
  return readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8');
}

function contextOverflowRoutingDecision(taskId: Task['id']): RoutingDecision {
  return {
    taskId,
    requiredWriteMode: 'extracted-code',
    fit: 'overflow',
    estimatedTokens: 45_000,
    untruncatedEstimatedTokens: 48_000,
    contextLength: 32_768,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    costPosture: 'No capable implementer profile; no cost tier selected',
    reason: 'No capable implementer profile can fit this task prompt',
    rejected: [
      {
        profile: 'local-qwen',
        costTier: 'local',
        profileWriteMode: 'extracted-code',
        requiredWriteMode: 'extracted-code',
        reason: 'Estimated 45000 tokens overflows 32768-token context',
        fit: 'overflow',
        estimatedTokens: 45_000,
        untruncatedEstimatedTokens: 48_000,
        contextLength: 32_768,
        currentCodeTruncated: false,
        currentCodeContextMode: 'whole-file',
      },
    ],
  };
}

describe('applyRecoveryAction: persisted success effects', () => {
  it('continues only a safe budget pause and clears pending recovery', () => {
    const { projectDir, sessionId } = setupSession('continue-budget');
    const task = makeTask({ id: 'T030', file: 'src/next.ts' });
    const issue = buildBudgetPausedRecoveryIssue({
      createdAt,
      currentCost: 4.25,
      maxBudget: 5,
      threshold: 0.85,
      nextTask: task,
      blockedStep: 'before T030',
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'continue',
      bus,
      config: makeConfig(),
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.budgetPauseAcknowledgedAtCost).toBe(4.25);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.budgetPauseAcknowledgedAtCost).toBe(4.25);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
    expect(readSessionLog(projectDir, sessionId)).toContain('"type":"recovery_resolved"');
  });

  it('pauses with the recovery issue still pending and selected action persisted', () => {
    const { projectDir, sessionId } = setupSession('pause-run');
    const task = makeTask({ id: 'T032' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'test failed',
      attempts: 2,
      maxAttempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'pause-run',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'paused' });
    expect(result.state.pendingRecovery).toMatchObject({
      id: issue.id,
      status: 'paused',
      selectedAction: 'pause-run',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      id: issue.id,
      status: 'paused',
      selectedAction: 'pause-run',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected']),
    );
  });

  it('aborts intentionally without mutating task status', () => {
    const { projectDir, sessionId } = setupSession('abort-workflow');
    const completedTask = makeTask({ id: 'T032', status: 'done' });
    const task = makeTask({ id: 'T033', status: 'in_progress' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'all retries failed',
      attempts: 3,
      maxAttempts: 3,
    });
    const state = { ...implementingState([completedTask, task], 1), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'abort-workflow',
      bus,
    });

    expect(result).toMatchObject({ ok: true, status: 'aborted' });
    expect(result.state.phase).toBe('idle');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.tasks.map((task) => task.id)).toEqual(['T032', 'T033']);
    expect(result.state.currentTaskIndex).toBe(1);
    expect(result.state.tasks[1]?.status).toBe('in_progress');
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.phase).toBe('idle');
    expect(persisted?.pendingRecovery).toBeUndefined();
    expect(persisted?.tasks.map((task) => task.id)).toEqual(['T032', 'T033']);
    expect(persisted?.currentTaskIndex).toBe(1);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });

  it('skips the current task, records evidence, clears recovery, and does not overwrite user edits', () => {
    const { projectDir, sessionId } = setupSession('skip-task');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const filePath = join(projectDir, 'src/user.ts');
    writeFileSync(filePath, 'export const owner = "user edit";\n');

    const task = makeTask({ id: 'T034', file: 'src/user.ts' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'failed after retries',
      attempts: 3,
      maxAttempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
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
    expect(readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.observedEvidence).toContain(
      'skipped: recovery retry-exhausted: T034 exhausted recovery retries',
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'task_skipped', 'recovery_resolved']),
    );
  });

  it('blocks skip with a dedicated skip-evidence-failed code when evidence cannot be written', () => {
    const { projectDir, sessionId } = setupSession('skip-evidence-fail');
    mkdirSync(evidenceLedgerPath({ projectDir, sessionId }), { recursive: true });

    const task = makeTask({ id: 'T099', file: 'src/x.ts' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'failed after retries',
      attempts: 3,
      maxAttempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'skip-current-task',
      bus,
    });

    expect(result).toMatchObject({ ok: false, code: 'skip-evidence-failed' });
  });

  it('prepares retry-same-worker by resetting only the current task without advancing', () => {
    const { projectDir, sessionId } = setupSession('retry-same-worker');
    const task = makeTask({ id: 'T035', status: 'in_progress' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'lint failed',
      attempts: 1,
      maxAttempts: 3,
      selectedImplementerProfile: 'local-qwen',
      allowRetryOverride: true,
    });
    const state = {
      ...implementingState([task]),
      attempt: 2,
      pendingRecovery: issue,
    };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
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
  });

  it('prepares route-bigger-worker by resetting the current task with the selected profile', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-worker');
    const task = makeTask({ id: 'T036', file: 'src/large.ts' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision: contextOverflowRoutingDecision(task.id),
      routeBiggerProfile: 'cheap-cloud',
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    saveState({ projectDir, sessionId }, state);
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: {
        version: 3,
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen-small',
        },
        implementerProfiles: {
          default: 'local-qwen',
          profiles: {
            'cheap-cloud': {
              kind: 'api',
              provider: 'deepseek',
              service: 'deepseek',
              offering: 'payg',
              apiBase: 'https://api.deepseek.com/v1',
              model: 'deepseek-chat',
              costTier: 'cheap',
            },
            'local-qwen': {
              kind: 'api',
              provider: 'ollama',
              service: 'ollama',
              offering: 'local',
              apiBase: 'http://localhost:11434/v1',
              model: 'qwen-small',
              costTier: 'local',
            },
          },
        },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          maxRetries: 3,
          persistTranscript: true,
          compactionFormat: 'auto',
          mode: 'standard',
          taskReview: 'none',
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'retry-current-task',
      implementerProfile: 'cheap-cloud',
    });
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });
});
