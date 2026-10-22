import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';
import { PlanSchema } from '../../../core/schemas/plan.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { RunnerCallContext } from '../../../engine/calls/types.js';
import type { PlannerOutputCallbacks } from '../../../engine/planners/types.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import {
  LOCKFILE,
  READINESS_FILE,
  SESSION_LOG_FILE,
  SPLITBRIEF_DIR,
  SESSIONS_DIR,
  STATE_FILE,
  sessionDir,
  sessionsRoot,
} from '../../../core/paths.js';
import { ORPHAN_SESSION_GRACE_MS } from '../../../core/sessions/orphans.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readSession, saveSummary } from '../../../core/sessions/io.js';
import {
  reactivateExistingSession,
  readActive,
  writeActive,
} from '../../../core/sessions/active-pointer.js';
import { generateSessionId } from '../../../core/sessions/session-id.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { canSignalProcess } from '../../../lib/process/liveness.js';
import { registerProcess } from '../../../lib/process/registry.js';
import { readProcessStartTimeMs } from '../../../lib/process/start-time.js';
import { readRunnerPids, recordRunnerPid } from '../../../core/sessions/runner-pids.js';
import { simpleGit } from 'simple-git';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import type { RunWorkflowOptions } from './init.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../events/workflow-cancel.js';
import { error } from '../../../utils/error.js';
import { parsePreparedConfig, type RunnerGate } from '../../runners/prepared-execution.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { readRunEvents } from '../../events/replay.js';
import { makePassingPlanner } from '#testing/helpers/planning-phase.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../changed-files-baseline.js';
import type { OrchestratorCallbacks } from '../types.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';
import { readRunSnapshotLedger, resolveLedgerRunSnapshot } from '../../snapshots/run/ledger.js';
import {
  planFromTasks,
  planQuestionsFrom,
  passingReviewVerdict,
  typedCallAnswering,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';

let dirs: string[] = [];

function readyReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: new Date(0).toISOString(),
    projectDir,
    status: 'ready',
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [],
    metadata: {},
  };
}

let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-workflow-trust-home');
});

afterEach(async () => {
  await settleTrackedWorkflows();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
  trustHome.restore();
});

function emitReviewCall(callbacks: PlannerOutputCallbacks, runnerName: string): void {
  const call: RunnerCallContext = {
    callId: `${runnerName}-review-call`,
    role: 'review',
    backendKind: 'shell',
    runnerName,
  };
  const startedAt = Date.now();
  callbacks.onCallEvent?.({ type: 'call_started', ts: startedAt, ...call });
  callbacks.onCallEvent?.({
    type: 'call_completed',
    ts: startedAt + 1,
    ...call,
    status: 'completed',
    error: null,
    partial: false,
    startedAt,
    endedAt: startedAt + 1,
    durationMs: 1,
    usage: null,
    nativeSessionId: null,
  });
}

function reviewCallEvents(
  events: EngineEvent[],
): Array<{ type: string; runnerName: string | undefined }> {
  return events
    .filter(
      (event) => event.type === 'runner_call_started' || event.type === 'runner_call_completed',
    )
    .filter((event) => event.role === 'review')
    .map((event) => ({ type: event.type, runnerName: event.runnerName }));
}

function setupProject(): string {
  const projectDir = createTempDir('run-workflow-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

type WorkflowTestOptions = Omit<RunWorkflowOptions, 'prepared'> & {
  feature: string;
  projectDir: string;
  config: Config;
  sessionId?: string | undefined;
  allowHooks?: boolean | undefined;
  purpose?: Exclude<PreparedExecution['purpose'], 'spec'> | undefined;
};

async function runWorkflow(input: WorkflowTestOptions) {
  const {
    feature,
    projectDir,
    config: inputConfig,
    sessionId: explicitSessionId,
    allowHooks: _allowHooks,
    purpose: requestedPurpose,
    ...options
  } = input;
  const hooks = inputConfig.hooks;
  if (hooks !== undefined && input.allowHooks === true) {
    markHooksConfigTrusted(projectDir, hooks);
  }
  const config = parsePreparedConfig(hooks === undefined ? inputConfig : { ...inputConfig, hooks });
  const sessionId =
    explicitSessionId ??
    generateSessionId({
      projectDir,
      feature,
    });
  ensureSessionDir(projectDir, sessionId);
  // An open run keeps the active pointer, so a second run in one project has to take it over the
  // way `prepareNewSession` does rather than collide with the run before it.
  if (readActive(projectDir) !== null && readActive(projectDir) !== sessionId) {
    rmSync(join(projectDir, SPLITBRIEF_DIR, 'active'), { force: true });
  }
  const active = reactivateExistingSession({ projectDir, sessionId });
  const preparationId = `workflow-test-${sessionId}`;
  const gates: RunnerGate[] = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
  ];
  const purpose = requestedPurpose ?? (input.savedState === undefined ? 'new-workflow' : 'resume');
  return runTrackedWorkflow({
    ...options,
    prepared: {
      purpose,
      config,
      sourceConfig: config,
      preparationId,
      report: readyReport(projectDir),
      gates,
      session: { kind: 'existing', ref: { projectDir, sessionId }, active },
      runtime: {
        feature,
        ...(input.savedState === undefined ? {} : { resumeState: input.savedState }),
        allowRepoRunners: false,
        allowHooks: true,
      },
    },
  });
}

type WorkflowRef = { projectDir: string; sessionId: string };

function stateFile(ref: WorkflowRef): string {
  return join(ref.projectDir, SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId, STATE_FILE);
}

function writeRawState(ref: WorkflowRef, state: unknown): void {
  writeFileSync(stateFile(ref), `${JSON.stringify(state)}\n`);
}

function legacyWorkflowState(feature: string): Record<string, unknown> {
  return {
    ...createInitialState(feature),
    stateVersion: 3,
    phase: 'reviewing-briefs',
    currentTaskIndex: 0,
    tasks: [],
    mode: 'standard',
    messageQueue: [],
  };
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
    validation: { endChecks: false, testCommand: 'noop' },
    workflow: {
      approve: 'none',
    },
  });
}

