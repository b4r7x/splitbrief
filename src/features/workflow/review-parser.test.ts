import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { setActiveTerminalHandover } from '../../lib/terminal/editor-handover.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { clearAllHandlers, setQueueHandler } from './handlers.js';
import {
  createReviewInputHandler,
  openReviewFileExternally,
  type ReviewInputEffects,
  type SpawnEditor,
} from './review-parser.js';
import { reviewOpeningPromptMessage } from './review-commands.js';

type EditorOutcome =
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error };

function makeInputMode(mode: UseInputModeResult['mode'] = 'review'): UseInputModeResult {
  return {
    mode,
    hint: '',
    questionEpoch: 0,
    setReviewMode: vi.fn(async () => ({ approved: false as const })),
    setQuestionMode: vi.fn(async () => ''),
    resolve: vi.fn(),
    resetMode: vi.fn(),
  };
}

describe('openReviewFileExternally stale-owner feedback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'review-parser-test-'));
    feedbackStore.reset();
    reviewStore.reset();
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    vi.stubEnv('VISUAL', 'mock-editor');
    setActiveTerminalHandover({
      fullscreen: false,
      mouse: false,
      sourceStdin: {
        isRaw: false,
        pause: vi.fn(),
        resume: vi.fn(),
      },
    });
  });

  afterEach(() => {
    setActiveTerminalHandover(undefined);
    feedbackStore.reset();
    reviewStore.reset();
    lifecycleStore.reset();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'unchanged close',
      outcome: { kind: 'close', code: 0, signal: null } satisfies EditorOutcome,
    },
    {
      label: 'spawn error',
      outcome: { kind: 'error', error: new Error('spawn failed') } satisfies EditorOutcome,
    },
    {
      label: 'SIGINT without changes',
      outcome: { kind: 'close', code: null, signal: 'SIGINT' } satisfies EditorOutcome,
    },
    {
      label: 'signal without changes',
      outcome: { kind: 'close', code: null, signal: 'SIGTERM' } satisfies EditorOutcome,
    },
    {
      label: 'non-zero exit without changes',
      outcome: { kind: 'close', code: 1, signal: null } satisfies EditorOutcome,
    },
  ])('does not overwrite newer feedback after a stale $label', async ({ outcome }) => {
    const reviewFile = join(tempDir, 'plan.json');
    const newerReviewFile = join(tempDir, 'newer.md');
    writeFileSync(reviewFile, '# spec\n');
    writeFileSync(newerReviewFile, '# newer\n');
    reviewStore.setReviewFile(reviewFile);

    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => {
        reviewStore.setReviewFile(newerReviewFile);
        feedbackStore.setMessage('new-owner feedback');
        if (outcome.kind === 'error') {
          child.emit('error', outcome.error);
        } else {
          child.emit('close', outcome.code, outcome.signal);
        }
      });
      return child;
    };

    await openReviewFileExternally(makeInputMode(), spawnEditor);

    expect(feedbackStore.get()).toEqual({
      message: 'new-owner feedback',
      isError: false,
    });
  });

  it('settles the card with the in-app edit an untouched external editor leaves on disk', async () => {
    const planMd = join(tempDir, 'plan.md');
    writeFileSync(planMd, 'Greet people by name\n');
    // The overlay saved its buffer to plan.json before it handed over to the external editor.
    writeFileSync(join(tempDir, 'plan.json'), '{"edited":true}\n');
    reviewStore.setReviewFile(planMd);
    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };
    const inputMode = makeInputMode();

    await openReviewFileExternally(inputMode, spawnEditor, '{"compiled":true}\n');

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
  });

  it('settles the card with the in-app edit when the external editor fails to start', async () => {
    const planMd = join(tempDir, 'plan.md');
    writeFileSync(planMd, 'Greet people by name\n');
    writeFileSync(join(tempDir, 'plan.json'), '{"edited":true}\n');
    reviewStore.setReviewFile(planMd);
    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    };
    const inputMode = makeInputMode();

    await openReviewFileExternally(inputMode, spawnEditor, '{"compiled":true}\n');

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
  });
});

describe('review input ownership', () => {
  beforeEach(() => {
    feedbackStore.reset();
    reviewStore.reset();
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
  });

  afterEach(() => {
    feedbackStore.reset();
    reviewStore.reset();
    lifecycleStore.reset();
  });

  it('does not parse composer text as a review shortcut', async () => {
    const inputMode = makeInputMode('normal');

    await createReviewInputHandler(inputMode).handleInput('q');

    expect(inputMode.resolve).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBe(reviewOpeningPromptMessage());
  });

  it('passes question/editor-owned text through without shortcut parsing', async () => {
    const inputMode = makeInputMode('question');

    await createReviewInputHandler(inputMode).handleInput('q');

    expect(inputMode.resolve).toHaveBeenCalledWith('q');
  });

  it('uses the same typed refusal path for the review end-run key', async () => {
    const inputMode = makeInputMode('review');

    await createReviewInputHandler(inputMode).handleInput('q');

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false, action: 'end-run' });
  });
});

