import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { reviewStore } from '../../../src/stores/workflow/review.js';
import { terminalSequences } from '../../../src/lib/terminal/control.js';
import { setActiveTerminalHandover } from '../../../src/lib/terminal/editor-handover.js';
import { setQueueHandler, clearAllHandlers } from '../../../src/features/workflow/handlers.js';
import { createReviewInputHandler } from '../../../src/features/workflow/review-parser.js';
import { BRIEFS_REVIEW_HINT } from '../../../src/features/workflow/review-commands.js';
import type { UseInputModeResult } from '../../../src/features/workflow/hooks/use-input-mode.js';
import type { Phase } from '../../../src/core/schemas/enums.js';

let tmpDir: string;

async function writeFakeEditor(exitCode: number): Promise<string> {
  const editorPath = join(tmpDir, `editor-${exitCode}.js`);
  await writeFile(
    editorPath,
    `#!/usr/bin/env node
process.exit(${exitCode});
`,
    'utf-8',
  );
  await chmod(editorPath, 0o700);
  return editorPath;
}

function makeInputMode(
  mode: 'normal' | 'review' | 'question',
  resolve: UseInputModeResult['resolve'] = vi.fn(),
): UseInputModeResult {
  return {
    mode,
    hint: '',
    questionEpoch: 0,
    setReviewMode: vi.fn<UseInputModeResult['setReviewMode']>(),
    setQuestionMode: vi.fn<UseInputModeResult['setQuestionMode']>(),
    resolve,
    resetMode: vi.fn(),
  };
}

function stubReviewEditor(editor: string) {
  vi.stubEnv('VISUAL', '');
  vi.stubEnv('EDITOR', editor);
}

function setPhase(phase: Phase) {
  addEvent({ type: 'planner_status', ts: Date.now(), phase, status: 'running' });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'review-input-test-'));
  resetWorkflow();
  feedbackStore.reset();
  clearAllHandlers();
  vi.clearAllMocks();
  lifecycleStore.__testReset();
  reviewStore.clearReview();
});

afterEach(async () => {
  setActiveTerminalHandover(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('createReviewInputHandler – implementer-phase guard (Bug #5)', () => {
  it('sets error feedback when submitting during implementing phase', async () => {
    setPhase('implementing');
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('some text');

    const { message, isError } = feedbackStore.get();
    expect(isError).toBe(true);
    expect(message).toContain('Input disabled during task implementation');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sets error feedback when submitting during validating-task phase', async () => {
    setPhase('validating-task');
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('some text');

    const { isError } = feedbackStore.get();
    expect(isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sets error feedback when submitting during escalating phase', async () => {
    setPhase('escalating');
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('some text');

    expect(feedbackStore.get().isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('createReviewInputHandler – pending un-parked boundary interrupt', () => {
  it('typed text shows the pending-interrupt notice instead of the input-disabled error', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'interrupted' });
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('steer toward smaller diffs');

    const { message, isError } = feedbackStore.get();
    expect(message).not.toContain('Input disabled during task implementation');
    expect(isError).toBe(false);
    expect(message).toBe('Interrupt pending — stopping at the next step boundary.');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('typed text is not queued as a planner message during the un-parked window', async () => {
    lifecycleStore.__testReset({ phase: 'researching', status: 'interrupted' });
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('add error handling');

    expect(enqueue).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Interrupt pending — stopping at the next step boundary.',
    });
  });
});

describe('createReviewInputHandler – enqueue during live planner phase (Bug #4)', () => {
  it('queues user input while the planner is researching', async () => {
    setPhase('researching');
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('add error handling');

    expect(enqueue).toHaveBeenCalledWith('add error handling', 'researching');
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Message queued for the next planner turn.',
    });
  });

  it('queues user input while the planner is specifying', async () => {
    setPhase('specifying');
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('make it simpler');

    expect(enqueue).toHaveBeenCalledWith('make it simpler', 'specifying');
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Message queued for the next planner turn.',
    });
  });

  it('shows feedback when the queue handler rejects planner input', async () => {
    setPhase('researching');
    const enqueue = vi.fn(() => ({
      status: 'rejected' as const,
      reason: 'queue-full' as const,
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
    }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('add error handling');

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
    });
  });

  it('sets error when no queue handler is set', async () => {
    setPhase('researching');

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('no handler');

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('no active workflow');
  });
});

describe('createReviewInputHandler – idle / other phases', () => {
  it('does nothing when phase is idle and mode is normal', async () => {
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('ignored');

    expect(enqueue).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('shows review feedback instead of silently ignoring normal input during spec review', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-spec' });
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('why is nothing happening');

    expect(enqueue).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: expect.stringContaining('Review prompt is opening'),
    });
  });

  it('uses brief-specific command metadata while a brief review prompt is opening', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));

    await handleInput('why is nothing happening');

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: `Review prompt is opening. Once active, use: ${BRIEFS_REVIEW_HINT}`,
    });
  });
});