describe('runWorkflow — smoke', () => {
  it.each(['resumed-steer', 'pending-question', 'parked-card'] as const)(
    'delivers an attached file through %s and records compact text once',
    async (route) => {
      const projectDir = createTempDir(`workflow-attached-${route}`);
      dirs.push(projectDir);
      const ref = { projectDir, sessionId: `attached-${route}` };
      ensureSessionDir(projectDir, ref.sessionId);
      const message = attachedMessage(projectDir);
      const proposal = makePlanProposal();
      const state: WorkflowState = {
        ...transition(createInitialState('attached workflow'), { type: 'START' }),
        ...(route === 'pending-question'
          ? {
              pendingPlannerConversation: {
                call: 'plan' as const,
                text: '1. Which file?',
                questions: [{ id: 'q', type: 'input' as const, text: 'Which file?' }],
                answers: [],
                answered: false,
              },
            }
          : {}),
        ...(route === 'parked-card'
          ? {
              phase: 'reviewing-plan' as const,
              plan: PlanSchema.parse(proposal),
              tasks: proposal.tasks.map((task) => taskFromSpec(task, projectDir)),
            }
          : {}),
      };
      saveState(ref, state);
      if (route === 'parked-card')
        writeFileSync(
          join(sessionDir(projectDir, ref.sessionId), 'plan.json'),
          JSON.stringify(proposal),
        );
      const controller = new AbortController();
      const typed = scriptedTypedCall([proposal]);
      const events: EngineEvent[] = [];
      await runWorkflow({
        ...ref,
        feature: state.feature,
        savedState: state,
        steer: message,
        config: makeConfig({
          codebase: { enabled: false, tokenBudget: 4000 },
          workflow: { approve: 'plan', isolation: 'none' },
          validation: { endChecks: false, testCommand: 'noop' },
        }),
        callbacks: makeCallbacks({
          onApprovalNeeded: async () => {
            controller.abort();
            return { approved: false };
          },
        }).callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        signal: controller.signal,
        _planner: makePlanner({ typedCall: typed.typedCall }),
        _eventSink: (event) => events.push(event),
      });
      expect(typed.prompts[0]).toContain('PELICAN-42');
      await expectCompactMessage(ref, events, message);
      await expectResumedMessage(ref, message);
    },
  );

  it('keeps the prepared runner config after mutable config changes', async () => {
    const projectDir = setupProject();
    const mutableConfig = makeConfig({
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: { approve: 'none' },
    });
    const config = parsePreparedConfig(mutableConfig);
    const feature = 'prepared snapshot';
    const sessionId = 'prepared-config-snapshot';
    ensureSessionDir(projectDir, sessionId);
    const active = reactivateExistingSession({ projectDir, sessionId });
    const preparationId = 'prepared-config-snapshot';
    const { callbacks } = makeCallbacks();

    mutableConfig.planner = {
      kind: 'agent',
      command: '/changed/after/preparation',
    };

    const summary = await runTrackedWorkflow({
      prepared: {
        purpose: 'new-workflow',
        config,
        sourceConfig: config,
        preparationId,
        report: readyReport(projectDir),
        gates: [
          makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
          makeRunnerGate(
            config.implementer,
            { role: 'implementer', profile: 'default' },
            preparationId,
          ),
        ],
        session: { kind: 'existing', ref: { projectDir, sessionId }, active },
        runtime: { feature, allowRepoRunners: false, allowHooks: false },
      },
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner(),
      _implementer: makeImplementer(),
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.planner)).toBe(true);
    expect(summary.plannerTool).toBe('claude-code');
  });

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

    expect(summary.feature).toBe('add auth');
    expect(summary.totalTasks).toBe(0);

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
    const onContinuationNeeded = vi.fn(async () => plainUserMessage('should not run'));
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const typedCall = typedCallAnswering(
      async () => {
        expect(pendingBoundaryInterrupt).toBe(false);
        return planFromTasks([
          makeTask({
            id: 'T001',
            scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the planned task ran'],
            typeDefs: 'type DrainTask = { file: string }',
          }),
        ]);
      },
      { inputTokens: 50, outputTokens: 25 },
    );

    const summary = await runWorkflow({
      feature: 'stale boundary interrupt',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
        },
      }),
      callbacks,
      sinks: {
        setAbortHandler: () => {},
        setQueueHandler: () => {},
        consumeBoundaryInterrupt,
      },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner({ typedCall }),
      _implementer: makeImplementer(),
    });

    expect(events.find((e) => e.type === 'turn_interrupted')).toBeUndefined();
    expect(onContinuationNeeded).not.toHaveBeenCalled();
    expect(typedCall).toHaveBeenCalled();
    expect(pendingBoundaryInterrupt).toBe(false);
    expect(summary.totalTasks).toBe(1);
  }, 20_000);

  it('records the planning failure as the stop reason of an open run', async () => {
    const projectDir = setupProject();
    const sessionId = 'planning-failed-sid';
    const { callbacks } = makeCallbacks();
    const config = makeConfig({
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
      },
    });

    // An available planner that returns zero briefs raises a halt the operator answers. The run
    // stays open — nothing closed it — and the record names the halt as why it stopped.
    await runWorkflow({
      feature: 'planning-failure',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner({
        typedCall: typedCallFromTasks([], { inputTokens: 50, outputTokens: 25 }),
      }),
    });

    const { listSessions } = await import('../../../core/sessions/io.js');
    const persisted = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(persisted).toMatchObject({ status: 'open', stop: 'waiting-for-you' });
  });

  it('initialization failure leaves the run open', async () => {
    const projectDir = setupProject();
    const sessionId = 'init-failed-sid';
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();

    // The planner is unavailable, so initializeWorkflow returns `ok: false` before any
    // planning work starts. Nothing closed the run, so it stays open and continuable.
    await runWorkflow({
      feature: 'init-failure',
      projectDir,
      config,
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    const { listSessions } = await import('../../../core/sessions/io.js');
    const persisted = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(persisted?.status).toBe('open');
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
    // so checkSessionLiveness can refuse a concurrent resume/continue. Assert the record on disk.
    const { readLockfile, checkSessionLiveness } = await import(
      '../../../core/sessions/lockfile.js'
    );
    const dir = sessionDir(projectDir, 'liveness-sid');
    const lock = readLockfile(dir);
    expect(lock).not.toBeNull();
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.sessionId).toBe('liveness-sid');
    expect(lock?.feature).toBe('liveness-record');
    expect(lock?.lastAliveMs).toBeGreaterThanOrEqual(before);

    // releaseLiveness() runs in the finally arm and marks the record exited (best-effort,
    // fire-and-forget) so the session no longer reads as alive once the run finishes.
    let status = checkSessionLiveness(dir);
    for (let i = 0; i < 50 && status.alive; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = checkSessionLiveness(dir);
    }
    expect(status.alive).toBe(false);
  });

  it('records a runner pid to the session ledger during the run and uninstalls the ledger once runWorkflow returns', async () => {
    const projectDir = setupProject();
    const sessionId = 'process-ledger-sid';
    const { callbacks } = makeCallbacks();
    const config = makeConfig({
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
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
        typedCall: typedCallAnswering(
          async () => {
            registerProcess(groupChild, { group: true });
            entriesDuringRun = readRunnerPids({ projectDir, sessionId });
            return planFromTasks([makeTask()]);
          },
          { inputTokens: 50, outputTokens: 25 },
        ),
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

  it("reaps a dead owner's runner-pid ledger before the run starts", async () => {
    const projectDir = setupProject();
    const sessionId = 'start-reap-sid';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    // A dead owner (pid 40001 no longer exists): the session's ledger is the
    // orphan reaper's to clear at the start of the next run.
    writeFileSync(
      join(sessionDir(projectDir, sessionId), LOCKFILE),
      JSON.stringify({
        version: 1,
        pid: 40001,
        startTimeMs: 1000,
        lastAliveMs: Date.now(),
        sessionId,
        mode: 'quick',
        feature: 'start reap',
      }),
    );

    // A real runner tool in a group of its own, recorded the way a run records it.
    const runner = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = runner.pid;
    if (pid === undefined) throw new Error('the runner child reported no pid');
    try {
      const startTimeMs = readProcessStartTimeMs(pid);
      expect(startTimeMs).not.toBeNull();
      recordRunnerPid(ref, pid, startTimeMs);
      expect(canSignalProcess(pid)).toBe(true);

      await runWorkflow({
        feature: 'start reap',
        projectDir,
        config: unavailablePlannerConfig(),
        callbacks: makeCallbacks().callbacks,
        sessionId,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      });

      expect(canSignalProcess(pid)).toBe(false);
      expect(readRunnerPids(ref)).toEqual([]);
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The start reap already took the runner's group down.
      }
    }
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
        onPlannerReply: vi.fn(async () => {
          throw new Error('question handler failed');
        }),
      });

      const summary = await runWorkflow({
        feature: 'process shutdown failure ordering',
        projectDir,
        sessionId,
        config: makeConfig({
          validation: { endChecks: false, testCommand: 'noop' },
          workflow: {
            approve: 'none',
          },
        }),
        callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        _planner: makePlanner({
          typedCall: typedCallAnswering(() => {
            registerProcess(child);
            return planQuestionsFrom([], 'Continue?');
          }),
        }),
        _implementer: makeImplementer(),
      });

      expect(summary.totalTasks).toBe(0);
      expect(JSON.parse(readFileSync(summaryPath, 'utf8'))).toMatchObject({ status: 'open' });
      expect(child.exitCode).toBe(0);
      expect(existsSync(observedEarlySummaryPath)).toBe(false);
    },
  );

  it('refuses to run when the same session already has a live non-detached owner', async () => {
    const projectDir = setupProject();
    const sessionId = 'liveness-conflict-sid';
    const { callbacks } = makeCallbacks();
    const config = unavailablePlannerConfig();
    const { writeLockfile } = await import('../../../core/sessions/lockfile.js');
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

  it('rejects a concurrent workflow before its planner crosses a provider boundary', async () => {
    const projectDir = setupProject();
    const sessionId = 'concurrent-run-sid';
    const config = makeConfig({
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: { approve: 'none' },
    });
    const releaseFirst = Promise.withResolvers<void>();
    const firstAvailability = vi.fn(async () => {
      await releaseFirst.promise;
      return false;
    });
    const firstPlanner = makePlanner({ isAvailable: firstAvailability });
    const firstRun = runWorkflow({
      feature: 'concurrent run owner',
      projectDir,
      config,
      callbacks: makeCallbacks().callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: firstPlanner,
    });

    try {
      await vi.waitFor(() => expect(firstAvailability).toHaveBeenCalledTimes(1));
      const secondPlanner = makePlanner({
        isAvailable: vi.fn(),
      });
      await expect(
        runWorkflow({
          feature: 'concurrent run owner',
          projectDir,
          config,
          callbacks: makeCallbacks().callbacks,
          sessionId,
          purpose: 'resume',
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          _planner: secondPlanner,
        }),
      ).rejects.toMatchObject({ kind: 'workflow-session-already-live' });
      expect(secondPlanner.isAvailable).not.toHaveBeenCalled();
      expect(secondPlanner.typedCall).not.toHaveBeenCalled();
    } finally {
      releaseFirst.resolve();
      await firstRun;
    }
  });

  it('leaves an unmigrated legacy state untouched and keeps provider work out of the path', async () => {
    const projectDir = setupProject();
    const sessionId = 'legacy-state-sid';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    writeRawState(ref, legacyWorkflowState('legacy state'));
    const before = readFileSync(stateFile(ref));

    const planner = makePlanner({ isAvailable: vi.fn() });
    const summary = await runWorkflow({
      feature: 'legacy state',
      projectDir,
      config: unavailablePlannerConfig(),
      callbacks: makeCallbacks().callbacks,
      sessionId,
      purpose: 'resume',
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: planner,
    });

    expect(summary.totalTasks).toBe(0);
    expect(readFileSync(stateFile(ref))).toEqual(before);
    expect(planner.isAvailable).not.toHaveBeenCalled();
    expect(planner.typedCall).not.toHaveBeenCalled();
    expect(planner.review).not.toHaveBeenCalled();
  });

  it('rejects a future state without rewriting bytes or invoking the planner', async () => {
    const projectDir = setupProject();
    const sessionId = 'future-state-sid';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    writeRawState(ref, { ...legacyWorkflowState('future state'), stateVersion: 99 });
    const before = readFileSync(stateFile(ref));
    const planner = makePlanner({
      isAvailable: vi.fn(),
    });

    const summary = await runWorkflow({
      feature: 'future state',
      projectDir,
      config: unavailablePlannerConfig(),
      callbacks: makeCallbacks().callbacks,
      sessionId,
      purpose: 'resume',
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: planner,
    });

    expect(summary.totalTasks).toBe(0);
    expect(readFileSync(stateFile(ref))).toEqual(before);
    expect(planner.isAvailable).not.toHaveBeenCalled();
    expect(planner.typedCall).not.toHaveBeenCalled();
  });

  it('drops the stop the halted pass recorded once the run is resumed', async () => {
    const projectDir = setupProject();
    const sessionId = 'resumed-halt-sid';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const resumed = makeImplStateWithMetadata([makeTask({ id: 'T001' })]);
    saveState(ref, resumed);
    saveSummary(ref, {
      id: sessionId,
      feature: 'resumed halt',
      startedAt: 1,
      completedAt: 2,
      stateVersion: resumed.stateVersion,
      status: 'open',
      summary: null,
      stop: 'waiting-for-you',
    });
    let stopWhileRunning: string | undefined = 'not read';
    const planner = makePlanner({
      isAvailable: vi.fn(async () => {
        stopWhileRunning = readSession(ref)?.stop;
        return false;
      }),
    });

    await runWorkflow({
      feature: 'resumed halt',
      projectDir,
      config: unavailablePlannerConfig(),
      callbacks: makeCallbacks().callbacks,
      sessionId,
      purpose: 'resume',
      savedState: resumed,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: planner,
    });

    expect(planner.isAvailable).toHaveBeenCalledTimes(1);
    expect(stopWhileRunning).toBeUndefined();
  });

  it('refuses a new-workflow run over a session that already started', async () => {
    const projectDir = setupProject();
    const sessionId = 'already-started-sid';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    saveState(ref, makeImplStateWithMetadata([makeTask({ id: 'T001' })]));
    const before = readFileSync(stateFile(ref));
    const planner = makePlanner({ isAvailable: vi.fn() });

    await expect(
      runWorkflow({
        feature: 'already started',
        projectDir,
        config: unavailablePlannerConfig(),
        callbacks: makeCallbacks().callbacks,
        sessionId,
        purpose: 'new-workflow',
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        _planner: planner,
      }),
    ).rejects.toMatchObject({
      kind: 'workflow-session-already-started',
      data: { sessionId, phase: 'implementing' },
    });

    expect(readFileSync(stateFile(ref))).toEqual(before);
    expect(planner.isAvailable).not.toHaveBeenCalled();
    expect(planner.typedCall).not.toHaveBeenCalled();
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
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
      },
    });

    const controller = new AbortController();
    controller.abort();
    const events: EngineEvent[] = [];

    const summary = await runWorkflow({
      feature: 'aborted-before-start',
      projectDir,
      config,
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _eventSink: (e) => events.push(e),
    });

    expect(summary.totalTasks).toBe(0);
    expect(events.some((e) => e.type === 'task_started')).toBe(false);
    expect(summary.feature).toBe('aborted-before-start');
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
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _eventSink: (event) => events.push(event),
      _planner: makePlanner({
        typedCall: typedCallAnswering(async () => {
          controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
          return planFromTasks([makeTask()]);
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(events.find((event) => event.type === 'workflow_cancelled')).toMatchObject({
      type: 'workflow_cancelled',
      reason: 'user_cancelled',
    });
  });

  it('End run closes the run on the state', async () => {
    const projectDir = setupProject();
    const sessionId = 'user-cancel-sid';
    const { callbacks } = makeCallbacks();
    const controller = new AbortController();

    await runWorkflow({
      feature: 'end the run',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'none' },
      }),
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _planner: makePlanner({
        typedCall: typedCallFromTasks([
          makeTask({
            id: 'T001',
            scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the planned task ran'],
            typeDefs: 'type HelloTask = { file: string }',
          }),
        ]),
      }),
      _implementer: makeImplementer({
        implement: vi.fn().mockImplementation(async () => {
          controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
          return { success: false, output: '', usage: null };
        }),
      }),
    });

    const { listSessions } = await import('../../../core/sessions/io.js');
    expect(listSessions(projectDir).find((s) => s.id === sessionId)?.status).toBe('ended');
    const { loadState } = await import('../../../core/state/persistence.js');
    expect(loadState({ projectDir, sessionId })?.closed?.as).toBe('ended');
  });

  it('a plain abort parks the step and leaves the run open', async () => {
    const projectDir = setupProject();
    const sessionId = 'plain-pause-sid';
    const { callbacks } = makeCallbacks();
    const controller = new AbortController();

    await runWorkflow({
      feature: 'pause the run',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'none' },
      }),
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _planner: makePlanner({
        typedCall: typedCallFromTasks([
          makeTask({
            id: 'T001',
            scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the planned task ran'],
            typeDefs: 'type HelloTask = { file: string }',
          }),
        ]),
      }),
      _implementer: makeImplementer({
        implement: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { success: false, output: '', usage: null };
        }),
      }),
    });

    const { listSessions } = await import('../../../core/sessions/io.js');
    const row = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(row?.status).toBe('open');
    expect(row?.stop).toBe('stopped');
    const { loadState } = await import('../../../core/state/persistence.js');
    const saved = loadState({ projectDir, sessionId });
    expect(saved?.closed).toBeUndefined();
    expect(saved?.interruptedStep?.source).toBe('user');
    const { events } = await readRunEvents({ projectDir, sessionId });
    expect(events.findLast((event) => event.type === 'turn_interrupted')).toMatchObject({
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: 'T001' },
    });
  });

  it('records a stop at an open gate as the last row of session.jsonl, naming the gate', async () => {
    const projectDir = setupProject();
    const sessionId = 'gate-stop-sid';
    const controller = new AbortController();
    let stoppedAt = 0;
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn(async () => {
        stoppedAt = Date.now();
        controller.abort();
        return { approved: false as const };
      }),
    });

    await runWorkflow({
      feature: 'stop at the plan approval',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'plan' },
      }),
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _planner: makePassingPlanner(),
    });

    const gate = { kind: 'gate', gate: 'plan' } as const;
    // A gate runs no call, so the stop there cut nothing.
    expect(loadState({ projectDir, sessionId })?.interruptedStep).toMatchObject({
      step: gate,
      source: 'user',
      cut: 'boundary',
    });
    const { events } = await readRunEvents({ projectDir, sessionId });
    const logged = events.filter(
      (event) => event.type !== 'replay_started' && event.type !== 'replay_complete',
    );
    const last = logged.at(-1);
    expect(last).toMatchObject({
      type: 'turn_interrupted',
      phase: 'reviewing-plan',
      source: 'user',
      at: 'boundary',
      step: gate,
    });
    // The run at rest reads its clock off the last row, so the clock ends at the stop.
    expect(last?.ts).toBeGreaterThanOrEqual(stoppedAt);
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

  it('preserves the persisted rewind request when an approval gate aborts the turn', async () => {
    const projectDir = setupProject();
    const sessionId = 'approval-rewind-sid';
    const controller = new AbortController();
    const config = makeConfig({
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        approve: 'plan',
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
            rewindPending: { target: 'plan', comment: 'rewind to the plan' },
          },
        );
        controller.abort();
        throw error('operation-aborted', 'approval gate cancelled');
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
      comment: 'rewind to the plan',
    });
    expect(loadState({ projectDir, sessionId })?.phase).toBe('reviewing-plan');
  });

  it('records the plan approval in session.jsonl', async () => {
    const projectDir = setupProject();
    const sessionId = 'gate-approvals-sid';
    const controller = new AbortController();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });

    await runWorkflow({
      feature: 'record the gate approvals',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'plan' },
      }),
      callbacks,
      sessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _planner: makePassingPlanner(),
      _implementer: makeImplementer({
        implement: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { success: false, output: '', usage: null };
        }),
      }),
    });

    expect(onApprovalNeeded.mock.calls.map(([type]) => type)).toEqual(['plan']);
    const { events } = await readRunEvents({ projectDir, sessionId });
    expect(
      events
        .filter((event) => event.type.endsWith('_approved'))
        .map((event) => [event.type, 'phase' in event ? event.phase : undefined]),
    ).toEqual([['plan_approved', 'reviewing-plan']]);
  });

  it('keeps the active session for an aborted run so it can be picked up', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const sessionId = 'explicit-normal-abort-sid';
    const config = makeConfig({
      planner: { kind: 'agent', command: 'echo', args: ['done'] },
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        approve: 'none',
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

    // An abort parks the run rather than ending it, so `splitbrief resume` still finds it.
    expect(readActive(projectDir)).toBe(sessionId);
  });

  it('carries the planner-produced tasks straight into the task loop and completes them', async () => {
    // planning.state flows directly into runTasksAndReview: the planner's task is
    // implemented and counted in the summary.
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    const summary = await runWorkflow({
      feature: 'carry planned task',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (e) => events.push(e),
      _planner: makePlanner({
        typedCall: typedCallFromTasks(
          [
            makeTask({
              id: 'T001',
              scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
              evidence: ['task_completed event shows the planned task ran'],
              typeDefs: 'type HelloTask = { file: string }',
            }),
          ],
          { inputTokens: 50, outputTokens: 25 },
        ),
      }),
      _implementer: makeImplementer(),
    });

    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({ taskId: 'T001' });
    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBe(1);
  }, 20_000);

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
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
        },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (event) => events.push(event),
      _planner: makePlanner({
        typedCall: typedCallAnswering(async (_prompt, opts) => {
          opts.callbacks.onCallEvent?.({ type: 'call_started', ts: startedAt, ...call });
          opts.callbacks.onCallEvent?.({
            type: 'call_tool_use_done',
            ts: startedAt + 1,
            ...call,
            channel: 'tool',
            toolUse: { id: 'tool-read-1', name: 'Read', input: { file_path: 'src/hello.ts' } },
          });
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
          return planFromTasks([makeTask()]);
        }),
      }),
      _implementer: makeImplementer(),
    });

    expect(
      events.filter((event) => event.type.startsWith('runner_call_')).map((event) => event.type),
    ).toEqual([
      'runner_call_started',
      'runner_call_tool_use',
      'runner_call_activity',
      'runner_call_usage',
      'runner_call_completed',
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
      kind: 'read',
      label: 'reading src/hello.ts',
    });
  });

  it('publishes the final review runner_call events when no reviewer is configured', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];

    await runWorkflow({
      feature: 'inherited review seat call events',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'none' },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (event) => events.push(event),
      _planner: makePlanner({
        typedCall: typedCallPlanAndReview(
          () =>
            planFromTasks([
              makeTask({
                id: 'T001',
                title: 'Reviewable task',
                suggestedFiles: ['src/reviewable.ts'],
                scope: { inBounds: ['src/reviewable.ts'], outOfBounds: ['other files'] },
                evidence: ['task_completed event shows the task ran'],
                typeDefs: 'type ReviewableTask = { file: string }',
              }),
            ]),
          (prompt, _call, callbacks) => {
            emitReviewCall(callbacks, 'test-planner');
            return passingReviewVerdict(prompt);
          },
        ),
      }),
      _implementer: makeImplementer(),
    });

    expect(reviewCallEvents(events)).toEqual([
      { type: 'runner_call_started', runnerName: 'test-planner' },
      { type: 'runner_call_completed', runnerName: 'test-planner' },
    ]);
  }, 40_000);

  it('publishes the final review runner_call events naming the configured reviewer', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const events: EngineEvent[] = [];
    const planner = makePlanner({
      typedCall: typedCallFromTasks([
        makeTask({
          id: 'T001',
          title: 'Reviewable task',
          suggestedFiles: ['src/reviewable.ts'],
          scope: { inBounds: ['src/reviewable.ts'], outOfBounds: ['other files'] },
          evidence: ['task_completed event shows the task ran'],
          typeDefs: 'type ReviewableTask = { file: string }',
        }),
      ]),
    });

    await runWorkflow({
      feature: 'configured review seat call events',
      projectDir,
      config: makeConfig({
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'none' },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (event) => events.push(event),
      _planner: planner,
      _implementer: makeImplementer(),
      _reviewer: {
        review: vi.fn(),
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt, _call, callbacks) => {
            emitReviewCall(callbacks, 'test-reviewer');
            return passingReviewVerdict(prompt);
          },
        ),
      },
    });

    expect(reviewCallEvents(events)).toEqual([
      { type: 'runner_call_started', runnerName: 'test-reviewer' },
      { type: 'runner_call_completed', runnerName: 'test-reviewer' },
    ]);
    expect(planner.review).not.toHaveBeenCalled();
  }, 40_000);

  it('builds the run isolation handle once per run and disposes it once, including on the abort path', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const isolationModule = await import('../isolation/create.js');
    const originalCreate = isolationModule.createRunIsolation;
    let disposeCalls = 0;
    const createSpy = vi.spyOn(isolationModule, 'createRunIsolation').mockImplementation((opts) => {
      const handle = originalCreate(opts);
      return {
        open: handle.open,
        acquire: handle.acquire,
        dispose: async () => {
          disposeCalls += 1;
          await handle.dispose();
        },
      };
    });
    try {
      await runWorkflow({
        feature: 'isolation lifecycle',
        projectDir,
        config: unavailablePlannerConfig(),
        callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      });

      const controller = new AbortController();
      controller.abort();
      await runWorkflow({
        feature: 'isolation lifecycle abort',
        projectDir,
        config: makeConfig({
          planner: { kind: 'agent', command: 'echo', args: ['done'] },
          validation: { endChecks: false, testCommand: 'noop' },
          workflow: { approve: 'none' },
        }),
        callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        signal: controller.signal,
      });

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(disposeCalls).toBe(2);
    } finally {
      createSpy.mockRestore();
    }
  });

  it('catches and warns an isolation dispose failure instead of throwing out of runWorkflow', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const isolationModule = await import('../isolation/create.js');
    const originalCreate = isolationModule.createRunIsolation;
    const createSpy = vi.spyOn(isolationModule, 'createRunIsolation').mockImplementation((opts) => {
      const handle = originalCreate(opts);
      return {
        open: handle.open,
        acquire: handle.acquire,
        dispose: async () => {
          throw new Error('dispose boom');
        },
      };
    });
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runWorkflow({
        feature: 'isolation dispose failure',
        projectDir,
        config: unavailablePlannerConfig(),
        callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      });

      expect(
        stderrWrite.mock.calls.some(([chunk]) =>
          String(chunk).includes('Could not remove the run workspace'),
        ),
      ).toBe(true);
    } finally {
      createSpy.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});

