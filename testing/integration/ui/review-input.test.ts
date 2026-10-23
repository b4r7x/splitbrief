import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../src/stores/ui/composer-live.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import {
  createReviewInputHandler,
  openReviewFileExternally,
} from '../../../src/features/workflow/review-parser.js';
import { editorStore } from '../../../src/stores/ui/editor.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { REVIEW_HINT } from '../../../src/features/workflow/review-commands.js';
import type { UseInputModeResult } from '../../../src/features/workflow/hooks/use-input-mode.js';
import type { Phase } from '../../../src/core/schemas/enums.js';
import { plainUserMessage } from '../../../src/core/types/user-input.js';

let tmpDir: string;
let written: string[];
let originalStdoutWrite: typeof process.stdout.write;

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
  // The editor handover writes real cursor sequences to process.stdout on every
  // suspend/resume; capture them so spawning tests assert on — not leak — them.
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  written = [];
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  resetWorkflow();
  feedbackStore.reset();
  clearAllHandlers();
  composerDraftStore.reset();
  vi.clearAllMocks();
  lifecycleStore.__testReset();
  reviewStore.clearReview();
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  setActiveTerminalHandover(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('createReviewInputHandler – queueing during a brief', () => {
  it.each<Phase>(['implementing', 'validating-task', 'escalating'])(
    'queues typed text during the %s phase instead of refusing it',
    async (phase) => {
      setPhase(phase);
      const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
      setQueueHandler(enqueue);

      const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
      await handleInput(plainUserMessage('make the diff smaller'));

      expect(enqueue).toHaveBeenCalledWith(plainUserMessage('make the diff smaller'), phase);
      expect(feedbackStore.get()).toMatchObject({ isError: false });
    },
  );

  it('restores the draft when the queue refuses the text', async () => {
    setPhase('implementing');
    const enqueue = vi.fn(() => ({
      status: 'rejected' as const,
      reason: 'queue-full' as const,
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
    }));
    setQueueHandler(enqueue);

    composerLiveStore.setDraft(createDraftDocument('keep every word'));
    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput(plainUserMessage('keep every word'));

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
    });
    expect(composerDraftStore.get().request?.value).toBe('keep every word');
  });
});

describe('createReviewInputHandler – pending un-parked boundary interrupt', () => {
  it('typed text shows the pending-interrupt notice instead of the input-disabled error', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'interrupted' });
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput(plainUserMessage('steer toward smaller diffs'));

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
    await handleInput(plainUserMessage('add error handling'));

    expect(enqueue).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Interrupt pending — stopping at the next step boundary.',
    });
  });
});

describe('createReviewInputHandler – enqueue during live planner phase (Bug #4)', () => {
  it.each<[Phase, string]>([
    ['researching', 'add error handling'],
    ['specifying', 'make it simpler'],
  ])('queues user input while the planner is %s', async (phase, input) => {
    setPhase(phase);
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput(plainUserMessage(input));

    expect(enqueue).toHaveBeenCalledWith(plainUserMessage(input), phase);
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Queued for PLAN · ctrl+⏎ sends now',
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
    await handleInput(plainUserMessage('add error handling'));

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
    });
  });

  it('sets error when no queue handler is set', async () => {
    setPhase('researching');

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput(plainUserMessage('no handler'));

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('no active workflow');
  });
});

describe('createReviewInputHandler – idle / other phases', () => {
  it('does nothing when phase is idle and mode is normal', async () => {
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput(plainUserMessage('ignored'));

    expect(enqueue).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('shows review feedback instead of silently ignoring normal input during plan review', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, messageId: 'msg-1' }));
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput(plainUserMessage('why is nothing happening'));

    expect(enqueue).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: expect.stringContaining('Review prompt is opening'),
    });
  });

  it('uses brief-specific command metadata while a brief review prompt is opening', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));

    await handleInput(plainUserMessage('why is nothing happening'));

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: `Review prompt is opening. Once active, use: ${REVIEW_HINT}`,
    });
  });
});