describe('createReviewInputHandler – brief review edit mode', () => {
  it('resolves q as a brief review rejection', async () => {
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput('q');

    expect(resolve).toHaveBeenCalledWith({ approved: false });
  });

  it('resolves review comments as revise feedback, not approval', async () => {
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput('comment add more evidence');

    expect(resolve).toHaveBeenCalledWith({
      approved: false,
      action: 'revise',
      comment: 'add more evidence',
    });
  });

  it('resolves revise feedback as revise feedback, not approval', async () => {
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput('revise add more evidence');

    expect(resolve).toHaveBeenCalledWith({
      approved: false,
      action: 'revise',
      comment: 'add more evidence',
    });
  });

  it.each([
    'e',
    'edit',
    'E',
    'edit-file',
  ])('opens persisted tasks.md and resolves edit for %s during brief review', async (command) => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    reviewStore.setReviewFile('/tmp/tasks.md');
    stubReviewEditor('true');
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput(command);

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('keeps external editor behavior for non-brief reviews', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile('/tmp/supporting-spec.md');
    stubReviewEditor('/definitely/missing-splitbrief-editor');
    const { handleInput } = createReviewInputHandler(makeInputMode('review'));

    await handleInput('edit');

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Failed to open editor');
  });

  it('opens the external editor for a non-brief review without resolving the gate', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-spec' });
    reviewStore.setReviewFile('/tmp/spec.md');
    stubReviewEditor('true');
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput('edit');

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('surfaces non-zero editor exit status and keeps brief review unresolved', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    reviewStore.setReviewFile('/tmp/tasks.md');
    stubReviewEditor(await writeFakeEditor(42));
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput('edit-file');

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Editor exited with status 42');
  });

  it('brackets the async editor spawn with terminal handover and resumes stdin', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    reviewStore.setReviewFile('/tmp/tasks.md');
    stubReviewEditor('true');

    const stdinCalls: string[] = [];
    const sourceStdin = Object.assign(new PassThrough(), {
      pause(): NodeJS.ReadStream {
        stdinCalls.push('pause');
        return sourceStdin as unknown as NodeJS.ReadStream;
      },
      resume(): NodeJS.ReadStream {
        stdinCalls.push('resume');
        return sourceStdin as unknown as NodeJS.ReadStream;
      },
    });
    setActiveTerminalHandover({
      fullscreen: true,
      mouse: true,
      sourceStdin: sourceStdin as unknown as NodeJS.ReadStream,
    });

    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    const { handleInput } = createReviewInputHandler(makeInputMode('review'));
    try {
      await handleInput('edit-file');
    } finally {
      process.stdout.write = originalWrite;
    }

    const exitIndex = written.indexOf(terminalSequences.exitAltBuffer);
    const enterIndex = written.indexOf(terminalSequences.enterAltBuffer);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(enterIndex).toBeGreaterThan(exitIndex);
    expect(stdinCalls).toEqual(['pause', 'resume']);
  });
});

describe('createReviewInputHandler – question mode', () => {
  it('question submission clears the interrupted state before resolving', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'interrupted' });
    const resolved: Array<{ value: unknown; status: string }> = [];
    const { handleInput } = createReviewInputHandler(
      makeInputMode('question', (value) => {
        resolved.push({ value, status: lifecycleStore.get().status });
      }),
    );

    await handleInput('steer toward smaller diffs');

    expect(resolved).toEqual([{ value: 'steer toward smaller diffs', status: 'running' }]);
  });
});
