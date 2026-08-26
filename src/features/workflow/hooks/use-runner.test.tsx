import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import type { Config } from '../../../core/schemas/config.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { buildContextOverflowRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner } from './use-runner.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { configStore } from '../../../stores/project/config.js';
import {
  abortTurn,
  interruptTurn,
  requestCancel,
  requestRewind,
  clearAllHandlers,
} from '../handlers.js';
import {
  clearActiveReceipt,
  reactivateExistingSession,
  writeActive,
} from '../../../core/sessions/active-pointer.js';
import { acquireStateAuthority, releaseStateAuthority } from '../../../core/state/authority.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
import { saveState, loadState } from '../../../core/state/persistence.js';
import { configForSessionTranscriptPolicy, saveSummary } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { sessionDir } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { RunWorkflowFn, WorkflowCompletion } from './use-runner.js';

// Harness mounts useWorkflowRunner with a bogus planner command so that
// runWorkflow exits fast via the "planner not available" branch in
// initializeWorkflow. That keeps the hook's React-side lifecycle observable
// (reset, resume, rewind, cancel) without requiring a full engine spin-up.

interface RunnerHandle {
  startedAt: string;
  handleResume: (injectedText?: string) => void;
}

interface HarnessProps {
  prepared: PreparedExecution;
  authority?: StateAuthorityReceipt | undefined;
  onComplete: (completion: WorkflowCompletion) => void;
  captureRunner?: { current: RunnerHandle | null };
  runWorkflow?: RunWorkflowFn | undefined;
}

function Harness({ prepared, authority, onComplete, captureRunner, runWorkflow }: HarnessProps) {
  const inputMode = useInputMode();
  const runner = useWorkflowRunner({
    prepared,
    authority,
    onComplete,
    inputMode,
    runWorkflow,
  });
  useEffect(() => {
    if (captureRunner) captureRunner.current = runner;
  });
  return (
    <Box>
      <Text>{inputMode.mode === 'normal' ? 'idle' : inputMode.hint}</Text>
    </Box>
  );
}

function preparedExecution(input: {
  projectDir: string;
  feature: string;
  sessionId?: string | undefined;
  resumeState?: WorkflowState | undefined;
  planner?: PlannerConfig | undefined;
  workflow?: Partial<Config['workflow']> | undefined;
}): PreparedExecution {
  const sessionId = input.sessionId ?? 'prepared-workflow-session';
  const ref = { projectDir: input.projectDir, sessionId };
  ensureSessionDir(input.projectDir, sessionId);
  return makePreparedExecution({
    projectDir: input.projectDir,
    sessionId,
    feature: input.feature,
    config: configForSessionTranscriptPolicy(
      makeConfig({
        planner: input.planner ?? {
          kind: 'agent',
          command: 'splitbrief-non-existent-planner-x7q9',
        },
        ...(input.workflow !== undefined && { workflow: input.workflow }),
      }),
      ref,
    ),
    preparationId: `workflow-hook-${sessionId}`,
    active: reactivateExistingSession(ref),
    ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
  });
}

async function flush(ms = 60) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('workflow-runner-test');
  createTestGitRepo(projectDir);
  ensureSplitbriefDir(projectDir);
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  configStore.__testReset();
  clearAllHandlers();
});

afterEach(() => {
  clearAllHandlers();
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  configStore.__testReset();
  cleanupTempDir(projectDir);
});