describe('createReviewInputHandler – brief review edit mode', () => {
  it('resolves q as ending the run', async () => {
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput(plainUserMessage('q'));

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'end-run' });
  });

  it.each(['comment', 'revise'])(
    'resolves %s feedback as a revise, not an approval',
    async (command) => {
      const resolve = vi.fn();
      const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

      await handleInput(plainUserMessage(`${command} add more evidence`));

      expect(resolve).toHaveBeenCalledWith({
        approved: false,
        action: 'revise',
        message: plainUserMessage('add more evidence'),
      });
    },
  );

  it.each(['e', 'edit', 'E', 'edit-file'])(
    'opens plan.json in the editor overlay for %s at the plan card',
    async (command) => {
      lifecycleStore.__testReset({ phase: 'reviewing-plan' });
      await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
      reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
      const resolve = vi.fn();
      const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

      await handleInput(plainUserMessage(command));

      const editor = editorStore.get();
      expect(editor.status === 'open' ? editor.filePath : null).toBe(join(tmpDir, 'plan.json'));
      expect(overlayStore.get().active).toBe('editor');
      expect(resolve).not.toHaveBeenCalled();
      editorStore.close();
      overlayStore.close();
    },
  );

  it('settles the plan card with an external edit of plan.json', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor('true');
    const resolve = vi.fn();

    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    // The file never existed, so neither snapshot is readable: the gate still settles on
    // whatever the engine reads back, but the message must not claim an edit.
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Could not read plan.json after editing — applying changes',
    });
  });

  it('keeps external editor behavior for non-brief reviews', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor('/definitely/missing-splitbrief-editor');

    await openReviewFileExternally(makeInputMode('review'));

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Failed to open editor');
  });

  it('surfaces non-zero editor exit status and keeps the plan card unresolved', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(await writeFakeEditor(42));
    const resolve = vi.fn();

    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Editor exited with status 42');
  });

  it('brackets the async editor spawn with terminal handover and resumes stdin', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
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

    await openReviewFileExternally(makeInputMode('review'));

    const exitIndex = written.indexOf(terminalSequences.exitAltBuffer);
    const enterIndex = written.indexOf(terminalSequences.enterAltBuffer);
    const hintIndex = written.findIndex((chunk) =>
      chunk.includes('plan.json open in true. Close the file to return.'),
    );
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBeGreaterThan(exitIndex);
    expect(hintIndex).toBeLessThan(enterIndex);
    expect(enterIndex).toBeGreaterThan(exitIndex);
    expect(written.indexOf(terminalSequences.hideCursor, enterIndex)).toBeGreaterThan(enterIndex);
    expect(stdinCalls).toEqual(['pause', 'resume']);
  });

  it('tells the user to quit the app while macOS open waits for a review edit', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    vi.stubEnv('VISUAL', '/usr/bin/open -W -t');
    const child = new EventEmitter();
    const started = Promise.withResolvers<void>();
    const resolve = vi.fn();
    const editing = openReviewFileExternally(makeInputMode('review', resolve), (command, args) => {
      expect(command).toBe('/usr/bin/open');
      expect(args).toEqual(['-W', '-t', join(tmpDir, 'plan.json')]);
      started.resolve();
      return child;
    });
    try {
      await started.promise;
      expect(written.join('')).toContain('plan.json open in open. Quit the editor app to return.');
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      child.emit('close', 0, null);
      await editing;
    }
  });

  it('restores the handover and resumes stdin when the editor spawn fails', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor('/definitely/missing-splitbrief-editor');

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

    await openReviewFileExternally(makeInputMode('review'));

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Failed to open editor');
    const exitIndex = written.indexOf(terminalSequences.exitAltBuffer);
    const enterIndex = written.indexOf(terminalSequences.enterAltBuffer);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(enterIndex).toBeGreaterThan(exitIndex);
    expect(written.indexOf(terminalSequences.hideCursor, enterIndex)).toBeGreaterThan(enterIndex);
    expect(stdinCalls).toEqual(['pause', 'resume']);
  });
});

