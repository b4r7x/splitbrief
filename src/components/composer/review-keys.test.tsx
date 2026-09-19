import { beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { reviewKeysStore } from '../../stores/ui/review-keys.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../lib/terminal/typeahead-grace.js';
import { parseReviewCommand } from '../../features/workflow/review-commands.js';
import { ApprovalPrompt } from '../../features/workflow/components/approval-prompt.js';
import {
  REVIEW_COMMENT_HINTS,
  REVIEW_DOCUMENT_HINTS,
} from '../../features/workflow/prompt-rows/approval.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { Composer } from './composer.js';

const PAST_GRACE = PROMPT_TYPEAHEAD_GRACE_MS + 30;

function reviewComposer(submissions: string[]) {
  return (
    <Composer
      commands={[]}
      currentScreen="workflow"
      mode="review"
      hint="y approve · e edit · c comment · q reject"
      onSubmit={(text) => submissions.push(text)}
      onRuntimeCommand={() => {}}
    />
  );
}

// The workflow screen derives the panel's `commenting` from the armed flag the composer writes
// (`src/app/screens/workflow.tsx:78`); mirroring that derivation is what lets the keystroke and
// the legend be one render apart here as they are on screen.
function ReviewPanel() {
  const armed = reviewKeysStore.use((s) => s.armed);
  return <ApprovalPrompt review={{ artifact: 'plan', selectedIndex: 1, commenting: !armed }} />;
}

describe('Composer review action keys', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it.each([
    ['y', 'approve'],
    ['e', 'edit-file'],
    ['q', 'end-run'],
  ])('settles the gate when %s is pressed on an empty draft', async (typed, command) => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(typed);
    await flushEffects();

    expect(submissions).toEqual([command]);
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain(`> ${typed}`);
    ui.unmount();
  });

  it('opens a typed comment instead of settling when c is pressed', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('c');
    await flushEffects();

    expect(submissions).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('comment ');

    ui.stdin.write('split the first task');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['comment split the first task']);
    ui.unmount();
  });

  it('types the letters as text once the draft is no longer empty', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('c');
    await flushEffects();
    ui.stdin.write('q');
    await flushEffects();
    ui.stdin.write('y');
    await flushEffects();

    expect(submissions).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('comment qy');
    ui.unmount();
  });

  it('ignores action keys buffered before the gate opened', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await flushEffects();

    ui.stdin.write('y');
    await flushEffects();

    expect(submissions).toEqual([]);
    ui.unmount();
  });

  it('publishes the armed flag the review panel legend reads, so both change together', async () => {
    const ui = renderFeature(reviewComposer([]));
    await tick(PAST_GRACE);
    await flushEffects();

    // Empty draft: the keys are live and the panel is entitled to advertise them.
    expect(reviewKeysStore.get().armed).toBe(true);

    ui.stdin.write('c');
    await flushEffects();

    // One keystroke turns the letters back into text, and the panel stops promising them in the
    // same render — there is no second computation that could disagree.
    expect(reviewKeysStore.get().armed).toBe(false);

    ui.unmount();
    expect(reviewKeysStore.get().armed).toBe(false);
  });

  it('turns the review panel legend over to the comment keys when c starts a draft', async () => {
    controlsStore.setInputMode('review');
    const ui = renderFeature(
      <>
        <ReviewPanel />
        {reviewComposer([])}
      </>,
    );
    await tick(PAST_GRACE);
    await flushEffects();

    expect(stripAnsiStyles(ui.lastFrame())).toContain(REVIEW_DOCUMENT_HINTS);

    ui.stdin.write('c');
    await flushEffects();

    // The panel is a mirror of `reviewKeysStore.armed`, so the draft and the legend change in the
    // same render: the composer holds `comment ` and the letters are text again.
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain(REVIEW_COMMENT_HINTS);
    expect(frame).not.toContain(REVIEW_DOCUMENT_HINTS);
    expect(frame).toContain('comment ');
    ui.unmount();
  });

  // A review gate can also be settled by sending the command as text, so the typed vocabulary has
  // to keep working after the one-key shortcuts were added.
  it.each([
    ['approve', { kind: 'brief-review-command', command: { action: 'approve' } }],
    ['end-run', { kind: 'brief-review-command', command: { action: 'end-run' } }],
    ['edit-file', { kind: 'open-external-editor' }],
    [
      'comment add more evidence',
      { kind: 'brief-review-command', command: { action: 'revise', comment: 'add more evidence' } },
    ],
  ])('still submits %s as a typed command the review parser accepts', async (typed, parsed) => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await tick(PAST_GRACE);
    await flushEffects();

    // The first letter of `approve` is not a bound key; `e` and `c` are, so typing them first
    // would settle or prefill. Seeding a space keeps the draft non-empty, exactly as an IPC
    // client's text arrives, and proves the letters are text from that point on.
    ui.stdin.write(` ${typed}`);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    // The seed keeps the keys in text mode while it lives in the draft; send strips it as typing
    // residue, and the parser settles the word — exactly as it does for text arriving over IPC.
    expect(submissions).toEqual([typed]);
    expect(parseReviewCommand(submissions[0] ?? '')).toEqual(parsed);
    ui.unmount();
  });

  it('leaves the keys alone outside review mode', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="normal"
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write('y');
    await flushEffects();

    expect(submissions).toEqual([]);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('y');
    ui.unmount();
  });
});
