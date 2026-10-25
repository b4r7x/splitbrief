import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
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
import { formatTasks } from '../../spec/formatter.js';
import { parsePlanJson } from '../../../core/sessions/plan-file.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { WorkflowStateSchema, type WorkflowState } from '../../../core/schemas/workflow.js';
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
  PLAN_FILE,
  PLAN_JSON_FILE,
  STATE_FILE,
  TASKS_FILE,
  sessionDir,
  sessionsRoot,
} from '../../../core/paths.js';
import { ORPHAN_SESSION_GRACE_MS } from '../../../core/sessions/orphans.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { listSessions, readSession, saveSummary } from '../../../core/sessions/io.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { loadOwnerWorkflowState } from '../../../core/state/resume-hydration.js';
import { forgetCachedState, statePath } from '../../../core/state/state-file.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
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
import { toErrorMessage } from '../../../utils/format-errors.js';
import { parsePreparedConfig, type RunnerGate } from '../../runners/prepared-execution.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { shutdownWorkflow } from '../session-lifecycle/shutdown.js';
import { boundEngineEventForConsumer } from '../../events/bound.js';
import { readRunEvents } from '../../events/replay.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../../core/schemas/session-log.js';
import { CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER } from '../../../core/payload-bounds.js';
import { buildResumeContext } from '../transcript/rebuild.js';
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