describe('openReviewFileExternally – edit lifecycle feedback', () => {
  async function writeScriptEditor(name: string, body: string): Promise<string> {
    const editorPath = join(tmpDir, name);
    await writeFile(editorPath, `#!/usr/bin/env node\n${body}\n`, 'utf-8');
    await chmod(editorPath, 0o700);
    return editorPath;
  }

  it('announces the editor before the handover and reports a no-change close', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor('true');
    const messages: string[] = [];
    const unsubscribe = feedbackStore.subscribe(() => {
      const { message } = feedbackStore.get();
      if (message !== null) messages.push(message);
    });
    try {
      await openReviewFileExternally(makeInputMode('review'));
    } finally {
      unsubscribe();
    }

    expect(messages[0]).toBe('Opening true — plan.json…');
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Editor closed — no changes to plan.json',
    });
  });

  it('resolves a changed plan.json edit with an applying signal', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(
      await writeScriptEditor(
        'editor-append-brief.js',
        `require('node:fs').appendFileSync(process.argv[2], 'edited\\n');`,
      ),
    );
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Edited plan.json — applying changes',
    });
  });

  it('keeps an unchanged plan card open with a no-change signal', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor('true');
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Editor closed — no changes to plan.json',
    });
  });

  it('reports a SIGINT editor death as a user cancel, not a failure', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(
      await writeScriptEditor('editor-sigint.js', `process.kill(process.pid, 'SIGINT');`),
    );
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Edit cancelled — editor-sigint.js closed by ctrl+c',
    });
  });

  it('still applies an edit saved before the editor died by SIGINT', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(
      await writeScriptEditor(
        'editor-save-sigint.js',
        `require('node:fs').appendFileSync(process.argv[2], 'edited\\n');
process.kill(process.pid, 'SIGINT');`,
      ),
    );
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message: 'Edited plan.json — applying changes',
    });
  });

  it('resolves the plan card with an edit saved before a non-zero exit', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(
      await writeScriptEditor(
        'editor-save-fail-brief.js',
        `require('node:fs').appendFileSync(process.argv[2], 'edited\\n');
process.exit(2);`,
      ),
    );
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message:
        'Editor exited with status 2 (editor-save-fail-brief.js) but saved plan.json — applying changes',
    });
  });

  it('reports a non-zero exit that saved nothing as an unapplied edit', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(await writeScriptEditor('editor-fail.js', 'process.exit(3);'));
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Editor exited with status 3 (editor-fail.js) — edit not applied',
    });
  });

  it('keeps an edit the editor saved before dying by a non-SIGINT signal', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(
      await writeScriptEditor(
        'editor-save-sigterm.js',
        `require('node:fs').appendFileSync(process.argv[2], 'edited\\n');
process.kill(process.pid, 'SIGTERM');`,
      ),
    );
    const resolve = vi.fn();
    await openReviewFileExternally(makeInputMode('review', resolve));

    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get()).toMatchObject({
      isError: false,
      message:
        'editor-save-sigterm.js terminated by SIGTERM but saved plan.json — applying changes',
    });
  });

  it('reports a non-SIGINT signal death that saved nothing as an editor failure', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    stubReviewEditor(
      await writeScriptEditor('editor-sigterm.js', `process.kill(process.pid, 'SIGTERM');`),
    );
    await openReviewFileExternally(makeInputMode('review'));

    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Editor failed: editor-sigterm.js terminated by SIGTERM',
    });
  });

  it('ignores a second edit request while the editor is already out', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    const runLog = join(tmpDir, 'editor-runs.log');
    stubReviewEditor(
      await writeScriptEditor(
        'editor-slow.js',
        `require('node:fs').appendFileSync(${JSON.stringify(runLog)}, 'run\\n');
setTimeout(() => process.exit(0), 150);`,
      ),
    );
    const inputMode = makeInputMode('review');

    await Promise.all([openReviewFileExternally(inputMode), openReviewFileExternally(inputMode)]);

    const runs = await readFile(runLog, 'utf-8');
    expect(runs).toBe('run\n');
  });

  it('does not open the editor when the gate settles during the opening-signal window', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    reviewStore.setReviewFile(join(tmpDir, 'plan.md'));
    const runLog = join(tmpDir, 'editor-runs.log');
    stubReviewEditor(
      await writeScriptEditor(
        'editor-log.js',
        `require('node:fs').appendFileSync(${JSON.stringify(runLog)}, 'run\\n');`,
      ),
    );
    const resolve = vi.fn();
    const pending = openReviewFileExternally(makeInputMode('review', resolve));
    reviewStore.clearReview();
    await pending;

    expect(resolve).not.toHaveBeenCalled();
    await expect(readFile(runLog, 'utf-8')).rejects.toThrow();
    expect(feedbackStore.get().message).toBeNull();
  });

  it('does not resolve a review gate that replaced the edited one while the editor was out', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    const reviewFile = join(tmpDir, 'plan.md');
    await writeFile(join(tmpDir, 'plan.json'), '{}\n', 'utf-8');
    const laterReviewFile = join(tmpDir, 'tasks.md');
    await writeFile(laterReviewFile, '# tasks\n', 'utf-8');
    reviewStore.setReviewFile(reviewFile);
    const editorOutFile = join(tmpDir, 'editor-out');
    const releaseFile = join(tmpDir, 'editor-release');
    stubReviewEditor(
      await writeScriptEditor(
        'editor-hold.js',
        `const fs = require('node:fs');
fs.appendFileSync(process.argv[2], 'edited\\n');
fs.writeFileSync(${JSON.stringify(editorOutFile)}, 'ready');
const waiting = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releaseFile)})) clearInterval(waiting);
}, 10);`,
      ),
    );
    const resolve = vi.fn();
    const pending = openReviewFileExternally(makeInputMode('review', resolve));
    try {
      await vi.waitFor(async () => {
        expect(await readFile(editorOutFile, 'utf-8')).toBe('ready');
      });
      lifecycleStore.__testReset({ phase: 'reviewing-plan' });
      reviewStore.setReviewFile(laterReviewFile);
    } finally {
      await writeFile(releaseFile, 'release');
      await pending;
    }

    expect(resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toMatchObject({
      isError: true,
      message: 'Review closed while editing — plan.json saved but not applied',
    });
  });
});

describe('createReviewInputHandler – question mode', () => {
  it('question submission clears the interrupted state before resolving', async () => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'interrupted' });
    const document = createDraftDocument('steer toward smaller diffs');
    composerLiveStore.setDraft(document);
    const resolved: Array<{ value: unknown; status: string }> = [];
    const { handleInput } = createReviewInputHandler(
      makeInputMode('question', (value) => {
        resolved.push({ value, status: lifecycleStore.get().status });
      }),
    );

    await handleInput(plainUserMessage('steer toward smaller diffs'));

    expect(resolved).toEqual([
      {
        value: { message: plainUserMessage('steer toward smaller diffs'), document },
        status: 'running',
      },
    ]);
  });
});
