import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { setActiveTerminalHandover } from '../../lib/terminal/editor-handover.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
  createReviewInputHandler,
  openReviewFileExternally,
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
    lifecycleStore.__testReset({ phase: 'reviewing-spec' });
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
    const reviewFile = join(tempDir, 'spec.md');
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

  it('uses the same typed refusal path for a review reject key', async () => {
    const inputMode = makeInputMode('review');

    await createReviewInputHandler(inputMode).handleInput('q');

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false });
  });
});
