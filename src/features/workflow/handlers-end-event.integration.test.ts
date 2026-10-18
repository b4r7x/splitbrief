import { plainUserMessage } from '../../core/types/user-input.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCtx, runCommandInTest } from '#testing/helpers/runtime-commands.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import { readSession } from '../../core/sessions/io.js';
import { readActive, reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { readRunEvents } from '../../engine/events/replay.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import {
  isApplyUnfinishedAtRest,
  isOpenRunAtRest,
  routerStore,
} from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { clearAllHandlers, requestEndRun, requestResume, setResumeHandler } from './handlers.js';

describe('End run at rest', () => {
  let projectDir = '';

  afterEach(() => {
    clearAllHandlers();
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('records one real-time closure event and leaves the time at rest out of the run time', async () => {
    projectDir = createTempDir('at-rest-end-event-');
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    const ref = { projectDir, sessionId: 'end-at-rest' };
    ensureSessionDir(projectDir, ref.sessionId);
    const startedAt = Date.now() - 60_000;
    const state = {
      ...transition(createInitialState('End at rest'), { type: 'START' }),
      startedAt: new Date(startedAt).toISOString(),
    };
    saveState(ref, state);
    createRecoveryBus(ref).publish({
      type: 'workflow_started',
      ts: startedAt,
      phase: state.phase,
      feature: state.feature,
    });
    const record = readRunRecord(ref);
    if (record === null) throw new Error('missing run record');
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    configStore.__testReset({ config: makeConfig() });

    const beforeEnd = Date.now();
    expect(requestEndRun()).toBe(true);
    await vi.waitFor(() => expect(loadState(ref)?.closed).toBeDefined());
    const afterEnd = Date.now();
    const firstClosed = loadState(ref)?.closed;
    const events = (await readRunEvents(ref)).events;
    const cancellation = events.filter((event) => event.type === 'workflow_cancelled');
    expect(cancellation).toHaveLength(1);
    expect(cancellation[0]).toMatchObject({
      phase: state.phase,
      reason: 'user_cancelled',
    });
    expect(cancellation[0]?.ts).toBeGreaterThanOrEqual(beforeEnd);
    expect(cancellation[0]?.ts).toBeLessThanOrEqual(afterEnd);
    expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'ended' });

    expect(readRunRecord(ref)?.summary?.activeTime).toBe(0);
    expect(requestEndRun()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loadState(ref)?.closed).toEqual(firstClosed);
    expect(
      (await readRunEvents(ref)).events.filter((event) => event.type === 'workflow_cancelled'),
    ).toHaveLength(1);
    expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
    expect(readdirSync(join(projectDir, '.git', 'objects'))).toEqual(['info', 'pack']);
  });

  it('refuses Resume while End run at rest is closing', async () => {
    projectDir = createTempDir('at-rest-end-resume-');
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    const ref = { projectDir, sessionId: 'end-before-resume' };
    ensureSessionDir(projectDir, ref.sessionId);
    saveState(ref, transition(createInitialState('End before Resume'), { type: 'START' }));
    const record = readRunRecord(ref);
    if (record === null) throw new Error('missing run record');
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    configStore.__testReset({ config: makeConfig() });
    const resume = vi.fn();
    setResumeHandler(resume);

    expect(requestEndRun()).toBe(true);
    expect(requestResume(plainUserMessage(''))).toBe(false);
    expect(resume).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'ended' });
      expect(stopStore.get().phase).toBe('ended');
    });
  });

  it('/end resolves a halted run and finalizes its session', async () => {
    projectDir = createTempDir('at-rest-end-recovery-');
    const ref = { projectDir, sessionId: 'halted-at-rest' };
    reactivateExistingSession(ref);
    saveState(ref, {
      ...createInitialState('End a halted run'),
      phase: 'escalating',
      tasks: [makeTask({ id: 'T001', status: 'failed' })],
      pendingRecovery: makeRecoveryIssue({
        availableActions: ['retry-same-worker', 'skip-current-task'],
      }),
    });
    const record = readRunRecord(ref);
    if (record === null) throw new Error('missing run record');
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    configStore.__testReset({ config: makeConfig() });
    const errors: string[] = [];

    await runCommandInTest({
      commands: createRuntimeCommands(makeCtx({ endRun: requestEndRun })),
      raw: '/end',
      screen: 'workflow',
      phase: 'escalating',
      openRunAtRest: isOpenRunAtRest(routerStore.get()),
      applyUnfinished: isApplyUnfinishedAtRest(routerStore.get()),
      onError: (message) => errors.push(message),
    });

    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(stopStore.get().phase).toBe('ended'));
    expect(loadState(ref)?.closed?.as).toBe('ended');
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    expect(readSession(ref)?.status).toBe('ended');
    expect(readActive(projectDir)).toBeNull();
    const events = (await readRunEvents(ref)).events;
    expect(events.filter((event) => event.type === 'recovery_resolved')).toEqual([
      expect.objectContaining({ action: 'end-run', outcome: 'aborted' }),
    ]);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
  });
});

describe('/resume and /end on a run at rest at a gate', () => {
  let projectDir = '';

  afterEach(() => {
    clearAllHandlers();
    resetAllStores();
    if (projectDir) cleanupTempDir(projectDir);
    projectDir = '';
  });

  function restAtSpecGate() {
    projectDir = createTempDir('at-rest-gate-commands-');
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    const ref = { projectDir, sessionId: 'gate-at-rest' };
    ensureSessionDir(projectDir, ref.sessionId);
    const started = transition(createInitialState('Gate at rest'), { type: 'START' });
    const atGate = { ...started, phase: 'reviewing-spec' as const };
    saveState(ref, atGate);
    const record = readRunRecord(ref);
    if (record === null) throw new Error('missing run record');
    routerStore.init({ screen: 'workflow', run: record, execution: { kind: 'at-rest' } });
    configStore.__testReset({ config: makeConfig() });
    const errors: string[] = [];
    const run = (raw: string) =>
      runCommandInTest({
        commands: createRuntimeCommands(
          makeCtx({ endRun: requestEndRun, resumeRun: () => requestResume(plainUserMessage('')) }),
        ),
        raw,
        screen: 'workflow',
        phase: atGate.phase,
        openRunAtRest: isOpenRunAtRest(routerStore.get()),
        applyUnfinished: isApplyUnfinishedAtRest(routerStore.get()),
        onError: (message) => errors.push(message),
      });
    return { ref, errors, run };
  }

  it('/end closes it', async () => {
    const { ref, errors, run } = restAtSpecGate();

    await run('/end');

    expect(errors).toEqual([]);
    await vi.waitFor(() =>
      expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'ended' }),
    );
  });

  it('/resume re-enters it', async () => {
    const { errors, run } = restAtSpecGate();
    const resume = vi.fn();
    setResumeHandler(resume);

    await run('/resume');

    expect(errors).toEqual([]);
    expect(resume).toHaveBeenCalledWith(plainUserMessage(''));
  });
});