describe('runWorkflow — checkout run snapshot', () => {
  it('records the checkout as the run left it once disposal settles its last revert', async () => {
    const projectDir = setupProject();
    const sessionId = 'checkout-rest-snapshot';
    const isolationModule = await import('../isolation/create.js');
    const originalCreate = isolationModule.createRunIsolation;
    const createSpy = vi.spyOn(isolationModule, 'createRunIsolation').mockImplementation((opts) => {
      const handle = originalCreate(opts);
      return {
        open: handle.open,
        acquire: handle.acquire,
        dispose: async () => {
          writeFileSync(join(projectDir, 'settled-at-dispose.txt'), 'settled\n');
          await handle.dispose();
        },
      };
    });
    try {
      await runWorkflow({
        feature: 'checkout rest snapshot',
        projectDir,
        sessionId,
        config: makeConfig({
          validation: { endChecks: false, testCommand: 'noop' },
          workflow: { approve: 'none', isolation: 'none' },
        }),
        callbacks: makeCallbacks().callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        _planner: makePlanner({
          typedCall: typedCallFromTasks([makeTask({ id: 'T001' })], {
            inputTokens: 50,
            outputTokens: 25,
          }),
        }),
        _implementer: makeImplementer(),
      });

      const ledger = await readRunSnapshotLedger(projectDir, sessionId);
      if (ledger === null) throw new Error('the checkout run recorded no run snapshot');
      const latest = await resolveLedgerRunSnapshot(projectDir, sessionId, ledger);
      expect(latest?.fileHashes['settled-at-dispose.txt']).toBeDefined();
      expect(ledger.runSnapshotKinds?.[latest?.id ?? '']).toBe('post-task');
    } finally {
      createSpy.mockRestore();
    }
  }, 20_000);
});