// A state.json write SPLITBRIEF renamed into place but could not confirm on disk (a failing disk,
// EIO on a network mount): every write once `unconfirmed` is set, or only the `next` write made
// from the named function, which `eio` fails before anything is written and `conflict` finds
// changed by another writer (`conflict-twice`: that write and its retry); `thenEvery` makes every
// later write unconfirmed too, or, after `enospc`, fails every later write on a full disk. Every
// other write is real.
const stateWrite = vi.hoisted(() => ({
  unconfirmed: false,
  full: false,
  next: undefined as
    | {
        from: string;
        fails: 'unconfirmed' | 'eio' | 'enospc' | 'conflict' | 'conflict-twice';
        thenEvery?: true;
      }
    | undefined,
}));
// The run file whose write is refused, the way a folder that takes no new file refuses its
// temporary copy; the writer names the file it meant.
const secureWrite = vi.hoisted(() => ({ refuses: undefined as string | undefined }));
vi.mock('../../../lib/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/fs.js')>();
  const { basename, dirname, join } = await import('node:path');
  return {
    ...actual,
    writeSecureFile: (filePath: string, content: string): void => {
      if (basename(filePath) !== secureWrite.refuses) {
        actual.writeSecureFile(filePath, content);
        return;
      }
      const temp = join(dirname(filePath), `.${basename(filePath)}.tmp.0123456789abcdef`);
      throw Object.assign(new Error(`EACCES: permission denied, open '${temp}'`), {
        code: 'EACCES',
        syscall: 'open',
        path: filePath,
      });
    },
  };
});
vi.mock('../../../lib/confined-fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/confined-fs-atomic.js')>();
  return {
    ...actual,
    confinedAtomicWriteFileSync: (
      ...args: Parameters<typeof actual.confinedAtomicWriteFileSync>
    ): ReturnType<typeof actual.confinedAtomicWriteFileSync> => {
      const next = stateWrite.next;
      const enospc = () =>
        Object.assign(new Error(`ENOSPC: no space left on device, open '${args[0]}'`), {
          code: 'ENOSPC',
        });
      if (stateWrite.full && args[0].endsWith('/state.json')) throw enospc();
      if (
        next !== undefined &&
        args[0].endsWith('/state.json') &&
        new Error().stack?.includes(` ${next.from} (`)
      ) {
        stateWrite.next =
          next.fails === 'conflict-twice' ? { ...next, fails: 'conflict' } : undefined;
        if (next.thenEvery) stateWrite[next.fails === 'enospc' ? 'full' : 'unconfirmed'] = true;
        if (next.fails === 'enospc') throw enospc();
        if (next.fails === 'eio') {
          throw Object.assign(new Error(`EIO: i/o error, open '${args[0]}'`), { code: 'EIO' });
        }
        if (next.fails === 'conflict' || next.fails === 'conflict-twice') {
          return { kind: 'conflict', observedRevision: null };
        }
        const written = actual.confinedAtomicWriteFileSync(...args);
        if (written.kind === 'written') {
          return { kind: 'durability-uncertain', observedRevision: written.revision };
        }
        return written;
      }
      const written = actual.confinedAtomicWriteFileSync(...args);
      return stateWrite.unconfirmed && args[0].endsWith('/state.json') && written.kind === 'written'
        ? { kind: 'durability-uncertain', observedRevision: written.revision }
        : written;
    },
  };
});

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

  it('names a task state write it cannot confirm in plain words, once per failed step', async () => {
    const projectDir = setupProject();
    const sessionId = 'unconfirmed-sid';
    const message = `Saved the run state, but could not confirm it on disk · .splitbrief/sessions/${sessionId}/state.json`;
    const events: EngineEvent[] = [];
    let plainCause: string | undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await runWorkflow({
        feature: 'unconfirmed state',
        projectDir,
        config: makeConfig({
          validation: { endChecks: false, testCommand: 'noop' },
          workflow: { approve: 'none' },
        }),
        callbacks: makeCallbacks().callbacks,
        sessionId,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        headless: true,
        plain: true,
        // What `--plain` prints as the cause of the failed run, read as `runHeadless` reads it.
        tuiSink: (event) => {
          const bounded = boundEngineEventForConsumer(event, 'stdout-text');
          if (bounded.type === 'error') plainCause = bounded.message;
        },
        _eventSink: (event) => {
          events.push(event);
          // The next state write is the task-start snapshot of the task loop.
          if (event.type === 'task_started') stateWrite.unconfirmed = true;
        },
        _planner: makePlanner({ typedCall: typedCallFromTasks([makeTask({ id: 'T001' })]) }),
        _implementer: makeImplementer(),
      });
      // A quit after the failure writes the state once more, and it is not confirmed again.
      await shutdownWorkflow({
        projectDir,
        sessionId,
        getTrackedState: () => loadState({ projectDir, sessionId }) ?? undefined,
        getCurrentTask: () => undefined,
      });
    } finally {
      stateWrite.unconfirmed = false;
      vi.restoreAllMocks();
    }

    expect(events.flatMap((event) => (event.type === 'error' ? [event.message] : []))).toEqual([
      message,
    ]);
    expect(plainCause).toBe(message);
    expect(loadState({ projectDir, sessionId })?.lastFailure?.message).toBe(message);
    expect(stderr).toEqual([`${message}\n`]);
    expect([...stdout, ...stderr].join('')).not.toMatch(
      /durability|persist|Failed to save|Could not record/,
    );
  });

  describe('records a state write it cannot save or confirm as why the run failed', () => {
    const unconfirmed = (sessionId: string) =>
      `Saved the run state, but could not confirm it on disk · .splitbrief/sessions/${sessionId}/state.json`;

    async function runWithStateWrite(
      sessionId: string,
      next: typeof stateWrite.next,
      armOn: EngineEvent['type'] | 'start',
      options: Partial<WorkflowTestOptions> = {},
    ) {
      const projectDir = options.projectDir ?? setupProject();
      const events: EngineEvent[] = [];
      let plainCause: string | undefined;
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      if (armOn === 'start') stateWrite.next = next;
      let thrown: string | undefined;
      try {
        await runWorkflow({
          feature: 'state write',
          projectDir,
          config: makeConfig({
            validation: { endChecks: false, testCommand: 'noop' },
            workflow: { approve: 'none' },
          }),
          callbacks: makeCallbacks().callbacks,
          sessionId,
          sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
          headless: true,
          plain: true,
          tuiSink: (event) => {
            const bounded = boundEngineEventForConsumer(event, 'stdout-text');
            if (bounded.type === 'error') plainCause = bounded.message;
          },
          _eventSink: (event) => {
            events.push(event);
            if (event.type === armOn) stateWrite.next = next;
          },
          _planner: makePlanner({ typedCall: typedCallFromTasks([makeTask({ id: 'T001' })]) }),
          _implementer: makeImplementer(),
          ...options,
        }).catch((err: unknown) => {
          thrown = toErrorMessage(err);
        });
      } finally {
        stateWrite.next = undefined;
        stateWrite.unconfirmed = false;
        stateWrite.full = false;
        vi.restoreAllMocks();
      }
      const state = loadState({ projectDir, sessionId });
      return {
        errors: events.flatMap((event) => (event.type === 'error' ? [event.message] : [])),
        plainCause,
        stderr: stderr.join(''),
        thrown,
        state,
        status: state === null ? undefined : deriveRunStatus({ state, liveness: 'not-alive' }),
      };
    }

    const failedWith = (message: string) => ({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'failed', message } },
    });

    it('a phase write of a brief it cannot confirm', async () => {
      const sessionId = 'unconfirmed-phase-sid';
      const run = await runWithStateWrite(
        sessionId,
        { from: 'transitionAndSave', fails: 'unconfirmed' },
        'task_started',
      );

      expect(run.errors).toEqual([unconfirmed(sessionId)]);
      expect(run.plainCause).toBe(unconfirmed(sessionId));
      expect(run.status).toMatchObject(failedWith(unconfirmed(sessionId)));
    });

    it('the first write of the run it cannot confirm', async () => {
      const sessionId = 'unconfirmed-start-sid';
      const run = await runWithStateWrite(
        sessionId,
        { from: 'initializeWorkflow', fails: 'unconfirmed' },
        'start',
      );

      expect(run.stderr).toBe(`Could not start the run: ${unconfirmed(sessionId)}\n`);
      expect(run.status).toMatchObject(failedWith(unconfirmed(sessionId)));
    });

    it('the approval level a resume saves, when it cannot confirm it', async () => {
      const projectDir = setupProject();
      const sessionId = 'unconfirmed-resume-sid';
      ensureSessionDir(projectDir, sessionId);
      const savedState = persistReadyExecutionState(
        { projectDir, sessionId },
        makeImplStateWithMetadata([makeTask({ id: 'T001' })], {
          changedFilesBaseline: serializeChangedFilesBaseline(
            await captureChangedFilesBaseline(projectDir),
          ),
        }),
      );
      const run = await runWithStateWrite(
        sessionId,
        { from: 'initializeWorkflow', fails: 'unconfirmed' },
        'start',
        { projectDir, savedState, feature: savedState.feature },
      );

      expect(run.state?.approve).toBe('none');
      expect(run.status).toMatchObject(failedWith(unconfirmed(sessionId)));
      expect(`${run.errors.join('\n')}${run.stderr}`).not.toMatch(/durability|persist/);
    });

    it.each([
      ['it cannot confirm', 'unconfirmed', unconfirmed],
      [
        'that fails before anything reaches the disk',
        'eio',
        (sessionId: string) =>
          `Could not save the run state: i/o error · .splitbrief/sessions/${sessionId}/state.json`,
      ],
    ] as const)('the first write over a state saved as v3, %s', async (_label, fails, line) => {
      const projectDir = setupProject();
      const sessionId = `legacy-first-write-${fails}`;
      ensureSessionDir(projectDir, sessionId);
      writeRawState({ projectDir, sessionId }, legacyWorkflowState('state write'));
      const run = await runWithStateWrite(sessionId, { from: 'writeStateFile', fails }, 'start', {
        projectDir,
        purpose: 'resume',
      });

      expect(`${run.errors.join('\n')}\n${run.stderr}`).toContain(line(sessionId));
      expect(`${run.errors.join('\n')}${run.stderr}`).not.toMatch(/schema|durability|persist/);
      // The run stays open at the step it saved, with the line as why it stopped.
      expect(run.state?.lastFailure?.message).toBe(line(sessionId));
      expect(run.status?.kind).toBe('open');
    });

    const bigPrompt = 'LOG-LINE 42 failed\n'.repeat(
      Math.ceil((SESSION_LOG_MAX_ENTRY_BYTES + 1) / 19),
    );

    it('a start prompt over the session log limit is logged bounded and resumes whole, in --plain', async () => {
      const sessionId = 'big-start-prompt-sid';
      const projectDir = setupProject();
      const run = await runWithStateWrite(sessionId, undefined, 'start', {
        projectDir,
        feature: bigPrompt,
      });
      const ref = { projectDir, sessionId };

      expect(run.stderr).not.toMatch(/persist|oversized/);
      const logged: string[] = [];
      for await (const entry of readMessages(ref))
        if (entry.role === 'user') logged.push(entry.text);
      expect(logged[0]?.endsWith(CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER)).toBe(true);
      expect(run.state?.resumeUserMessages).toEqual([
        expect.objectContaining({ displayText: logged[0], text: bigPrompt }),
      ]);
      expect((await buildResumeContext({ ref })).messages[0]).toEqual({
        role: 'user',
        content: bigPrompt,
      });
    });

    it.each([
      [
        'refused',
        'eio',
        (sessionId: string) =>
          `Could not save the run state: i/o error · .splitbrief/sessions/${sessionId}/state.json`,
      ],
      [
        'unconfirmed',
        'unconfirmed',
        (sessionId: string) =>
          `Saved the run state, but could not confirm it on disk · .splitbrief/sessions/${sessionId}/state.json`,
      ],
    ] as const)('the save of the whole start prompt, %s', async (_label, fails, line) => {
      const sessionId = `big-start-prompt-${fails}`;
      const run = await runWithStateWrite(
        sessionId,
        { from: 'recordResumeUserMessage', fails },
        'start',
        { feature: bigPrompt },
      );

      expect(run.stderr).toBe(`Could not start the run: ${line(sessionId)}\n`);
      expect(run.status).toMatchObject(failedWith(line(sessionId)));
    });

    it('a write that fails before anything reaches the disk', async () => {
      const sessionId = 'not-saved-phase-sid';
      const message = `Could not save the run state: i/o error · .splitbrief/sessions/${sessionId}/state.json`;
      const run = await runWithStateWrite(
        sessionId,
        { from: 'transitionAndSave', fails: 'eio' },
        'task_started',
      );

      expect(run.errors).toEqual([message]);
      expect(run.plainCause).toBe(message);
      expect(run.status).toMatchObject(failedWith(message));
    });

    it('End run on the plan card, when it cannot confirm the close', async () => {
      const sessionId = 'unconfirmed-close-sid';
      const run = await runWithStateWrite(
        sessionId,
        { from: 'closeRunIfOpen', fails: 'unconfirmed' },
        'start',
        {
          config: makeConfig({
            validation: { endChecks: false, testCommand: 'noop' },
            workflow: { approve: 'plan' },
          }),
          callbacks: makeCallbacks({
            onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
          }).callbacks,
        },
      );

      expect(run.errors).toEqual([unconfirmed(sessionId)]);
      expect(run.status).toEqual({ kind: 'closed', as: 'ended' });
    });

    it('End run during a brief, when it cannot confirm the close', async () => {
      const sessionId = 'unconfirmed-end-sid';
      const controller = new AbortController();
      const run = await runWithStateWrite(
        sessionId,
        { from: 'closeRunIfOpen', fails: 'unconfirmed' },
        'start',
        {
          signal: controller.signal,
          _implementer: makeImplementer({
            implement: vi.fn().mockImplementation(async () => {
              controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
              return { success: false, output: '', usage: null };
            }),
          }),
        },
      );

      // The stop sheet shows the line and offers Retry stop, as for any stop that failed to save.
      expect(run.thrown).toBe(unconfirmed(sessionId));
      expect(run.errors).toEqual([]);
      expect(run.status).toEqual({ kind: 'closed', as: 'ended' });
    });

    const changedOnDisk = (sessionId: string) =>
      `Could not save the run state: the file changed on disk before SPLITBRIEF could save it · .splitbrief/sessions/${sessionId}/state.json`;

    it.each([
      ['it cannot confirm', 'unconfirmed', unconfirmed],
      ['another writer changed', 'conflict', changedOnDisk],
    ] as const)(
      'the files a first attempt wrote, when %s the save, fail the run with that cause',
      async (_, fails, line) => {
        const sessionId = `restore-scope-${fails}-sid`;
        const run = await runWithStateWrite(
          sessionId,
          { from: 'recordWrites', fails },
          'task_started',
        );

        expect(run.errors).toEqual([line(sessionId)]);
        expect(run.status).toMatchObject(failedWith(line(sessionId)));
      },
    );

    it.each([
      ['it cannot confirm', 'unconfirmed', unconfirmed],
      ['another writer changed', 'conflict', changedOnDisk],
    ] as const)(
      'the files a retry wrote, when %s the save, fail the run with that cause',
      async (_, fails, line) => {
        const sessionId = `retry-scope-${fails}-sid`;
        const run = await runWithStateWrite(
          sessionId,
          { from: 'runRetryStepAttempt', fails },
          'task_started',
          {
            _implementer: makeImplementer({
              implement: vi.fn().mockRejectedValueOnce(new Error('boom')),
            }),
          },
        );

        expect(run.errors).toEqual(['Implementation failed: boom', line(sessionId)]);
        expect(run.state?.pendingRecovery).toBeUndefined();
        expect(run.status).toMatchObject(failedWith(line(sessionId)));
      },
    );

    it('a state file the disk no longer lets it read', async () => {
      const projectDir = setupProject();
      const sessionId = 'unreadable-state-sid';
      const statePath = join(sessionDir(projectDir, sessionId), STATE_FILE);
      const run = await runWithStateWrite(
        sessionId,
        { from: 'neverCalled', fails: 'eio' },
        'start',
        {
          projectDir,
          _implementer: makeImplementer({
            implement: vi.fn().mockImplementation(async () => {
              chmodSync(statePath, 0o000);
              return { success: true, output: '', usage: null };
            }),
          }),
        },
      ).finally(() => chmodSync(statePath, 0o600));

      expect(run.errors).toEqual([
        `Could not read the run state: permission denied · .splitbrief/sessions/${sessionId}/state.json`,
      ]);
    });

    describe('a failure in a session folder that takes no new file reads failed in this process', () => {
      const notSaved = (sessionId: string, reason = 'permission denied') =>
        `Could not save the run state: ${reason} · .splitbrief/sessions/${sessionId}/state.json`;

      async function runInReadOnlyFolder(
        sessionId: string,
        lockDown: 'brief' | 'planning',
        options: Partial<WorkflowTestOptions> = {},
      ) {
        const projectDir = setupProject();
        const dir = sessionDir(projectDir, sessionId);
        const readOnly = () => chmodSync(dir, 0o555);
        const run = await runWithStateWrite(sessionId, undefined, 'start', {
          projectDir,
          ...(lockDown === 'planning' && {
            _planner: makePlanner({
              typedCall: typedCallAnswering(() => {
                readOnly();
                return planFromTasks([makeTask({ id: 'T001' })]);
              }),
            }),
          }),
          ...(lockDown === 'brief' && {
            _implementer: makeImplementer({
              implement: vi.fn().mockImplementation(async () => {
                readOnly();
                return { success: true, output: '', usage: null };
              }),
            }),
          }),
          ...options,
        });
        const ref = { projectDir, sessionId };
        return {
          ...run,
          ref,
          dir,
          record: readRunRecord(ref).status,
          row: listSessions(projectDir).find((session) => session.id === sessionId),
        };
      }

      it.each([
        ['a brief', 'brief'],
        ['planning', 'planning'],
      ] as const)('a state write that fails during %s', async (_label, lockDown) => {
        const sessionId = `read-only-${lockDown}-sid`;
        const run = await runInReadOnlyFolder(sessionId, lockDown);
        // Planning fails first on plan.json, the run file the plan goes to.
        const cause =
          lockDown === 'planning'
            ? `Could not save a run file: permission denied · .splitbrief/sessions/${sessionId}/plan.json`
            : notSaved(sessionId);
        try {
          // The run ends with the cause, not a raw error about a file it could not create.
          expect(run.thrown).toBeUndefined();
          expect(run.errors.at(-1)).toBe(cause);
          expect(run.plainCause).toBe(cause);
          // The live record and the listing read it the way a saved failure reads.
          expect(run.record).toMatchObject(failedWith(cause));
          expect(run.row).toMatchObject({ status: 'open', stop: 'stopped' });
          // Reopened in this process, after the lock went stale, it still reads failed.
          vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] });
          expect(readRunRecord(run.ref).status).toMatchObject(failedWith(cause));
          vi.useRealTimers();
          // The stderr line says the failure did not reach the disk.
          expect(run.stderr).toContain(
            `Could not record why the run failed: ${notSaved(sessionId)}`,
          );
          // A new process reads only the disk (`run.status`): the run stopped where it was.
          expect(run.status).toMatchObject({
            kind: 'open',
            stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          });
        } finally {
          vi.useRealTimers();
          chmodSync(run.dir, 0o755);
        }
      });

      const plannerDown = makePlanner({
        typedCall: typedCallAnswering(() => {
          throw new Error('planner down');
        }),
      });

      it.each([
        ['a halt', 'raisePendingRecovery', 'start', { _planner: plannerDown }],
        ['a brief', 'transitionAndSave', 'task_started', {}],
      ] as const)(
        '%s whose state write fails on a full disk',
        async (_label, from, armOn, seats) => {
          const sessionId = `full-disk-${from}-sid`;
          const projectDir = setupProject();
          const run = await runWithStateWrite(
            sessionId,
            { from, fails: 'enospc', thenEvery: true },
            armOn,
            { projectDir, ...seats },
          );
          const ref = { projectDir, sessionId };
          const line = notSaved(sessionId, 'no space left on device');

          expect(run.thrown).toBeUndefined();
          expect(run.errors.at(-1)).toBe(line);
          expect(readRunRecord(ref).status).toMatchObject(failedWith(line));
          expect(run.status).toMatchObject({
            kind: 'open',
            stop: { kind: 'stopped' },
          });
        },
      );

      it('a continue once the folder takes files again reads what it saves', async () => {
        const sessionId = 'read-only-continued-sid';
        const run = await runInReadOnlyFolder(sessionId, 'brief');
        chmodSync(run.dir, 0o755);
        const kept = loadOwnerWorkflowState(run.ref);
        const savedState = kept.kind === 'loaded' ? kept.state : undefined;
        expect(savedState?.lastFailure?.message).toBe(notSaved(sessionId));

        const again = await runWithStateWrite(sessionId, undefined, 'start', {
          projectDir: run.ref.projectDir,
          savedState,
          purpose: 'resume',
        });

        expect(again.thrown).toBeUndefined();
        expect(again.state?.lastFailure).toBeUndefined();
        expect(readRunRecord(run.ref).status.kind).toBe('ready-to-apply');
        const reread = loadOwnerWorkflowState(run.ref);
        expect(reread.kind === 'loaded' && reread.state.lastFailure).toBeUndefined();
      });

      it('a failure a continue saves reads its own cause, not the one this process kept', async () => {
        const sessionId = 'read-only-failed-again-sid';
        const run = await runInReadOnlyFolder(sessionId, 'brief');
        chmodSync(run.dir, 0o755);
        const kept = loadOwnerWorkflowState(run.ref);
        const savedState = kept.kind === 'loaded' ? kept.state : undefined;

        const again = await runWithStateWrite(
          sessionId,
          { from: 'transitionAndSave', fails: 'eio' },
          'task_started',
          { projectDir: run.ref.projectDir, savedState, purpose: 'resume' },
        );

        const cause = notSaved(sessionId, 'i/o error');
        expect(again.errors.at(-1)).toBe(cause);
        expect(again.state?.lastFailure?.message).toBe(cause);
        expect(readRunRecord(run.ref).status).toMatchObject(failedWith(cause));
      });

      it('a continue after planning failed on a save plans again and builds once', async () => {
        const sessionId = 'read-only-planning-continued-sid';
        const projectDir = setupProject();
        const dir = sessionDir(projectDir, sessionId);
        let plans = 0;
        const planner = makePlanner({
          typedCall: typedCallAnswering(() => {
            plans += 1;
            if (plans === 1) chmodSync(dir, 0o555);
            return planFromTasks([makeTask({ id: 'T001' })]);
          }),
        });
        const implement = vi.fn().mockResolvedValue({ success: true, output: '', usage: null });
        const options = {
          projectDir,
          _planner: planner,
          _implementer: makeImplementer({ implement }),
        };
        await runWithStateWrite(sessionId, undefined, 'start', options).finally(() =>
          chmodSync(dir, 0o755),
        );
        const ref = { projectDir, sessionId };
        const kept = loadOwnerWorkflowState(ref);
        const savedState = kept.kind === 'loaded' ? kept.state : undefined;
        expect(savedState?.lastFailure?.message).toBe(
          `Could not save a run file: permission denied · .splitbrief/sessions/${sessionId}/plan.json`,
        );
        expect(implement).not.toHaveBeenCalled();

        const again = await runWithStateWrite(sessionId, undefined, 'start', {
          ...options,
          savedState,
          purpose: 'resume',
        });

        expect(again.thrown).toBeUndefined();
        // No plan reached the disk, so the planner plans again.
        expect(plans).toBe(2);
        const planFile = parsePlanJson(readFileSync(join(dir, PLAN_JSON_FILE), 'utf8'));
        if (!('plan' in planFile)) throw new Error(planFile.errors.join('; '));
        const { plan } = planFile;
        expect(plan.tasks.map((task) => task.id)).toEqual(['T001']);
        expect(again.state?.tasks.map((task) => task.id)).toEqual(['T001']);
        expect(readFileSync(join(dir, TASKS_FILE), 'utf8')).toContain(
          formatTasks(again.state?.tasks ?? []),
        );
        expect(readFileSync(join(dir, PLAN_FILE), 'utf8')).toContain(plan.tasks[0]?.title);
        expect(again.state?.lastFailure).toBeUndefined();
        const reread = loadOwnerWorkflowState(ref);
        expect(reread.kind === 'loaded' && reread.state.lastFailure).toBeUndefined();
        expect(readRunRecord(ref).status.kind).toBe('ready-to-apply');
        expect(implement).toHaveBeenCalledTimes(1);
      });

      it('a continue after the final review failed on a save reviews again, with no brief rerun', async () => {
        const sessionId = 'read-only-review-continued-sid';
        const projectDir = setupProject();
        const dir = sessionDir(projectDir, sessionId);
        let reviews = 0;
        const planner = makePlanner({
          typedCall: typedCallPlanAndReview(
            () => planFromTasks([makeTask({ id: 'T001' })]),
            (prompt) => {
              reviews += 1;
              if (reviews === 1) chmodSync(dir, 0o555);
              return passingReviewVerdict(prompt);
            },
          ),
        });
        const implement = vi.fn().mockResolvedValue({ success: true, output: '', usage: null });
        const options = {
          projectDir,
          _planner: planner,
          _implementer: makeImplementer({ implement }),
        };
        const failed = await runWithStateWrite(sessionId, undefined, 'start', options).finally(() =>
          chmodSync(dir, 0o755),
        );
        expect(failed.errors.at(-1)).toMatch(
          /^Could not save (a run file|the run state): permission denied · /,
        );
        expect(implement).toHaveBeenCalledTimes(1);
        const ref = { projectDir, sessionId };
        const kept = loadOwnerWorkflowState(ref);

        const again = await runWithStateWrite(sessionId, undefined, 'start', {
          ...options,
          savedState: kept.kind === 'loaded' ? kept.state : undefined,
          purpose: 'resume',
        });

        expect(again.thrown).toBeUndefined();
        // The built brief stands: no restore and no second implementer call.
        expect(implement).toHaveBeenCalledTimes(1);
        expect(reviews).toBe(2);
        const reread = loadOwnerWorkflowState(ref);
        expect(reread.kind === 'loaded' && reread.state.lastFailure).toBeUndefined();
        expect(again.state?.pendingRecovery).toBeUndefined();
        expect(readRunRecord(ref).status.kind).toBe('ready-to-apply');
      });

      describe('the files a failed attempt wrote are back at their task-start bytes when the brief runs again', () => {
        const committed = {
          'src/hello.ts': 'hello start\n',
          'docs/notes.md': 'notes start\n',
          'docs/old.md': 'old start\n',
          'dirty.txt': 'dirty committed\n',
          '.gitignore': 'build/\n',
        };
        const watched = [
          'src/hello.ts',
          'docs/notes.md',
          'docs/old.md',
          'docs/new.md',
          'dirty.txt',
        ];
        const contents = (dir: string) =>
          Object.fromEntries(
            watched.map((file) => [
              file,
              existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null,
            ]),
          );

        it.each([
          ['worktree', 'a folder that takes no new file', 'read-only', 'this'],
          ['checkout', 'a folder that takes no new file', 'read-only', 'this'],
          ['checkout', 'a folder that takes no new file', 'read-only', 'a new'],
          ['worktree', 'a one-off i/o error', 'eio', 'this'],
          ['worktree', 'a one-off full disk', 'enospc', 'this'],
          ['checkout', 'another writer', 'conflict', 'this'],
          ['worktree', 'a save it cannot confirm', 'unconfirmed', 'this'],
        ] as const)(
          '%s, after %s, continued in %s process',
          async (isolation, _label, fails, continuedIn) => {
            const projectDir = createTempDir('run-workflow-test');
            dirs.push(projectDir);
            createTestGitRepo(projectDir, committed);
            // A file the user changed before the run is theirs: a restore returns it to their bytes.
            writeFileSync(join(projectDir, 'dirty.txt'), 'dirty by the user\n');
            const sessionId = `restore-kept-${isolation}-${fails}-${continuedIn.replace(' ', '-')}-sid`;
            const ref = { projectDir, sessionId };
            const config = makeConfig({
              validation: { endChecks: false, testCommand: 'noop' },
              workflow: {
                approve: 'none',
                isolation: isolation === 'checkout' ? 'none' : 'worktree',
              },
            });
            let taskStart: Record<string, string | null> = {};
            let workspace = '';
            const first = vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
              workspace = opts.projectDir;
              taskStart = contents(workspace);
              writeFileSync(join(workspace, 'src/hello.ts'), 'hello by the call\n');
              writeFileSync(join(workspace, 'docs/notes.md'), 'notes by the call\n');
              unlinkSync(join(workspace, 'docs/old.md'));
              writeFileSync(join(workspace, 'docs/new.md'), 'new by the call\n');
              writeFileSync(join(workspace, 'dirty.txt'), 'dirty by the call\n');
              mkdirSync(join(workspace, 'build'), { recursive: true });
              writeFileSync(join(workspace, 'build/out.log'), 'ignored by the call\n');
              if (fails === 'read-only') chmodSync(sessionDir(projectDir, sessionId), 0o555);
              return { success: true, output: '', usage: null };
            });
            const failed = await runWithStateWrite(
              sessionId,
              fails === 'read-only' ? undefined : { from: 'recordWrites', fails },
              fails === 'read-only' ? 'start' : 'task_started',
              { projectDir, config, _implementer: makeImplementer({ implement: first }) },
            ).finally(() => chmodSync(sessionDir(projectDir, sessionId), 0o755));
            expect(failed.status).toMatchObject({ kind: 'open', stop: { kind: 'stopped' } });
            expect(taskStart['dirty.txt']).toBe('dirty by the user\n');

            // The failed save left the undeclared writes off the disk.
            const onDisk = WorkflowStateSchema.parse(
              JSON.parse(readFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), 'utf8')),
            ).changedFilesBaseline?.activeTaskSnapshot?.restoreFiles;
            if (fails === 'unconfirmed') expect(onDisk).toContain('docs/notes.md');
            else expect(onDisk ?? []).not.toContain('docs/notes.md');
            // A new process holds nothing of this one in memory.
            if (continuedIn === 'a new') forgetCachedState(statePath(ref));

            let beforeSecondCall: Record<string, string | null> = {};
            let ignoredBeforeSecondCall: string | null = null;
            const second = vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
              beforeSecondCall = contents(opts.projectDir);
              const ignored = join(opts.projectDir, 'build/out.log');
              ignoredBeforeSecondCall = existsSync(ignored) ? readFileSync(ignored, 'utf8') : null;
              return { success: true, output: '', usage: null };
            });
            const kept = loadOwnerWorkflowState(ref);
            const again = await runWithStateWrite(sessionId, undefined, 'start', {
              projectDir,
              config,
              savedState: kept.kind === 'loaded' ? kept.state : undefined,
              purpose: 'resume',
              _implementer: makeImplementer({ implement: second }),
            });

            expect(again.thrown).toBeUndefined();
            expect(second).toHaveBeenCalledTimes(1);
            // A new process restores from the disk only: the declared file goes back, the
            // undeclared writes of the failed save stay as the call left them.
            expect(beforeSecondCall).toEqual(
              continuedIn === 'this'
                ? taskStart
                : {
                    ...taskStart,
                    'docs/notes.md': 'notes by the call\n',
                    'docs/old.md': null,
                    'docs/new.md': 'new by the call\n',
                    'dirty.txt': 'dirty by the call\n',
                  },
            );
            // A file ignored at the start is not the call's write: no restore deletes it.
            expect(ignoredBeforeSecondCall).toBe('ignored by the call\n');
          },
        );
      });

      // Only that one write is refused; every state write still lands.
      it.each([
        ['the plan', 'plan.json', {}],
        [
          'the final review',
          'review.json',
          {
            _planner: makePlanner({
              typedCall: typedCallPlanAndReview(
                () => planFromTasks([makeTask({ id: 'T001' })]),
                passingReviewVerdict,
              ),
            }),
          },
        ],
      ] as const)(
        '%s a run file it cannot save fails the run with that cause, not as a seat that failed',
        async (_label, file, seats) => {
          const sessionId = `unsaved-${file.replace('.', '-')}-sid`;
          const projectDir = setupProject();
          secureWrite.refuses = file;
          const run = await runWithStateWrite(sessionId, undefined, 'start', {
            projectDir,
            ...seats,
          }).finally(() => {
            secureWrite.refuses = undefined;
          });
          const cause = `Could not save a run file: permission denied · .splitbrief/sessions/${sessionId}/${file}`;

          expect(run.thrown).toBeUndefined();
          expect(run.errors).toEqual([cause]);
          expect(run.state?.pendingRecovery).toBeUndefined();
          expect(readRunRecord({ projectDir, sessionId }).status).toMatchObject(failedWith(cause));
        },
      );

      it('a state file the reopen cannot read reads failed with the read cause', async () => {
        const sessionId = 'read-only-unreadable-sid';
        const run = await runInReadOnlyFolder(sessionId, 'brief');
        const statePath = join(run.dir, STATE_FILE);
        chmodSync(statePath, 0o000);
        try {
          expect(readRunRecord(run.ref).status).toMatchObject({
            kind: 'open',
            stop: { kind: 'stopped', on: { kind: 'failed' } },
          });
        } finally {
          chmodSync(statePath, 0o600);
          chmodSync(run.dir, 0o755);
        }
      });
    });

    it('the files an attempt wrote on a disk that confirms no write from then on', async () => {
      const sessionId = 'restore-scope-every-sid';
      const run = await runWithStateWrite(
        sessionId,
        { from: 'recordWrites', fails: 'unconfirmed', thenEvery: true },
        'task_started',
      );

      expect(run.errors).toEqual([unconfirmed(sessionId)]);
      expect(run.plainCause).toBe(unconfirmed(sessionId));
      expect(run.status).toMatchObject(failedWith(unconfirmed(sessionId)));
      expect(`${run.errors.join('\n')}${run.stderr}`).not.toMatch(/durability|persist/);
    });

    const notSavedEio = (sessionId: string) =>
      `Could not save the run state: i/o error · .splitbrief/sessions/${sessionId}/state.json`;
    const reviewing = {
      _planner: makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([makeTask({ id: 'T001' })]),
          passingReviewVerdict,
        ),
      }),
    };

    const kept = (sessionId: string) =>
      `Another process kept changing the run state, so this change was not saved · .splitbrief/sessions/${sessionId}/state.json`;
    const changedBefore = (sessionId: string) =>
      `Another process changed the run state, so this change was not saved · .splitbrief/sessions/${sessionId}/state.json`;
    const planUsage = {
      _planner: makePlanner({
        typedCall: typedCallFromTasks([makeTask({ id: 'T001' })], {
          inputTokens: 50,
          outputTokens: 25,
        }),
      }),
    };

    it.each([
      ['planning', 'transitionAndSave', 'eio', 'planner_status', {}, notSavedEio],
      ['planning', 'transitionAndSave', 'unconfirmed', 'planner_status', {}, unconfirmed],
      ['the final review', 'transitionAndSave', 'eio', 'drift_report', reviewing, notSavedEio],
      [
        'the final review',
        'transitionAndSave',
        'unconfirmed',
        'drift_report',
        reviewing,
        unconfirmed,
      ],
      ['a brief', 'recordWrites', 'eio', 'task_started', {}, notSavedEio],
      ['planning', 'addUsageAndSave', 'conflict-twice', 'planner_status', planUsage, kept],
      ['planning', 'transitionAndSave', 'conflict', 'planner_status', {}, changedBefore],
    ] as const)(
      'a state write that fails during %s (%s, %s) fails the run with its cause, not as the seat failing',
      async (label, from, fails, armOn, seats, line) => {
        const sessionId = `seat-save-${label.replaceAll(' ', '-')}-${fails}-sid`;
        const implement = vi.fn().mockResolvedValue({ success: true, output: '', usage: null });
        const run = await runWithStateWrite(sessionId, { from, fails }, armOn, {
          _implementer: makeImplementer({ implement }),
          ...seats,
        });

        expect(run.errors).toEqual([line(sessionId)]);
        expect(run.plainCause).toBe(line(sessionId));
        expect(run.state?.pendingRecovery).toBeUndefined();
        expect(run.status).toMatchObject(failedWith(line(sessionId)));
        if (label === 'a brief') expect(implement).toHaveBeenCalledTimes(1);
      },
    );
  });

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
      ).rejects.toMatchObject({
        kind: 'workflow-session-already-live',
        message: `session '${sessionId}' is already running (pid ${process.pid}) — stop it before resuming, or run 'splitbrief continue ${sessionId}' once it stops.`,
      });
      expect(secondPlanner.isAvailable).not.toHaveBeenCalled();
      expect(secondPlanner.typedCall).not.toHaveBeenCalled();
    } finally {
      releaseFirst.resolve();
      await firstRun;
    }
  });

  it.each([
    ['with the state the TUI and the CLI load', true],
    ['with the state it reads from disk', false],
  ])(
    'continues a run saved as v3 as one planning session and saves it as v4, %s',
    async (_label, passLoaded) => {
      const projectDir = setupProject();
      const sessionId = 'legacy-state-sid';
      const ref = { projectDir, sessionId };
      ensureSessionDir(projectDir, sessionId);
      writeRawState(ref, legacyWorkflowState('legacy state'));
      const controller = new AbortController();
      const typed = scriptedTypedCall([makePlanProposal()]);
      const events: EngineEvent[] = [];
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      try {
        await runWorkflow({
          ...ref,
          feature: 'legacy state',
          purpose: 'resume',
          ...(passLoaded ? { savedState: loadState(ref) ?? undefined } : {}),
          steer: plainUserMessage('PELICAN-42 keep the old name'),
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
      } finally {
        vi.restoreAllMocks();
      }

      expect(stderr.join('')).toBe('');
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(typed.prompts[0]).toContain('PELICAN-42');
      const saved = JSON.parse(readFileSync(stateFile(ref), 'utf8'));
      expect(saved).toMatchObject({ stateVersion: 4, phase: 'reviewing-plan' });
    },
  );

  it('reads a v3 state it cannot map as not readable and leaves its bytes alone', async () => {
    const projectDir = setupProject();
    const sessionId = 'invalid-legacy-sid';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    writeRawState(ref, { ...legacyWorkflowState('invalid legacy'), tasks: 'not a list' });
    const before = readFileSync(stateFile(ref));
    const planner = makePlanner({ isAvailable: vi.fn() });
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await runWorkflow({
        feature: 'invalid legacy',
        projectDir,
        config: unavailablePlannerConfig(),
        callbacks: makeCallbacks().callbacks,
        sessionId,
        purpose: 'resume',
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
        _planner: planner,
      });
    } finally {
      vi.restoreAllMocks();
    }

    expect(stderr.join('')).toContain(
      `Could not read the run state: it could not be read, or its content is not valid · .splitbrief/sessions/${sessionId}/state.json`,
    );
    expect(readFileSync(stateFile(ref))).toEqual(before);
    expect(planner.typedCall).not.toHaveBeenCalled();
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
