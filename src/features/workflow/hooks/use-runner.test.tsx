import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import type { Config } from '../../../core/schemas/config.js';
import type { PlannerConfig } from '../../../core/schemas/planner-config.js';
import { buildContextOverflowRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/task.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner } from './use-runner.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  abortTurn,
  interruptTurn,
  requestCancel,
  requestRewind,
  clearAllHandlers,
} from '../handlers.js';
import { writeActive } from '../../../core/sessions/lifecycle.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
import { saveState, loadState } from '../../../core/state/persistence.js';
import { saveSummary } from '../../../core/sessions/io.js';
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
  feature: string;
  projectDir: string;
  onComplete: (completion: WorkflowCompletion) => void;
  initialResumeState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  captureRunner?: { current: RunnerHandle | null };
  planner?: PlannerConfig | undefined;
  workflow?: Partial<Config['workflow']> | undefined;
  runWorkflow?: RunWorkflowFn | undefined;
}

function Harness({
  feature,
  projectDir,
  onComplete,
  initialResumeState,
  sessionId,
  captureRunner,
  planner,
  workflow,
  runWorkflow,
}: HarnessProps) {
  const inputMode = useInputMode();
  const config = makeConfig({
    planner: planner ?? { kind: 'agent', command: 'splitbrief-non-existent-planner-x7q9' },
    ...(workflow !== undefined && { workflow }),
  });
  const runner = useWorkflowRunner({
    feature,
    projectDir,
    config,
    onComplete,
    initialResumeState,
    inputMode,
    sessionId,
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
  clearAllHandlers();
});

afterEach(() => {
  clearAllHandlers();
  resetWorkflow();
  controlsStore.reset();
  feedbackStore.reset();
  cleanupTempDir(projectDir);
});

describe('useWorkflowRunner', () => {
  it('resets workflow stores on mount and produces a valid startedAt timestamp', async () => {
    // Seed the stores so the test proves they were reset on mount.
    lifecycleStore.__testReset({ cancelled: true, queueDepth: 5 });
    const captureRunner: HarnessProps['captureRunner'] = { current: null };

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        captureRunner={captureRunner}
      />,
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
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        initialResumeState={resume}
      />,
    );

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

  it('keeps opaque resumed sessions transcript-private when current config allows transcripts', async () => {
    const sessionId = '2026-06-18-session-abcdef123456';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const resume: WorkflowState = {
      ...createInitialState('secret oauth login'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001' })],
    };
    saveState({ projectDir, sessionId }, resume);
    let seenPersistTranscript: boolean | undefined;
    const runWorkflowStub: RunWorkflowFn = vi.fn(async (opts) => {
      seenPersistTranscript = opts.config.workflow.persistTranscript;
      return makeSummary();
    });

    const inst = render(
      <Harness
        feature="secret oauth login"
        projectDir={projectDir}
        onComplete={() => {}}
        initialResumeState={resume}
        sessionId={sessionId}
        workflow={{ mode: 'quick', persistTranscript: true }}
        runWorkflow={runWorkflowStub}
      />,
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

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={(c) => {
          completion = c;
        }}
        sessionId={sessionId}
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

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={(c) => {
          completion = c;
        }}
        sessionId={sessionId}
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
    writeActive({ projectDir, sessionId });

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        initialResumeState={paused}
        sessionId={sessionId}
      />,
    );
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
    const inst = render(
      <Harness feature="add auth" projectDir={projectDir} onComplete={() => {}} />,
    );
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
    const inst = render(
      <Harness
        feature="cancel reason"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
        planner={{ kind: 'shell', command: 'sleep', args: ['10'] }}
        workflow={{ mode: 'quick', persistTranscript: false }}
        runWorkflow={runWorkflowWithCompletion}
      />,
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

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
      />,
    );
    await flush();
    // No `.splitbrief/active` pointer is hand-written. The rewind handler must use the
    // in-scope sessionId prop (F-317), so the rewind still lands even though the bogus
    // planner has finished and saveFinalSession cleared the active marker.

    const didRewind = requestRewind({ target: 'spec', comment: 'needs clarification' });
    expect(didRewind).toBe(true);
    await flush();

    // Rewind appended to the session log on disk.
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

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
      />,
    );
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

  it('rewinds the in-scope session even when .splitbrief/active names a different session', async () => {
    // pointer=A (a foreign interrupted session) while the screen is scoped to sessionId=B.
    // Per F-317/F-329 the rewind handler must use the in-scope id (B) and never touch A.
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

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={scopedSessionId}
      />,
    );
    await flush();
    // The pointer now names a FOREIGN interrupted session while the screen stays scoped to B.
    // A pointer-keyed rewind would corrupt the foreign session; the in-scope id (B) must win.
    writeActive({ projectDir, sessionId: foreignSessionId });

    const didRewind = requestRewind({ target: 'spec', comment: 'scope-correct rewind' });
    expect(didRewind).toBe(true);
    await flush();

    // The scoped session received the rewind...
    const scopedLog = readFileSync(
      join(sessionDir(projectDir, scopedSessionId), 'session.jsonl'),
      'utf-8',
    );
    expect(scopedLog).toContain('rewind_to_spec');
    expect(scopedLog).toContain('scope-correct rewind');

    // ...and the foreign session named by .splitbrief/active was never written to.
    expect(existsSync(join(sessionDir(projectDir, foreignSessionId), 'session.jsonl'))).toBe(false);

    inst.unmount();
  });

  it('handleResume shows a feedback error when there is no saved state on disk', async () => {
    const captureRunner: HarnessProps['captureRunner'] = { current: null };

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        captureRunner={captureRunner}
      />,
    );
    await flush();

    // No active session was written — handleResume should surface a feedback
    // error instead of trying to resume.
    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume();
    await flush();

    expect(feedbackStore.get().message).toMatch(/no saved state/i);
    expect(feedbackStore.get().isError).toBe(true);

    inst.unmount();
  });

  it('enqueues injected resume text into the saved state message queue so the resumed planner drains it', async () => {
    const sessionId = '2024-01-01-inject';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'planning',
    };
    saveState({ projectDir, sessionId }, saved);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
        captureRunner={captureRunner}
      />,
    );
    await flush();

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume('what about edge case X?');
    await flush();

    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    const pending = persisted.messageQueue.filter((m) => !m.drainedAt);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe('what about edge case X?');
    expect(pending[0]?.phase).toBe('planning');
    expect(pending[0]?.origin).toBe('user-input');

    inst.unmount();
  });

  it('enqueues injected resume text while resuming an implementing phase', async () => {
    const sessionId = '2024-01-01-implementing-inject';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'implementing',
    };
    saveState({ projectDir, sessionId }, saved);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
        captureRunner={captureRunner}
      />,
    );
    await flush();

    const runner = captureRunner.current;
    if (!runner) throw new Error('expected captureRunner.current to be populated');
    runner.handleResume('carry this into implementation');
    await flush();

    const persisted = loadState({ projectDir, sessionId });
    if (!persisted) throw new Error('expected persisted state on disk');
    expect(persisted.messageQueue).toEqual([
      expect.objectContaining({
        text: 'carry this into implementation',
        phase: 'implementing',
      }),
    ]);
    expect(feedbackStore.get().isError).toBe(false);

    inst.unmount();
  });

  it('resumes without queuing when no injected text is provided', async () => {
    const sessionId = '2024-01-01-empty-continue';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'planning',
    };
    saveState({ projectDir, sessionId }, saved);

    const captureRunner: HarnessProps['captureRunner'] = { current: null };
    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
        captureRunner={captureRunner}
      />,
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
    const inst = render(
      <Harness feature="add auth" projectDir={projectDir} onComplete={() => {}} />,
    );
    await flush();

    inst.unmount();
    await flush();

    // After unmount, no handler is registered.
    expect(abortTurn()).toBe(false);
    expect(requestRewind({ target: 'spec' })).toBe(false);
  });
});
