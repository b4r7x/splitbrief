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
  return (
    <ApprovalPrompt
      review={{
        artifact: 'plan',
        confirms: [],
        budgetRows: 40,
        selectedIndex: 1,
        commenting: !armed,
      }}
    />
  );
}

describe('Composer review action keys', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it.each([['y'], ['e'], ['c'], ['q']])(
    'types %s into the draft instead of settling the gate',
    async (typed) => {
      const submissions: string[] = [];
      const ui = renderFeature(reviewComposer(submissions));
      await tick(PAST_GRACE);
      await flushEffects();

      ui.stdin.write(typed);
      await flushEffects();

      expect(submissions).toEqual([]);
      expect(stripAnsiStyles(ui.lastFrame())).toContain(`${typed}`);
      ui.unmount();
    },
  );

  it('submits a sentence that opens with an option letter as typed', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await tick(PAST_GRACE);
    await flushEffects();

    for (const char of 'quickly drop T003') {
      ui.stdin.write(char);
      await flushEffects();
    }
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['quickly drop T003']);
    ui.unmount();
  });

  it('publishes the armed flag the review panel legend reads, so both change together', async () => {
    const ui = renderFeature(reviewComposer([]));
    await tick(PAST_GRACE);
    await flushEffects();

    // Empty draft: the keys are live and the panel is entitled to advertise them.
    expect(reviewKeysStore.get().armed).toBe(true);

    ui.stdin.write('x');
    await flushEffects();

    // One keystroke starts a correction, and the panel stops promising its rows in the same
    // render — there is no second computation that could disagree.
    expect(reviewKeysStore.get().armed).toBe(false);

    ui.unmount();
    expect(reviewKeysStore.get().armed).toBe(false);
  });

  it('turns the review panel legend over to the comment keys when a draft starts', async () => {
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

    ui.stdin.write('split T002');
    await flushEffects();

    // The panel is a mirror of `reviewKeysStore.armed`, so the draft and the legend change in the
    // same render.
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain(REVIEW_COMMENT_HINTS);
    expect(frame).not.toContain(REVIEW_DOCUMENT_HINTS);
    expect(frame).toContain('split T002');
    ui.unmount();
  });

  // A review gate is settled by sending the command as text, so the typed vocabulary reaches the
  // parser whole.
  it.each([
    ['approve', { kind: 'brief-review-command', command: { action: 'approve' } }],
    ['end-run', { kind: 'brief-review-command', command: { action: 'end-run' } }],
    ['edit-file', { kind: 'open-editor' }],
    ['c', { kind: 'comment-draft' }],
    [
      'comment add more evidence',
      { kind: 'brief-review-command', command: { action: 'revise', comment: 'add more evidence' } },
    ],
  ])('still submits %s as a typed command the review parser accepts', async (typed, parsed) => {
    const submissions: string[] = [];
    const ui = renderFeature(reviewComposer(submissions));
    await tick(PAST_GRACE);
    await flushEffects();

    ui.stdin.write(typed);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual([typed]);
    expect(parseReviewCommand(submissions[0] ?? '')).toEqual(parsed);
    ui.unmount();
  });
});
