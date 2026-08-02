import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { RunnerCallContext } from '../../../engine/calls/types.js';
import type { PlanOptions } from '../../../engine/planners/types.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { transition } from '../../../core/state/machine.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import {
  TRANSCRIPT_OMITTED_FEATURE,
  readActive,
  writeActive,
} from '../../../core/sessions/lifecycle.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import { registerProcess } from '../../../lib/process/registry.js';
import { readRunnerPids } from '../../../core/sessions/runner-pids.js';
import { simpleGit } from 'simple-git';
import { runWorkflow, WORKFLOW_REWIND_ABORT_REASON } from './workflow.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../types.js';
import { error } from '../../../utils/error.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): string {
  const projectDir = createTempDir('run-workflow-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

// An "agent" planner whose command does not exist — planner.isAvailable() returns false,
// letting us observe the "planner unavailable" boundary of runWorkflow without spawning
// a real planning subprocess.
function unavailablePlannerConfig(): Config {
  return makeConfig({
    planner: {
      kind: 'agent',
      command: '/definitely/does/not/exist/plannerbin',
    },
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: {
      approve: 'none',
      mode: 'quick',
      persistTranscript: false,
    },
  });
}

describe('runWorkflow — smoke', () => {
  it('returns a summary without throwing when the configured planner is unavailable', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const config = unavailablePlannerConfig();

    const summary = await runWorkflow({
      feature: 'add auth',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
    });

    // The entry point produces a Summary even when planner is not available.
    expect(summary).toBeDefined();
    expect(summary.feature).toBe(TRANSCRIPT_OMITTED_FEATURE);
    expect(summary.totalTasks).toBe(0);

    // An error event was emitted explaining the missing planner to the user.
    const errorEvent = events.find(
      (e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toMatch(/not available/i);

    // onComplete is NOT called on the unavailable-planner path (unlike the happy path
    // where runFinalReviewPhase invokes it). This is the observable early-return contract.
    const onComplete = callbacks.onComplete as ReturnType<typeof import('vitest').vi.fn>;
    expect(onComplete).not.toHaveBeenCalled();

    expect(events.find((e) => e.type === 'workflow_config')).toBeUndefined();
    expect(events.find((e) => e.type === 'user_message')).toBeUndefined();
  });

  it('drains a stale pending boundary interrupt at run start', async () => {
    const projectDir = setupProject();
    const events: EngineEvent[] = [];
    let pendingBoundaryInterrupt = true;
    const consumeBoundaryInterrupt = () => {
      if (!pendingBoundaryInterrupt) return false;
      pendingBoundaryInterrupt = false;
      return true;
    };
    const onContinuationNeeded = vi.fn(async () => 'should not run');
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const quickPlan = vi.fn().mockImplementation(async () => {
      expect(pendingBoundaryInterrupt).toBe(false);
      return {
        spec: '',
        plan: '',
        tasks: [
          makeTask({
            id: 'T001',
            scope: { inBounds: ['src/drain.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the planned task ran'],
            typeDefs: 'type DrainTask = { file: string }',
          }),
        ],
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    });

    const summary = await runWorkflow({
      feature: 'stale boundary interrupt',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: {
        setAbortHandler: () => {},
        setQueueHandler: () => {},
        consumeBoundaryInterrupt,
      },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner({ quickPlan }),
      _implementer: makeImplementer(),
    });

    expect(events.find((e) => e.type === 'turn_interrupted')).toBeUndefined();
    expect(onContinuationNeeded).not.toHaveBeenCalled();
    expect(quickPlan).toHaveBeenCalled();
    expect(pendingBoundaryInterrupt).toBe(false);
    expect(summary.totalTasks).toBe(1);
  }, 20_000);

  it('records the session status as failed (not interrupted) when planning fails', async () => {
    const projectDir = setupProject();
    const sessionId = 'planning-failed-sid';
    const { callbacks } = makeCallbacks();
    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });

    // An available planner that returns zero tasks routes through handlePlanningFailure
    // with a real (non-abort) error. The persisted session must read as 'failed', not the
    // user-cancel status 'interrupted' (F-127).
    await runWorkflow({
      feature: 'planning-failure',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner({
        quickPlan: vi.fn().mockResolvedValue({
          spec: '',
          plan: '',
          tasks: [],
          usage: { inputTokens: 50, outputTokens: 25 },
        }),
      }),
    });

    const { listAllSessions } = await import('../../../core/sessions/io.js');
    const persisted = listAllSessions(projectDir).find((s) => s.id === sessionId);
    expect(persisted?.status).toBe('failed');
  });

  it('initialization failure yields a failed session status', async () => {
    const projectDir = setupProject();
    const sessionId = 'init-failed-sid';
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();

    // The planner is unavailable, so initializeWorkflow returns `ok: false` before any
    // planning work starts. The persisted session must read as 'failed', not the default
    // 'interrupted' status.
    await runWorkflow({
      feature: 'init-failure',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    const { listAllSessions } = await import('../../../core/sessions/io.js');
    const persisted = listAllSessions(projectDir).find((s) => s.id === sessionId);
    expect(persisted?.status).toBe('failed');
  });

  it('writes a liveness record (pid + fresh heartbeat) for an interactive run and marks it exited on completion', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();
    const before = Date.now();

    await runWorkflow({
      feature: 'liveness-record',
      projectDir,
      config,
      callbacks,
      sessionId: 'liveness-sid',
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    // acquireLiveness writes the lockfile at the start of EVERY run (TUI/headless/RPC),
    // so checkServerStatus can refuse a concurrent resume/continue. Assert the record on disk.
    const { sessionDir } = await import('../../../core/paths.js');
    const { readLockfile, checkServerStatus } = await import('../../ipc/lockfile.js');
    const dir = sessionDir(projectDir, 'liveness-sid');
    const lock = await readLockfile(dir);
    expect(lock).not.toBeNull();
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.sessionId).toBe('liveness-sid');
    expect(lock?.feature).toBe(TRANSCRIPT_OMITTED_FEATURE);
    expect(lock?.lastAliveMs).toBeGreaterThanOrEqual(before);

    // releaseLiveness() runs in the finally arm and marks the record exited (best-effort,
    // fire-and-forget) so the session no longer reads as alive once the run finishes.
    let status = await checkServerStatus(dir);
    for (let i = 0; i < 50 && status.alive; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await checkServerStatus(dir);
    }
    expect(status.alive).toBe(false);
  });

  it('records a runner pid to the session ledger during the run and uninstalls the ledger once runWorkflow returns', async () => {
    const projectDir = setupProject();
    const sessionId = 'process-ledger-sid';
    const { callbacks } = makeCallbacks();
    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });

    const groupChild = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
    let entriesDuringRun: ReturnType<typeof readRunnerPids> = [];

    await runWorkflow({
      feature: 'ledger-during-run',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner({
        quickPlan: vi.fn().mockImplementation(async () => {
          registerProcess(groupChild, { group: true });
          entriesDuringRun = readRunnerPids({ projectDir, sessionId });
          return {
            spec: '',
            plan: '',
            tasks: [makeTask()],
            usage: { inputTokens: 50, outputTokens: 25 },
          };
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(entriesDuringRun.some((entry) => entry.pid === groupChild.pid)).toBe(true);

    // The run's finally arm calls clearProcessLedger, so a process registered after
    // runWorkflow has returned must not be written to this session's ledger.
    const laterChild = spawn('sleep', ['1'], { detached: true, stdio: 'ignore' });
    registerProcess(laterChild, { group: true });
    const entriesAfterRun = readRunnerPids({ projectDir, sessionId });
    expect(entriesAfterRun.some((entry) => entry.pid === laterChild.pid)).toBe(false);

    groupChild.kill('SIGKILL');
    laterChild.kill('SIGKILL');
  });

  it.skipIf(process.platform === 'win32')(
    'awaits process shutdown before persisting a failure summary',
    async () => {
      const projectDir = setupProject();
      const sessionId = 'process-shutdown-failure-sid';
      const summaryPath = join(sessionDir(projectDir, sessionId), 'summary.json');
      const observedEarlySummaryPath = join(projectDir, 'summary-observed-before-exit');
      const child = spawn(
        process.execPath,
        [
          '-e',
          [
            'const { existsSync, writeFileSync } = require("node:fs");',
            'const [summaryPath, observationPath] = process.argv.slice(1);',
            'process.on("SIGTERM", () => {',
            '  const deadline = Date.now() + 150;',
            '  const poll = setInterval(() => {',
            '    if (existsSync(summaryPath)) {',
            '      writeFileSync(observationPath, "summary existed before process exit");',
            '      clearInterval(poll);',
            '      process.exit(0);',
            '    }',
            '    if (Date.now() >= deadline) {',
            '      clearInterval(poll);',
            '      process.exit(0);',
            '    }',
            '  }, 5);',
            '});',
            'process.stdout.write("ready");',
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          summaryPath,
          observedEarlySummaryPath,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));

      const { callbacks } = makeCallbacks({
        onQuestionAsked: vi.fn(async () => {
          throw new Error('question handler failed');
        }),
      });

      const summary = await runWorkflow({
        feature: 'process shutdown failure ordering',
        projectDir,
        sessionId,
        config: makeConfig({
          validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
          workflow: {
            approve: 'none',
            mode: 'quick',
            persistTranscript: false,
          },
        }),
        callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        _planner: makePlanner({
          quickPlan: vi.fn().mockImplementation(async (opts: PlanOptions) => {
            registerProcess(child);
            opts.callbacks.onQuestion?.([{ id: 'q1', type: 'input', text: 'Continue?' }]);
            return {
              spec: '',
              plan: '',
              tasks: [makeTask()],
              usage: { inputTokens: 50, outputTokens: 25 },
            };
          }),
        }),
        _implementer: makeImplementer(),
      });

      expect(summary.totalTasks).toBe(0);
      expect(JSON.parse(readFileSync(summaryPath, 'utf8'))).toMatchObject({ status: 'failed' });
      expect(child.exitCode).toBe(0);
      expect(existsSync(observedEarlySummaryPath)).toBe(false);
    },
  );

  it('refuses to run when the same session already has a live non-detached owner', async () => {
    const projectDir = setupProject();
    const sessionId = 'liveness-conflict-sid';
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();
    const { writeLockfile } = await import('../../ipc/lockfile.js');
    const dir = sessionDir(projectDir, sessionId);
    ensureSessionDir(projectDir, sessionId);
    await writeLockfile(dir, {
      pid: process.pid,
      startTimeMs: Date.now(),
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'standard',
      feature: 'live owner',
    });

    await expect(
      runWorkflow({
        feature: 'live owner',
        projectDir,
        config,
        callbacks,
        sessionId,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      }),
    ).rejects.toThrow(/already running/);
  });

  it('uses the explicit sessionId when provided and creates the session directory', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();

    await runWorkflow({
      feature: 'session-initialised',
      projectDir,
      config,
      callbacks,
      sessionId: 'explicit-sid',
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    // ensureSessionDir is called during init before the isAvailable check — verify it
    // created the explicit session directory on disk.
    const { existsSync } = await import('node:fs');
    const { sessionDir } = await import('../../../core/paths.js');
    expect(existsSync(sessionDir(projectDir, 'explicit-sid'))).toBe(true);
  });

  it('publishes workflow events to an externally owned event bus', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();
    const bus = createEventBus();
    const events: EngineEvent[] = [];
    bus.subscribe((event) => events.push(event));

    await runWorkflow({
      feature: 'detached-stream',
      projectDir,
      config,
      callbacks,
      eventBus: bus,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    expect(events.find((event) => event.type === 'error')).toBeDefined();
  });

  it('skips most of the flow when the AbortSignal is aborted before planning completes and still returns a Summary', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();

    // This planner IS available (echo exists on macOS/linux) — but we pre-abort.
    // When `isAvailable()` passes but `signal.aborted` is true by the time planning
    // returns, the phases short-circuit and runWorkflow still produces a summary.
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });

    const controller = new AbortController();
    controller.abort();

    const summary = await runWorkflow({
      feature: 'aborted-before-start',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    expect(summary).toBeDefined();
    expect(summary.feature).toBe(TRANSCRIPT_OMITTED_FEATURE);
  });

  it('publishes workflow_cancelled with the canonical reason for UI cancellation signals', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const controller = new AbortController();

    await runWorkflow({
      feature: 'ui cancel',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _eventSink: (event) => events.push(event),
      _planner: makePlanner({
        quickPlan: vi.fn().mockImplementation(async () => {
          controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
          return {
            spec: '',
            plan: '',
            tasks: [makeTask()],
            usage: null,
          };
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(events.find((event) => event.type === 'workflow_cancelled')).toMatchObject({
      type: 'workflow_cancelled',
      reason: 'user_cancelled',
    });
  });

  it('persists workflow_cancelled when user cancellation reaches the unavailable-planner path', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const sessionId = 'unavailable-cancel-sid';
    const controller = new AbortController();
    controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);

    await runWorkflow({
      feature: 'cancel before unavailable planner',
      projectDir,
      config: unavailablePlannerConfig(),
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    const log = readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; data?: { reason?: string } });

    expect(log.find((entry) => entry.type === 'workflow_cancelled')).toMatchObject({
      type: 'workflow_cancelled',
      data: { reason: 'user_cancelled' },
    });
  });

  it('preserves the active session when a rewind-triggered abort finishes the old run', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const sessionId = 'explicit-rewind-sid';
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });
    const controller = new AbortController();
    controller.abort(WORKFLOW_REWIND_ABORT_REASON);

    // No fixture pre-write of `.splitbrief/active`: runWorkflow itself must write the pointer
    // for the explicit sessionId, and the rewind-abort reason must preserve it (F-317).
    await runWorkflow({
      feature: 'rewind-active',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    expect(readActive(projectDir)).toBe(sessionId);
  });

  it('preserves persisted rewind state when an approval gate aborts the turn', async () => {
    const projectDir = setupProject();
    const sessionId = 'approval-rewind-sid';
    const controller = new AbortController();
    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'plan',
        mode: 'standard',
        persistTranscript: false,
      },
    });
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn(async (type) => {
        if (type !== 'plan') return { approved: true as const };
        const persisted = loadState({ projectDir, sessionId });
        expect(persisted?.phase).toBe('reviewing-plan');
        if (!persisted) throw new Error('Expected persisted planning state');
        saveState(
          { projectDir, sessionId },
          {
            ...persisted,
            rewindPending: { target: 'plan', comment: TRANSCRIPT_OMITTED_MESSAGE },
          },
        );
        controller.abort(WORKFLOW_REWIND_ABORT_REASON);
        throw error('operation-aborted', WORKFLOW_REWIND_ABORT_REASON);
      }),
    });

    await runWorkflow({
      feature: 'approval gate rewind',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _planner: makePlanner(),
    });

    expect(loadState({ projectDir, sessionId })?.rewindPending).toEqual({
      target: 'plan',
      comment: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(loadState({ projectDir, sessionId })?.phase).toBe('reviewing-plan');
  });

  it('clears the active session for a normal aborted run', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const sessionId = 'explicit-normal-abort-sid';
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });
    const controller = new AbortController();
    controller.abort();
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    await runWorkflow({
      feature: 'normal-abort-active',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    expect(readActive(projectDir)).toBeNull();
  });

  it('writes the .splitbrief/active pointer for a generated session id with no fixture pre-write', async () => {
    // The flagship TUI journey passes no explicit sessionId; runWorkflow generates one and
    // MUST publish it to `.splitbrief/active` so rewind/resume/status/recovery can find the run
    // (F-317). A rewind-abort reason preserves the pointer past saveFinalSession so we can
    // read back exactly the producer-written id without any hand-written fixture.
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
        mode: 'quick',
        persistTranscript: false,
      },
    });
    const controller = new AbortController();
    controller.abort(WORKFLOW_REWIND_ABORT_REASON);

    expect(readActive(projectDir)).toBeNull();
    await runWorkflow({
      feature: 'pointer from producer',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
    });

    const activeSessionId = readActive(projectDir);
    expect(activeSessionId).toMatch(/^\d{4}-\d{2}-\d{2}-session-[a-f0-9]{12}$/);
    expect(activeSessionId).not.toContain('pointer-from-producer');
  });

  it('carries the planner-produced tasks straight into the task loop and completes them', async () => {
    // The post-plan boundary (formerly applyPostPlanDrain, F-069) used to be a no-op
    // placeholder between planning and the task loop. With it gone, planning.state must
    // flow directly into runTasksAndReview — observable as the planner's task actually
    // being implemented and counted in the summary.
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    const summary = await runWorkflow({
      feature: 'carry planned task',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner({
        quickPlan: vi.fn().mockResolvedValue({
          spec: '',
          plan: '',
          tasks: [
            makeTask({
              id: 'T001',
              scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
              evidence: ['task_completed event shows the planned task ran'],
              typeDefs: 'type HelloTask = { file: string }',
            }),
          ],
          usage: { inputTokens: 50, outputTokens: 25 },
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({ taskId: 'T001' });
    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBe(1);
  }, 20_000);

  it('re-enters planning after task review requests revise-plan without notes', async () => {
    const projectDir = setupProject();
    const quickPlan = vi
      .fn()
      .mockResolvedValueOnce({
        spec: '',
        plan: '# First plan',
        tasks: [
          makeTask({
            id: 'T001',
            title: 'First task',
            scope: { inBounds: ['src/first.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the first task ran'],
            typeDefs: 'type FirstTask = { file: string }',
          }),
        ],
        usage: null,
      })
      .mockResolvedValueOnce({
        spec: '',
        plan: '# Revised plan',
        tasks: [
          makeTask({
            id: 'T002',
            title: 'Revised task',
            scope: { inBounds: ['src/revised.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the revised task ran'],
            typeDefs: 'type RevisedTask = { file: string }',
          }),
        ],
        usage: null,
      });
    const onTaskReviewNeeded = vi
      .fn()
      .mockResolvedValueOnce({ action: 'revise-plan' })
      .mockResolvedValue({ action: 'continue' });
    const { callbacks } = makeCallbacks({ onTaskReviewNeeded });
    const events: EngineEvent[] = [];

    await runWorkflow({
      feature: 'commentless task review rewind',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
          taskReview: 'every',
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner({ quickPlan }),
      _implementer: makeImplementer(),
    });

    expect(quickPlan).toHaveBeenCalledTimes(2);
    expect(onTaskReviewNeeded).toHaveBeenCalledTimes(2);
    expect(onTaskReviewNeeded.mock.calls.map(([request]) => request.taskId)).toEqual([
      'T001',
      'T002',
    ]);
    expect(events.filter((e) => e.type === 'task_review_needed').map((e) => e.taskId)).toEqual([
      'T001',
      'T002',
    ]);
  });

  it('task review abort publishes workflow_cancelled and skips final review', async () => {
    const projectDir = setupProject();
    const onTaskReviewNeeded = vi.fn().mockResolvedValue({ action: 'abort' });
    const { callbacks } = makeCallbacks({ onTaskReviewNeeded });
    const events: EngineEvent[] = [];

    const summary = await runWorkflow({
      feature: 'abort from task review',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
          taskReview: 'every',
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner({
        quickPlan: vi.fn().mockResolvedValue({
          spec: '',
          plan: '# Plan',
          tasks: [
            makeTask({
              id: 'T001',
              title: 'Abortable task',
              scope: { inBounds: ['src/abortable.ts'], outOfBounds: ['other files'] },
              evidence: ['task_completed event shows the task ran'],
              typeDefs: 'type AbortableTask = { file: string }',
            }),
          ],
          usage: null,
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBe(0);
    expect(onTaskReviewNeeded).toHaveBeenCalledTimes(1);
    expect(onTaskReviewNeeded.mock.calls[0]?.[0]).toMatchObject({
      taskId: 'T001',
      status: 'recovery-required',
    });
    expect(events.find((event) => event.type === 'workflow_cancelled')).toMatchObject({
      type: 'workflow_cancelled',
      reason: 'user_cancelled',
    });
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });

  it('forwards planner runner_call lifecycle events through the workflow EventBus', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const startedAt = Date.now();
    const usage = { inputTokens: 3, outputTokens: 5 };
    const call: RunnerCallContext = {
      callId: 'planner-call-test',
      role: 'planner',
      backendKind: 'shell',
      runnerName: 'test-planner',
    };

    await runWorkflow({
      feature: 'planner call events',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (event) => events.push(event),
      _planner: makePlanner({
        quickPlan: vi.fn().mockImplementation(async (opts: PlanOptions) => {
          opts.callbacks.onCallEvent?.({ type: 'call_started', ts: startedAt, ...call });
          opts.callbacks.onCallEvent?.({
            type: 'call_usage',
            ts: startedAt + 1,
            ...call,
            usage,
            semantics: 'delta',
          });
          opts.callbacks.onCallEvent?.({
            type: 'call_completed',
            ts: startedAt + 2,
            ...call,
            status: 'completed',
            error: null,
            partial: false,
            startedAt,
            endedAt: startedAt + 2,
            durationMs: 2,
            usage,
            nativeSessionId: null,
          });
          return {
            spec: '',
            plan: '',
            tasks: [makeTask()],
            usage: null,
          };
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(
      events.filter((event) => event.type.startsWith('runner_call_')).map((event) => event.type),
    ).toEqual([
      'runner_call_started',
      'runner_call_usage',
      'runner_call_completed',
      'runner_call_activity',
    ]);
    expect(events.find((event) => event.type === 'runner_call_completed')).toMatchObject({
      type: 'runner_call_completed',
      callId: 'planner-call-test',
      role: 'planner',
      status: 'completed',
      durationMs: 2,
    });
    expect(events.find((event) => event.type === 'runner_call_activity')).toMatchObject({
      callId: 'planner-call-test',
      role: 'planner',
      stage: 'completed',
      kind: 'text',
    });
  });

  it('runs auto-discovered pre_task module hooks without hooks config', async () => {
    const projectDir = setupProject();
    mkdirSync(join(projectDir, '.splitbrief', 'hooks'), { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(projectDir, '.splitbrief', 'hooks', 'pre-task.js'),
      'export default () => ({ kind: "deny", message: "auto blocked" });',
    );

    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    await runWorkflow({
      feature: 'auto hook',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      allowHooks: true,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (event) => events.push(event),
      _planner: makePlanner({
        quickPlan: vi.fn().mockResolvedValue({
          spec: '',
          plan: '',
          tasks: [
            makeTask({
              scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
              evidence: ['task_skipped event shows the discovered hook blocked the task'],
              typeDefs: 'type HelloTask = { file: string }',
            }),
          ],
          usage: { inputTokens: 50, outputTokens: 25 },
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task_skipped',
        reason: 'auto blocked',
      }),
    );
  });
});

describe('runWorkflow — createBranch', () => {
  it('creates splitbrief/<slug> branch when git.createBranch is enabled', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        git: { createBranch: true },
        mode: 'quick',
        persistTranscript: false,
      },
    });

    await runWorkflow({
      feature: 'add auth',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      signal: controller.signal,
    });

    const branchEvent = events.find(
      (e): e is Extract<EngineEvent, { type: 'git_branch_created' }> =>
        e.type === 'git_branch_created',
    );
    expect(branchEvent).toBeDefined();
    expect(branchEvent?.name).toMatch(/^splitbrief\/session-[a-f0-9]{12}$/);
    expect(branchEvent?.name).not.toContain('add-auth');

    const g = simpleGit(projectDir);
    const status = await g.status();
    expect(status.current).toBe(branchEvent?.name);
  });

  it('does not create a branch when git.createBranch is false', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const config = makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: {
        git: { createBranch: false },
        mode: 'quick',
        persistTranscript: false,
      },
    });

    const g = simpleGit(projectDir);
    const statusBefore = await g.status();
    const defaultBranch = statusBefore.current ?? 'main';

    await runWorkflow({
      feature: 'add auth',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner(),
      signal: controller.signal,
    });

    expect(events.find((e) => e.type === 'git_branch_created')).toBeUndefined();
    const statusAfter = await g.status();
    expect(statusAfter.current).toBe(defaultBranch);
  });
});

const implementingState = makeImplStateWithMetadata;

describe('runWorkflow — recovery resume', () => {
  it('preserves the active session when a saved pending recovery stops before planner availability checks', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-run-recovery';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      validationSummary: 'tsc failed',
      attempts: 1,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const savedState = transition(implementingState([task]), {
      type: 'SET_PENDING_RECOVERY',
      issue,
    });
    saveState({ projectDir, sessionId }, savedState);

    const { callbacks } = makeCallbacks();
    const isAvailable = async () => {
      throw new Error(
        'planner availability should not be checked while pending recovery is unresolved',
      );
    };

    await runWorkflow({
      feature: 'feat',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState,
      sessionId,
      _planner: makePlanner({ isAvailable }),
    });

    expect(readActive(projectDir)).toBe(sessionId);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
  });

  it('preserves the original session start across a resume so time and cost share a basis', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-run-start-basis';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      validationSummary: 'tsc failed',
      attempts: 1,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    // The saved session started an hour before this resume. The resumed run must accumulate
    // time from this original start rather than restarting the clock at Date.now().
    const originalStart = '2026-04-29T00:00:00.000Z';
    const originalStartMs = Date.parse(originalStart);
    const savedState: WorkflowState = {
      ...transition(implementingState([task]), { type: 'SET_PENDING_RECOVERY', issue }),
      startedAt: originalStart,
    };
    saveState({ projectDir, sessionId }, savedState);

    const { callbacks } = makeCallbacks();
    const summary = await runWorkflow({
      feature: 'feat',
      projectDir,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState,
      sessionId,
      _planner: makePlanner({
        isAvailable: async () => {
          throw new Error(
            'availability should not be checked while pending recovery is unresolved',
          );
        },
      }),
    });

    // totalTime is measured from the original session start, so it spans more than a year —
    // far larger than the few milliseconds this resume actually ran.
    expect(summary.totalTime).toBeGreaterThan(Date.now() - originalStartMs - 60_000);

    // The persisted session record keeps the original start instead of overwriting it with
    // the resume's wall-clock time.
    const { listAllSessions } = await import('../../../core/sessions/io.js');
    const persisted = listAllSessions(projectDir).find((s) => s.id === sessionId);
    expect(persisted?.startedAt).toBe(originalStartMs);
  });

  it('prices the resumed summary at the state-pinned runner identity, not the new config', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-run-identity';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      validationSummary: 'tsc failed',
      attempts: 1,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    // makeImplStateWithMetadata pins plannerTool 'claude-code' / implementer 'ollama' (qwen2.5).
    const savedState = transition(implementingState([task]), {
      type: 'SET_PENDING_RECOVERY',
      issue,
    });
    saveState({ projectDir, sessionId }, savedState);

    const { callbacks } = makeCallbacks();
    // The new config switches the implementer to deepseek; the resumed summary must keep
    // the state-pinned identity so cumulative usage is not re-priced at the new runner.
    const summary = await runWorkflow({
      feature: 'feat',
      projectDir,
      config: makeConfig({
        implementer: {
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
        },
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
          mode: 'quick',
          persistTranscript: false,
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState,
      sessionId,
      _planner: makePlanner({
        isAvailable: async () => {
          throw new Error(
            'availability should not be checked while pending recovery is unresolved',
          );
        },
      }),
    });

    expect(summary.plannerTool).toBe('claude-code');
    expect(summary.implementerTool).toBe('ollama');
    expect(summary.implementerModel).toBe('qwen2.5');
  });
});