describe('runWorkflow — orphan session sweep', () => {
  function oldMtime(): Date {
    return new Date(Date.now() - ORPHAN_SESSION_GRACE_MS - 60_000);
  }

  function readinessOnly(projectDir: string, sessionId: string, mtime: Date): string {
    const directory = sessionDir(projectDir, sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, READINESS_FILE), '{}');
    utimesSync(directory, mtime, mtime);
    return directory;
  }

  it('starts a run even when a session directory cannot be read', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const unreadable = readinessOnly(projectDir, '2026-08-04-sweep-unreadable', oldMtime());
    chmodSync(unreadable, 0o000);

    try {
      await runWorkflow({
        feature: 'sweep unreadable session',
        projectDir,
        config: unavailablePlannerConfig(),
        callbacks,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      });

      expect(existsSync(unreadable)).toBe(true);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });

  it('removes exactly the collectable directory and leaves every other kind on disk', async () => {
    const projectDir = setupProject();
    const { callbacks } = makeCallbacks();
    const old = readinessOnly(projectDir, '2026-08-04-sweep-old', oldMtime());

    const withState = sessionDir(projectDir, '2026-08-04-sweep-state');
    mkdirSync(withState, { recursive: true });
    writeFileSync(join(withState, 'state.json'), '{}');
    utimesSync(withState, oldMtime(), oldMtime());

    const fresh = readinessOnly(
      projectDir,
      '2026-08-04-sweep-fresh',
      new Date(Date.now() - 60_000),
    );

    const claim = join(
      sessionsRoot(projectDir),
      '.2026-08-04-sweep-claim.directory.11111111-1111-4111-8111-111111111111.claim',
    );
    mkdirSync(claim, { recursive: true });

    // The run's own session is the active readiness-only directory, aged past the grace
    // period, so the active guard is what keeps it — whatever its age.
    const activeSessionId = '2026-08-04-sweep-active';
    const active = readinessOnly(projectDir, activeSessionId, oldMtime());

    await runWorkflow({
      feature: 'sweep every kind',
      projectDir,
      config: unavailablePlannerConfig(),
      callbacks,
      sessionId: activeSessionId,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
    });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(withState)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(claim)).toBe(true);
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
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        git: { createBranch: true },
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
    expect(branchEvent?.name).toBe('splitbrief/add-auth');

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
      validation: { endChecks: false, testCommand: 'noop' },
      workflow: {
        git: { createBranch: false },
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
  it('resumes final review without publishing planner_status before review_started', async () => {
    const projectDir = setupProject();
    const sessionId = 'resume-final-review';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const savedState = persistReadyExecutionState(
      ref,
      makeImplStateWithMetadata([makeTask({ id: 'T001', status: 'done' })], {
        phase: 'final-review',
        currentTaskIndex: 1,
        changedFilesBaseline: serializeChangedFilesBaseline(
          await captureChangedFilesBaseline(projectDir),
        ),
      }),
    );
    const events: EngineEvent[] = [];
    await runWorkflow({
      feature: savedState.feature,
      projectDir,
      sessionId,
      savedState,
      config: makeConfig({
        validation: { endChecks: false },
        workflow: { approve: 'none' },
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _eventSink: (event) => events.push(event),
      _planner: makePassingPlanner(),
      _implementer: makeImplementer(),
    });
    const reviewStart = events.findIndex((event) => event.type === 'review_started');
    expect(reviewStart).toBeGreaterThan(-1);
    expect(events.slice(0, reviewStart).some((event) => event.type === 'workflow_resumed')).toBe(
      true,
    );
    expect(events.slice(0, reviewStart).filter((event) => event.type === 'planner_status')).toEqual(
      [],
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'review_completed', verdict: 'pass' }),
    );
  });

  it('delivers an attached file on a task retry and publishes compact text once after restart', async () => {
    const projectDir = createTempDir('workflow-attached-task-retry');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'attached-task-retry' };
    ensureSessionDir(projectDir, ref.sessionId);
    const message = attachedMessage(projectDir);
    const task = makeTask({ id: 'T001', status: 'failed' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      validationSummary: 'failed check',
      attempts: 1,
      maxAttempts: 2,
      allowRetryOverride: true,
      createdAt: new Date().toISOString(),
    });
    const state: WorkflowState = {
      ...makeImplStateWithMetadata([task]),
      phase: 'escalating',
      pendingRecovery: issue,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    bus.subscribe(createJsonlSink(ref));
    const result = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      comment: message,
      bus,
    });
    expect(result.ok).toBe(true);
    expect(events.filter((event) => event.type === 'user_message')).toEqual([]);
    const controller = new AbortController();
    let turn = '';
    const implementer = makeImplementer({
      implement: async (call) => {
        turn = call.continuation?.steer ?? '';
        controller.abort();
        return { success: false, output: '', error: 'stopped after the turn' };
      },
    });
    await runWorkflow({
      ...ref,
      feature: state.feature,
      savedState: result.state,
      steer: message,
      config: makeConfig({
        workflow: { approve: 'none', isolation: 'none' },
        codebase: { enabled: false, tokenBudget: 4000 },
        validation: { endChecks: false, testCommand: 'noop' },
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      signal: controller.signal,
      _planner: makePlanner(),
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });
    expect(turn).toContain('PELICAN-42');
    const persisted = loadState(ref);
    expect(JSON.stringify(persisted?.lineages)).toContain('PELICAN-42');
    await expectCompactMessage(ref, events, message);
    await expectResumedMessage(ref, message);
  });

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
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
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
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
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
    const { listSessions } = await import('../../../core/sessions/io.js');
    const persisted = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(persisted?.startedAt).toBe(originalStartMs);
  });

  it('prices the resumed summary at the state-pinned runner identity while naming the seat in use', async () => {
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
    // The new config switches the implementer to a custom endpoint: the resumed summary
    // names that seat, and the cost breakdown still attributes the cumulative usage to the
    // state-pinned runner that actually spent it.
    const summary = await runWorkflow({
      feature: 'feat',
      projectDir,
      config: makeConfig({
        implementer: {
          provider: 'custom-endpoint',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
        },
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: {
          approve: 'none',
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
    expect(summary.plannerKind).toBe('cli');
    expect(summary.implementerTool).toBe('custom-endpoint');
    expect(summary.implementerModel).toBe('deepseek-chat');
    expect(summary.implementerKind).toBe('api');
    expect(summary).not.toHaveProperty('reviewerKind');
    // Nothing was ever spent on the seat the run now names, so no cost may be
    // attributed to it: the breakdown follows the state, not the identity.
    expect(summary.costBreakdown?.providerCosts?.['custom-endpoint']).toBeUndefined();
  });

  it('keeps the effort each seat runs at in the summary of the run', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-run-axes';
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
    const savedState = transition(implementingState([task]), {
      type: 'SET_PENDING_RECOVERY',
      issue,
    });
    saveState({ projectDir, sessionId }, savedState);

    const { callbacks } = makeCallbacks();
    const summary = await runWorkflow({
      feature: 'feat',
      projectDir,
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet', effort: 'medium' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', effort: 'low' },
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'none' },
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
      _reviewer: { review: vi.fn(), typedCall: vi.fn() },
    });

    expect(summary.plannerAxes).toEqual(['high']);
    expect(summary.implementerAxes).toEqual(['medium']);
    expect(summary.reviewerAxes).toEqual(['low']);
  });
});

describe('runWorkflow — a run still in flight when its test ends', () => {
  const leaked: {
    projectDir: string;
    seatSignal: AbortSignal | undefined;
    projectExistedOnAbort: boolean;
    settled: boolean;
  } = { projectDir: '', seatSignal: undefined, projectExistedOnAbort: false, settled: false };

  it('ends its test with the run blocked in the implementer seat, as a timed-out test does', async () => {
    const projectDir = setupProject();
    leaked.projectDir = projectDir;
    const { callbacks } = makeCallbacks();
    let seatEntered: () => void = () => {};
    const inSeat = new Promise<void>((resolve) => {
      seatEntered = resolve;
    });

    const run = runWorkflow({
      feature: 'in flight at teardown',
      projectDir,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
        workflow: { approve: 'none' },
      }),
      callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      _planner: makePlanner({
        typedCall: typedCallFromTasks([
          makeTask({
            id: 'T001',
            scope: { inBounds: ['src/hello.ts'], outOfBounds: ['other files'] },
            evidence: ['task_completed event shows the planned task ran'],
            typeDefs: 'type HelloTask = { file: string }',
          }),
        ]),
      }),
      _implementer: makeImplementer({
        implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
          leaked.seatSignal = opts.signal;
          seatEntered();
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener(
              'abort',
              () => {
                leaked.projectExistedOnAbort = existsSync(projectDir);
                resolve();
              },
              { once: true },
            );
          });
          return { success: false, output: '', usage: null };
        }),
      }),
    });
    void run.then(
      () => {
        leaked.settled = true;
      },
      () => {
        leaked.settled = true;
      },
    );

    await inSeat;
  });

  it('was aborted and awaited by the teardown before its project was deleted', () => {
    expect(leaked.seatSignal, 'the previous test must run first').toBeDefined();
    expect(leaked.seatSignal?.aborted).toBe(true);
    expect(leaked.projectExistedOnAbort).toBe(true);
    expect(leaked.settled).toBe(true);
    expect(existsSync(leaked.projectDir)).toBe(false);
  });
});
