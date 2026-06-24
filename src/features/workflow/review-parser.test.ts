import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { addEvent, resetWorkflow } from '../../stores/workflow/actions.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { terminalSequences } from '../../lib/terminal/control.js';
import { setActiveTerminalHandover } from '../../lib/terminal/editor-handover.js';
import { setQueueHandler, clearAllHandlers } from './handlers.js';
import {
  BRIEFS_REVIEW_HINT,
  createReviewInputHandler,
  parseReviewCommand,
} from './review-parser.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import type { Phase } from '../../core/schemas/enums.js';

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
    setReviewMode: vi.fn<UseInputModeResult['setReviewMode']>(),
    setQuestionMode: vi.fn<UseInputModeResult['setQuestionMode']>(),
    resolve,
    resetMode: vi.fn(),
  };
}

function setPhase(phase: Phase) {
  addEvent({ type: 'planner_status', ts: Date.now(), phase, status: 'running' });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'review-parser-test-'));
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
    // no setQueueHandler — returns false

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('no handler');

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('no active workflow');
  });
});

describe('createReviewInputHandler – idle / other phases', () => {
  it('does nothing when phase is idle and mode is normal', async () => {
    // phase stays as 'idle' (initial state)
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('ignored');

    expect(enqueue).not.toHaveBeenCalled();
    // feedbackStore should not be set with error
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

describe('parseReviewCommand', () => {
  it('parses approve', () => {
    expect(parseReviewCommand('approve')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'approve' },
    });
    expect(parseReviewCommand('yes')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'approve' },
    });
  });

  it('parses reject/quit aliases', () => {
    expect(parseReviewCommand('reject')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'reject' },
    });
    expect(parseReviewCommand('quit')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'reject' },
    });
    expect(parseReviewCommand('q')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'reject' },
    });
  });

  it('parses comment with text', () => {
    expect(parseReviewCommand('comment add more tests')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'revise', comment: 'add more tests' },
    });
    expect(parseReviewCommand('revise split the first task')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'revise', comment: 'split the first task' },
    });
  });

  it('parses edit', () => {
    expect(parseReviewCommand('edit')).toEqual({ kind: 'open-external-editor' });
    expect(parseReviewCommand('e')).toEqual({ kind: 'open-external-editor' });
  });

  it('parses explicit external edit commands', () => {
    expect(parseReviewCommand('E')).toEqual({ kind: 'open-external-editor' });
    expect(parseReviewCommand('edit-file')).toEqual({ kind: 'open-external-editor' });
    expect(parseReviewCommand('external_edit_applied')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'external_edit_applied' },
    });
  });

  it('parses non-settling brief review commands', () => {
    expect(parseReviewCommand('save_draft')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'save_draft' },
    });
    expect(parseReviewCommand('status')).toEqual({
      kind: 'brief-review-command',
      command: { action: 'status' },
    });
  });

  it('returns null for unknown input', () => {
    expect(parseReviewCommand('unknown command here')).toBeNull();
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
    vi.stubEnv('EDITOR', 'true');
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput(command);

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('keeps external editor behavior for non-brief reviews', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile('/tmp/supporting-spec.md');
    vi.stubEnv('EDITOR', '/definitely/missing-diptych-editor');
    const { handleInput } = createReviewInputHandler(makeInputMode('review'));

    await handleInput('edit');

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Failed to open editor');
  });

  it('opens the external editor for a non-brief review without resolving the gate', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-spec' });
    reviewStore.setReviewFile('/tmp/spec.md');
    vi.stubEnv('EDITOR', 'true');
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput('edit');

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('surfaces non-zero editor exit status and keeps brief review unresolved', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    reviewStore.setReviewFile('/tmp/tasks.md');
    vi.stubEnv('EDITOR', await writeFakeEditor(42));
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
    vi.stubEnv('EDITOR', 'true');

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