describe('review input effects', () => {
  let tempDir: string;
  let stdinPause = vi.fn<() => void>();

  function makeEffects(enqueue: ReviewInputEffects['enqueue'] = async () => null) {
    return {
      openExternalEditor: vi.fn<ReviewInputEffects['openExternalEditor']>(async () => {}),
      enqueue: vi.fn<ReviewInputEffects['enqueue']>(enqueue),
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'review-effects-test-'));
    feedbackStore.reset();
    reviewStore.reset();
    composerDraftStore.reset();
    clearAllHandlers();
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    vi.stubEnv('VISUAL', 'mock-editor');
    // The handover is the last thing that runs before the editor is spawned, so a paused
    // stdin is the proof a real process was about to take the terminal.
    stdinPause = vi.fn();
    setActiveTerminalHandover({
      fullscreen: false,
      mouse: false,
      sourceStdin: { isRaw: false, pause: stdinPause, resume: vi.fn() },
    });
  });

  afterEach(() => {
    setActiveTerminalHandover(undefined);
    clearAllHandlers();
    feedbackStore.reset();
    reviewStore.reset();
    lifecycleStore.reset();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['e', 'edit', 'edit-file'])(
    'opens plan.json in the editor overlay for %s and never reaches the terminal handover',
    async (command) => {
      lifecycleStore.__testReset({ phase: 'reviewing-plan' });
      const reviewFile = join(tempDir, 'plan.md');
      writeFileSync(reviewFile, '# Plan\n');
      writeFileSync(join(tempDir, 'plan.json'), '{}\n');
      reviewStore.setReviewFile(reviewFile);
      const inputMode = makeInputMode('review');
      const effects = makeEffects();

      await createReviewInputHandler(inputMode, effects).handleInput(command);

      const editor = editorStore.get();
      expect(editor.status === 'open' ? editor.filePath : null).toBe(join(tempDir, 'plan.json'));
      expect(overlayStore.get().active).toBe('editor');
      expect(effects.openExternalEditor).not.toHaveBeenCalled();
      expect(stdinPause).not.toHaveBeenCalled();
      expect(inputMode.resolve).not.toHaveBeenCalled();
      editorStore.close();
      overlayStore.close();
    },
  );

  it.each([
    { command: 'y', resolved: { approved: true } },
    { command: 'q', resolved: { approved: false, action: 'end-run' } },
    {
      command: 'comment more evidence',
      resolved: { approved: false, action: 'revise', comment: 'more evidence' },
    },
  ])('resolves $command the same way with the effects supplied', async ({ command, resolved }) => {
    const inputMode = makeInputMode('review');
    const effects = makeEffects();

    await createReviewInputHandler(inputMode, effects).handleInput(command);

    expect(inputMode.resolve).toHaveBeenCalledWith(resolved);
    expect(effects.openExternalEditor).not.toHaveBeenCalled();
  });

  it('sends free text typed at the plan card back to the planner as a correction', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    const reviewFile = join(tempDir, 'plan.md');
    writeFileSync(reviewFile, 'Greet people by name\n');
    reviewStore.setReviewFile(reviewFile);
    const inputMode = makeInputMode('review');

    await createReviewInputHandler(inputMode, makeEffects()).handleInput('  Greet in Polish ');

    expect(inputMode.resolve).toHaveBeenCalledWith({
      approved: false,
      action: 'revise',
      comment: 'Greet in Polish',
    });
    expect(feedbackStore.get().message).toBeNull();
  });

  it('opens the comment draft for a bare c instead of sending the letter to the planner', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    const reviewFile = join(tempDir, 'plan.md');
    writeFileSync(reviewFile, 'Greet people by name\n');
    reviewStore.setReviewFile(reviewFile);
    const inputMode = makeInputMode('review');

    await createReviewInputHandler(inputMode, makeEffects()).handleInput('c');

    expect(inputMode.resolve).not.toHaveBeenCalled();
    expect(composerDraftStore.get().request?.value).toBe('comment ');
  });

  it('answers a question through the same resolve with the effects supplied', async () => {
    const inputMode = makeInputMode('question');
    const effects = makeEffects();

    await createReviewInputHandler(inputMode, effects).handleInput('use the other adapter');

    expect(inputMode.resolve).toHaveBeenCalledWith('use the other adapter');
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'accepted',
      outcome: { status: 'accepted' as const, messageId: 'm-1' },
      feedback: { message: 'Message queued for the next planner turn.', isError: false },
    },
    {
      label: 'rejected',
      outcome: {
        status: 'rejected' as const,
        reason: 'queue-full' as const,
        message: 'Queue full (50 messages). Wait for the current phase to complete.',
      },
      feedback: {
        message: 'Queue full (50 messages). Wait for the current phase to complete.',
        isError: true,
      },
    },
    {
      label: 'no workflow',
      outcome: null,
      feedback: { message: 'Cannot queue message: no active workflow.', isError: true },
    },
  ])(
    'queues live planner input through the supplied enqueue — $label',
    async ({ outcome, feedback }) => {
      lifecycleStore.__testReset({ phase: 'researching' });
      const registered = vi.fn(() => ({ status: 'accepted' as const, messageId: 'from-the-run' }));
      setQueueHandler(registered);
      const effects = makeEffects(async () => outcome);

      await createReviewInputHandler(makeInputMode('normal'), effects).handleInput('  steer it  ');

      expect(effects.enqueue).toHaveBeenCalledWith('steer it', 'researching');
      expect(registered).not.toHaveBeenCalled();
      expect(feedbackStore.get()).toEqual(feedback);
    },
  );

  it('queues a correction typed during a brief instead of refusing it', async () => {
    lifecycleStore.__testReset({ phase: 'implementing' });
    const effects = makeEffects(async () => ({ status: 'accepted' as const, messageId: 'm-1' }));

    await createReviewInputHandler(makeInputMode('normal'), effects).handleInput(
      '  smaller diffs  ',
    );

    expect(effects.enqueue).toHaveBeenCalledWith('smaller diffs', 'implementing');
    expect(feedbackStore.get()).toEqual({
      message: 'Message queued for the next planner turn.',
      isError: false,
    });
  });

  it('confirms a message queued during the final review is for the reviewer', async () => {
    lifecycleStore.__testReset({ phase: 'final-review' });
    const effects = makeEffects(async () => ({ status: 'accepted' as const, messageId: 'm-1' }));

    await createReviewInputHandler(makeInputMode('normal'), effects).handleInput('check the icons');

    expect(effects.enqueue).toHaveBeenCalledWith('check the icons', 'final-review');
    expect(feedbackStore.get()).toEqual({
      message: 'Message queued for the reviewer.',
      isError: false,
    });
  });

  it('restores the draft when the queue refuses a correction typed during a brief', async () => {
    lifecycleStore.__testReset({ phase: 'implementing' });
    const effects = makeEffects(async () => ({
      status: 'rejected' as const,
      reason: 'queue-full' as const,
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
    }));

    await createReviewInputHandler(makeInputMode('normal'), effects).handleInput('keep me');

    expect(feedbackStore.get()).toEqual({
      message: 'Queue full (50 messages). Wait for the current phase to complete.',
      isError: true,
    });
    expect(composerDraftStore.get().request?.value).toBe('keep me');
  });

  it('keeps the registered queue handler when no effects are supplied', async () => {
    lifecycleStore.__testReset({ phase: 'specifying' });
    const registered = vi.fn(() => ({ status: 'accepted' as const, messageId: 'from-the-run' }));
    setQueueHandler(registered);

    await createReviewInputHandler(makeInputMode('normal')).handleInput('make it simpler');

    expect(registered).toHaveBeenCalledWith('make it simpler', 'specifying');
    expect(feedbackStore.get()).toEqual({
      message: 'Message queued for the next planner turn.',
      isError: false,
    });
  });

  it('opens the external editor on the gate edit file', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    const reviewFile = join(tempDir, 'plan.json');
    writeFileSync(reviewFile, '# spec\n');
    reviewStore.setReviewFile(reviewFile);

    const pending = openReviewFileExternally(makeInputMode('review'));
    // Only openReviewFileExternally announces the editor, and it does so before its first
    // await — so this message is the production function running, not a stand-in.
    expect(feedbackStore.get()).toEqual({
      message: 'Opening mock-editor — plan.json…',
      isError: false,
    });

    // Superseding the review during the paint window is the guard that turns it back before
    // the handover, which is how this test reaches the real function without a process.
    reviewStore.setReviewFile(join(tempDir, 'newer.md'));
    await pending;

    expect(stdinPause).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual({ message: null, isError: false });
  });
});