describe('useWorkflowRunner', () => {
  it('runs once from prepared config session report and gates', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'prepared authority' });
    const received: PreparedExecution[] = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      received.push(options.prepared);
      return makeSummary();
    });

    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} runWorkflow={runWorkflowStub} />,
    );

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    await flush();

    const authority = received[0];
    expect(authority).toBe(prepared);
    expect(authority?.config).toBe(prepared.config);
    expect(authority?.session).toBe(prepared.session);
    expect(authority?.session.active).toBe(prepared.session.active);
    expect(authority?.report).toBe(prepared.report);
    expect(authority?.gates).toBe(prepared.gates);
    expect(Object.isFrozen(authority?.config)).toBe(true);
    expect(runWorkflowStub).toHaveBeenCalledTimes(1);

    inst.unmount();
  });

  it('resets workflow stores on mount and produces a valid startedAt timestamp', async () => {
    // Seed the stores so the test proves they were reset on mount.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 5 });
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });

    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} captureRunner={captureRunner} />,
    );
    await flush();

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    expect(runner.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    inst.unmount();
  });

  it("clears stale store state and applies the resume phase from startWorkflow's authoritative reset (F-078)", async () => {
    // Seed the lifecycle store with stale data. The start effect no longer resets
    // the stores itself; startWorkflow's own reset is the single authoritative reset.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    const sessionId = '2026-08-14-resume-reset';
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: resume,
    });
    saveState({ projectDir, sessionId }, resume);

    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);

    // Stale fields were cleared (reset ran) and the resume phase was applied
    // (reset received the resume state) — proving a single reset carries the
    // resume state correctly without the removed effect-level reset.
    await vi.waitFor(() => {
      const lifecycle = lifecycleStore.get();
      expect(lifecycle.cancelled).toBe(false);
      expect(lifecycle.queueDepth).toBe(0);
      expect(lifecycle.phase).toBe('reviewing-spec');
    });
    inst.unmount();
  });

  it('clears session state before a missing persisted resume exits', async () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 7, phase: 'final-review' });
    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_started',
          ts: Date.now(),
          phase: 'final-review',
          feature: 'old session',
        },
      ],
    });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    const prepared = preparedExecution({
      projectDir,
      feature: 'new session',
      sessionId: '2026-08-14-missing-resume',
      resumeState: createInitialState('new session'),
    });

    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} runWorkflow={runWorkflowStub} />,
    );
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('idle');
      expect(lifecycleStore.get().cancelled).toBe(false);
    });

    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(eventsStore.get().events).toEqual([]);
    expect(runWorkflowStub).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('clears session state before an invalid persisted resume exits', async () => {
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 9, phase: 'implementing' });
    const sessionId = '2026-08-14-invalid-resume';
    const prepared = preparedExecution({
      projectDir,
      feature: 'invalid session',
      sessionId,
      resumeState: createInitialState('invalid session'),
    });
    writeFileSync(
      join(sessionDir(projectDir, sessionId), 'state.json'),
      JSON.stringify({ stateVersion: 999 }),
      'utf8',
    );
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} runWorkflow={runWorkflowStub} />,
    );
    await vi.waitFor(() => {
      expect(lifecycleStore.get().phase).toBe('idle');
      expect(eventsStore.get().events).toEqual([
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('Cannot resume'),
        }),
      ]);
    });

    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(runWorkflowStub).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('keeps opaque resumed sessions transcript-private when current config allows transcripts', async () => {
    const sessionId = '2026-06-18-session-abcdef123456';
    ensureSessionDir(projectDir, sessionId);
    const resume: WorkflowState = {
      ...createInitialState('secret oauth login'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001' })],
    };
    saveState({ projectDir, sessionId }, resume);
    let seenPersistTranscript: boolean | undefined;
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (opts) => {
      seenPersistTranscript = opts.prepared.config.workflow.persistTranscript;
      return makeSummary();
    });
    const prepared = preparedExecution({
      projectDir,
      feature: 'secret oauth login',
      sessionId,
      resumeState: resume,
      workflow: { mode: 'quick', persistTranscript: true },
    });

    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} runWorkflow={runWorkflowStub} />,
    );

    await vi.waitFor(() => {
      expect(runWorkflowStub).toHaveBeenCalled();
    });
    expect(seenPersistTranscript).toBe(false);

    inst.unmount();
  });

  it('a session record with failed status completes the workflow as failed', async () => {
    const sessionId = '2026-06-18-failed-session';
    ensureSessionDir(projectDir, sessionId);
    saveSummary({ projectDir, sessionId }, makeSession({ id: sessionId, status: 'failed' }));
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());
    let completion: WorkflowCompletion | undefined;
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = render(
      <Harness
        prepared={prepared}
        onComplete={(c) => {
          completion = c;
        }}
        runWorkflow={runWorkflowStub}
      />,
    );

    await vi.waitFor(() => {
      expect(completion?.status).toBe('failed');
    });
    expect(completion?.sessionId).toBe(sessionId);

    inst.unmount();
  });

  it('completes as interrupted when the run returns un-parked while the lifecycle is interrupted', async () => {
    const sessionId = '2026-07-10-interrupted-regen';
    ensureSessionDir(projectDir, sessionId);
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (opts) => {
      // Esc-Esc during an approval-gate regeneration: an abort handler is live
      // (runLiveRegenerate), interruptTurn marks the lifecycle interrupted and
      // aborts the regen, and the engine run returns without parking a
      // continuation prompt or publishing a cancellation event.
      addEvent({
        type: 'workflow_started',
        ts: Date.now(),
        phase: 'reviewing-spec',
        feature: 'add auth',
      });
      opts.sinks.setAbortHandler(() => {});
      interruptTurn();
      opts.sinks.setAbortHandler(null);
      return makeSummary();
    });
    let completion: WorkflowCompletion | undefined;
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = render(
      <Harness
        prepared={prepared}
        onComplete={(c) => {
          completion = c;
        }}
        runWorkflow={runWorkflowStub}
      />,
    );

    // The workflow screen must reach a real terminal state instead of a dead
    // "interrupted — Enter retry" byline with no parked prompt behind it.
    await vi.waitFor(() => {
      expect(completion?.status).toBe('interrupted');
    });
    expect(completion?.sessionId).toBe(sessionId);

    inst.unmount();
  });

  it('stops at a paused recovery on resume without re-entering runWorkflow (F-510)', async () => {
    const sessionId = '2024-01-01-paused';
    ensureSessionDir(projectDir, sessionId);
    const task = makeTask({ id: 'T001' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const paused: WorkflowState = {
      ...makeImplState([task]),
      pendingRecovery: { ...issue, status: 'paused' },
    };
    saveState({ projectDir, sessionId }, paused);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId,
      resumeState: paused,
    });

    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);
    await flush();

    // The paused issue is carried, not resolved: the host never resumes the run,
    // so the recovery stays on disk for an explicit `splitbrief resume` later.
    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    expect(persisted.pendingRecovery?.status).toBe('paused');

    // The host did not re-enter runWorkflow: no resume event was published, so the
    // budget-pause answer cannot drive an infinite runWorkflow loop.
    const resumedEvents = eventsStore.get().events.filter((e) => e.type === 'workflow_resumed');
    expect(resumedEvents).toHaveLength(0);

    inst.unmount();
  });

  it('requestCancel marks the workflow cancelled and clears the review input mode', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);
    await flush();

    // Simulate a pending review mode (as if the engine had called onApprovalNeeded).
    controlsStore.setInputMode('review');

    const cancelled = requestCancel();
    expect(cancelled).toBe(true);
    await flush();

    expect(lifecycleStore.get().cancelled).toBe(true);
    // Cancel handler registered by the runner calls inputMode.resetMode(),
    // which clears controls.inputMode back to 'normal'.
    expect(controlsStore.get().inputMode).toBe('normal');

    // A second cancel is a no-op (cancelled gate).
    const before = eventsStore.get().events.length;
    expect(requestCancel()).toBe(false);
    expect(eventsStore.get().events.length).toBe(before);

    inst.unmount();
  });

  it('requestCancel aborts the engine signal with the canonical user_cancelled reason', async () => {
    const sessionId = '2026-06-18-cancel-reason';
    const { promise: runFinished, resolve: finishRun } = Promise.withResolvers<void>();
    const runWorkflowWithCompletion: RunWorkflowFn = async (options) => {
      try {
        return await runWorkflow(options);
      } finally {
        finishRun();
      }
    };
    const prepared = preparedExecution({
      projectDir,
      feature: 'cancel reason',
      sessionId,
      planner: { kind: 'shell', command: 'sleep', args: ['10'] },
      workflow: { mode: 'quick', persistTranscript: false },
    });
    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} runWorkflow={runWorkflowWithCompletion} />,
    );
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    await vi.waitFor(
      () => {
        expect(existsSync(logPath)).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(requestCancel()).toBe(true);

    await vi.waitFor(
      () => {
        const log = readFileSync(logPath, 'utf-8');
        expect(log).toContain('"type":"workflow_cancelled"');
        expect(log).toContain('"reason":"user_cancelled"');
      },
      { timeout: 5_000 },
    );

    await runFinished;
    inst.unmount();
  });

  it('persists a rewind event to the session log when the user rewinds to spec', async () => {
    const sessionId = '2024-01-01-add-auth';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    saveState({ projectDir, sessionId }, saved);
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);
    await flush();
    // No `.splitbrief/active` pointer is hand-written. The rewind handler must use the
    // in-scope sessionId prop, so the rewind still lands even though the bogus
    // planner has finished and saveFinalSession cleared the active marker.

    const didRewind = requestRewind({ target: 'spec', comment: 'needs clarification' });
    expect(didRewind).toBe(true);
    await flush();

    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('rewind_to_spec');
    expect(log).toContain('needs clarification');

    inst.unmount();
  });

  it('persists a task-reset event when the user rewinds to a task', async () => {
    const sessionId = '2024-01-01-rewind-task';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'implementing',
    };
    saveState({ projectDir, sessionId }, saved);
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });

    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);
    await flush();

    const didRewind = requestRewind({ target: 'task', taskId: 'T001' });
    expect(didRewind).toBe(true);
    await flush();

    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('task_reset');
    expect(log).toContain('T001');

    inst.unmount();
  });

  it('commits a rewind through the live owner fence and revision', async () => {
    const sessionId = '2026-08-13-live-rewind-owner';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    saveState(ref, saved);
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'fenced') throw new Error('expected a fenced authority');

    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const inst = render(
      <Harness
        prepared={prepared}
        authority={acquired.receipt}
        onComplete={() => {}}
        runWorkflow={vi.fn(async () => makeSummary())}
      />,
    );
    await flush();

    expect(requestRewind({ target: 'spec', comment: 'owner fenced' })).toBe(true);
    await flush();

    const persisted = loadState(ref);
    expect(persisted?.phase).toBe('specifying');
    expect(persisted?.stateRevision).toBe(acquired.receipt.stateRevision + 1);
    expect(persisted?.stateFence).toEqual(
      expect.objectContaining({ token: acquired.receipt.fence, ownerId: acquired.receipt.ownerId }),
    );

    inst.unmount();
    expect(releaseStateAuthority(ref, acquired.receipt)).toBe(false);
  });

  it('refreshes the live owner receipt across successive rewinds', async () => {
    const sessionId = '2026-08-14-successive-rewinds';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('successive rewinds'),
      phase: 'reviewing-spec',
    };
    saveState(ref, saved);
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'fenced') throw new Error('expected a fenced authority');

    const attempts: Array<WorkflowState | undefined> = [];
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (options) => {
      attempts.push(options.savedState);
      return makeSummary();
    });
    const prepared = preparedExecution({ projectDir, feature: 'successive rewinds', sessionId });
    const inst = render(
      <Harness
        prepared={prepared}
        authority={acquired.receipt}
        onComplete={() => {}}
        runWorkflow={runWorkflowStub}
      />,
    );

    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    expect(requestRewind({ target: 'spec', comment: 'first rewind' })).toBe(true);
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(requestRewind({ target: 'plan', comment: 'second rewind' })).toBe(true);
    await vi.waitFor(() => {
      expect(loadState(ref)?.phase).toBe('planning');
    });

    expect(loadState(ref)?.stateRevision).toBe(acquired.receipt.stateRevision + 2);
    expect(feedbackStore.get().isError).toBe(false);
    inst.unmount();
    expect(releaseStateAuthority(ref, acquired.receipt)).toBe(false);
  });

  it('refuses a rewind when the live owner receipt has a stale revision', async () => {
    const sessionId = '2026-08-13-stale-rewind-owner';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    saveState(ref, saved);
    const acquired = acquireStateAuthority({ ref, purpose: 'resume' });
    if (acquired.kind !== 'fenced') throw new Error('expected a fenced authority');
    const current = loadState(ref);
    if (current === null) throw new Error('expected the fenced state to remain readable');
    saveState(ref, { ...current, stateRevision: acquired.receipt.stateRevision + 1 });

    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const inst = render(
      <Harness
        prepared={prepared}
        authority={acquired.receipt}
        onComplete={() => {}}
        runWorkflow={vi.fn(async () => makeSummary())}
      />,
    );
    await flush();

    expect(requestRewind({ target: 'spec' })).toBe(true);
    await flush();

    expect(loadState(ref)?.phase).toBe('reviewing-spec');
    expect(feedbackStore.get().isError).toBe(true);
    inst.unmount();
  });

  it('cannot rewind after a successor takes over the owner fence', async () => {
    const sessionId = '2026-08-13-takeover-rewind-owner';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    saveState(ref, saved);
    const old = acquireStateAuthority({
      ref,
      purpose: 'resume',
      ownerId: 'old-owner',
      runId: 'old-run',
      acquisitionId: 'old-acquisition',
      pid: 2_147_483_646,
      processStart: '1',
    });
    if (old.kind !== 'fenced') throw new Error('expected the old owner to be fenced');
    const successor = acquireStateAuthority({
      ref,
      purpose: 'resume',
      ownerId: 'successor-owner',
      runId: 'successor-run',
      acquisitionId: 'successor-acquisition',
    });
    if (successor.kind !== 'fenced') throw new Error('expected the successor to be fenced');

    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const inst = render(
      <Harness
        prepared={prepared}
        authority={old.receipt}
        onComplete={() => {}}
        runWorkflow={vi.fn(async () => makeSummary())}
      />,
    );
    await flush();

    expect(requestRewind({ target: 'spec' })).toBe(true);
    await flush();

    expect(loadState(ref)?.phase).toBe('reviewing-spec');
    expect(feedbackStore.get().isError).toBe(true);
    inst.unmount();
    expect(releaseStateAuthority(ref, successor.receipt)).toBe(true);
  });

  it('rewind retry reuses prepared runner authority after store changes', async () => {
    const sessionId = '2024-01-01-prepared-rewind';
    const saved: WorkflowState = {
      ...createInitialState('prepared rewind'),
      phase: 'reviewing-spec',
    };
    ensureSessionDir(projectDir, sessionId);
    saveState({ projectDir, sessionId }, saved);
    const prepared = preparedExecution({
      projectDir,
      feature: 'prepared rewind',
      sessionId,
      resumeState: saved,
    });
    const attempts: PreparedExecution[] = [];
    const runWorkflowStub: RunWorkflowFn = async (options) => {
      attempts.push(options.prepared);
      if (attempts.length === 1 && !options.signal?.aborted) {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return makeSummary();
    };
    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} runWorkflow={runWorkflowStub} />,
    );

    await vi.waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: { kind: 'agent', command: '/changed/after/admission' },
      }),
    });

    expect(requestRewind({ target: 'spec', comment: 'reuse prepared authority' })).toBe(true);

    await vi.waitFor(() => {
      expect(attempts).toHaveLength(2);
    });
    expect(attempts).toEqual([prepared, prepared]);
    expect(attempts[1]?.config).toBe(prepared.config);
    expect(attempts[1]?.gates).toBe(prepared.gates);
    expect(attempts[1]?.report).toBe(prepared.report);
    expect(attempts[1]?.session).toBe(prepared.session);
    expect(attempts[1]?.session.active).toBe(prepared.session.active);
    expect(Object.isFrozen(attempts[1]?.config)).toBe(true);

    inst.unmount();
  });

  it('rewinds the in-scope session even when .splitbrief/active names a different session', async () => {
    // pointer=A (a foreign interrupted session) while the screen is scoped to sessionId=B.
    // The rewind handler must use the in-scope id (B) and never touch A.
    const foreignSessionId = '2024-01-01-foreign';
    const scopedSessionId = '2024-01-01-scoped';
    ensureSessionDir(projectDir, foreignSessionId);
    ensureSessionDir(projectDir, scopedSessionId);
    const foreignState: WorkflowState = {
      ...createInitialState('foreign feature'),
      phase: 'reviewing-spec',
    };
    const scopedState: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    saveState({ projectDir, sessionId: foreignSessionId }, foreignState);
    saveState({ projectDir, sessionId: scopedSessionId }, scopedState);
    const prepared = preparedExecution({
      projectDir,
      feature: 'add auth',
      sessionId: scopedSessionId,
    });

    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);
    await flush();
    // The pointer now names a FOREIGN interrupted session while the screen stays scoped to B.
    // A pointer-keyed rewind would corrupt the foreign session; the in-scope id (B) must win.
    clearActiveReceipt(prepared.session.ref, prepared.session.active);
    writeActive({ projectDir, sessionId: foreignSessionId });

    const didRewind = requestRewind({ target: 'spec', comment: 'scope-correct rewind' });
    expect(didRewind).toBe(true);
    await flush();

    const scopedLog = readFileSync(
      join(sessionDir(projectDir, scopedSessionId), 'session.jsonl'),
      'utf-8',
    );
    expect(scopedLog).toContain('rewind_to_spec');
    expect(scopedLog).toContain('scope-correct rewind');

    expect(existsSync(join(sessionDir(projectDir, foreignSessionId), 'session.jsonl'))).toBe(false);

    inst.unmount();
  });

  it('handleResume shows a feedback error when there is no saved state on disk', async () => {
    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const runWorkflowStub: RunWorkflowFn = vi.fn(async () => makeSummary());

    const inst = render(
      <Harness
        prepared={prepared}
        onComplete={() => {}}
        captureRunner={captureRunner}
        runWorkflow={runWorkflowStub}
      />,
    );
    await flush();

    // No active session was written — handleResume should surface a feedback
    // error instead of trying to resume.
    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 4, phase: 'final-review' });
    eventsStore.__testReset({
      events: [
        {
          type: 'workflow_started',
          ts: Date.now(),
          phase: 'final-review',
          feature: 'stale session',
        },
      ],
    });
    runner.handleResume();
    await flush();

    expect(feedbackStore.get().message).toMatch(/no saved state/i);
    expect(feedbackStore.get().isError).toBe(true);
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(eventsStore.get().events).toEqual([]);

    inst.unmount();
  });

  it.each([
    { phase: 'planning', sessionId: '2024-01-01-inject', text: 'what about edge case X?' },
    {
      phase: 'implementing',
      sessionId: '2024-01-01-implementing-inject',
      text: 'carry this into implementation',
    },
  ] as const)(
    'enqueues injected resume text into the saved state message queue while resuming a $phase phase',
    async ({ phase, sessionId, text }) => {
      ensureSessionDir(projectDir, sessionId);
      saveState({ projectDir, sessionId }, { ...createInitialState('add auth'), phase });

      const captureRunner: HarnessProps['captureRunner'] = { current: null };
      const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
      const inst = render(
        <Harness prepared={prepared} onComplete={() => {}} captureRunner={captureRunner} />,
      );
      await flush();

      const runner = captureRunner.current;
      if (!runner) throw new Error('expected captureRunner.current to be populated');
      runner.handleResume(text);
      await flush();

      const persisted = loadState({ projectDir, sessionId });
      if (!persisted) throw new Error('expected persisted state on disk');
      const pending = persisted.messageQueue.filter((m) => !m.drainedAt);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.text).toBe(text);
      expect(pending[0]?.phase).toBe(phase);
      expect(pending[0]?.origin).toBe('user-input');
      expect(feedbackStore.get().isError).toBe(false);

      inst.unmount();
    },
  );

  it('resumes without queuing when no injected text is provided', async () => {
    const sessionId = '2024-01-01-empty-continue';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'planning',
    };
    saveState({ projectDir, sessionId }, saved);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const prepared = preparedExecution({ projectDir, feature: 'add auth', sessionId });
    const inst = render(
      <Harness prepared={prepared} onComplete={() => {}} captureRunner={captureRunner} />,
    );
    await flush();

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume();
    await flush();

    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    expect(persisted.messageQueue).toHaveLength(0);

    inst.unmount();
  });

  it('cleans up all handlers on unmount so later events do not leak into the suite', async () => {
    const prepared = preparedExecution({ projectDir, feature: 'add auth' });
    const inst = render(<Harness prepared={prepared} onComplete={() => {}} />);
    await flush();

    inst.unmount();
    await flush();

    expect(abortTurn()).toBe(false);
    expect(requestRewind({ target: 'spec' })).toBe(false);
  });
});
