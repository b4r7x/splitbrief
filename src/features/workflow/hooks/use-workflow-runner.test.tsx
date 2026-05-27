import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { useInputMode } from './use-input-mode.js';
import { useWorkflowRunner } from './use-workflow-runner.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  abortTurn,
  requestCancel,
  requestRewind,
  clearAllHandlers,
} from '../handlers.js';
import { writeActive } from '../../../core/sessions/lifecycle.js';
import { ensureDiptychDir, ensureSessionDir } from '../../../core/paths-io.js';
import { saveState } from '../../../core/state/persistence.js';
import { createInitialState } from '../../../core/state/machine.js';
import { sessionDir } from '../../../core/paths.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';

// Harness mounts useWorkflowRunner with a bogus planner command so that
// runWorkflow exits fast via the "planner not available" branch in
// initializeWorkflow. That keeps the hook's React-side lifecycle observable
// (reset, resume, rewind, cancel) without requiring a full engine spin-up.

interface RunnerHandle {
  startedAt: string;
  handleResume: () => void;
}

interface HarnessProps {
  feature: string;
  projectDir: string;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  captureRunner?: { current: RunnerHandle | null };
}

function Harness({
  feature,
  projectDir,
  onComplete,
  initialResumeState,
  sessionId,
  captureRunner,
}: HarnessProps) {
  const inputMode = useInputMode();
  const config = makeConfig({
    planner: { kind: 'agent', command: 'diptych-non-existent-planner-x7q9' },
  });
  const runner = useWorkflowRunner({
    feature,
    projectDir,
    config,
    onComplete,
    initialResumeState,
    inputMode,
    sessionId,
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
  ensureDiptychDir(projectDir);
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

  it('applies resume-state phase to the lifecycle store so the UI reflects the resumed phase', async () => {
    const resume: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'planning',
    };

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        initialResumeState={resume}
      />,
    );
    await flush();

    expect(lifecycleStore.get().phase).toBe('planning');
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

  it('persists a rewind event to the session log when the user rewinds to spec', async () => {
    const sessionId = '2024-01-01-add-auth';
    ensureSessionDir(projectDir, sessionId);
    const saved: WorkflowState = {
      ...createInitialState('add auth'),
      phase: 'reviewing-spec',
    };
    saveState(projectDir, sessionId, saved);
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
      />,
    );
    await flush();
    // The bogus planner completes quickly and saveFinalSession clears the
    // active marker; we restore it to simulate a mid-flight rewind request
    // from the UI while the engine is still running.
    writeActive({ projectDir: projectDir, sessionId: sessionId });

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
    saveState(projectDir, sessionId, saved);
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const inst = render(
      <Harness
        feature="add auth"
        projectDir={projectDir}
        onComplete={() => {}}
        sessionId={sessionId}
      />,
    );
    await flush();
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const didRewind = requestRewind({ target: 'task', taskId: 'T001' });
    expect(didRewind).toBe(true);
    await flush();

    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('task_reset');
    expect(log).toContain('T001');

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
