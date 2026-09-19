import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { openApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { REVIEW_HINT } from '../review-commands.js';
import { FeedbackRow, RUNNING_LEGEND } from './feedback-row.js';

describe('FeedbackRow', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('renders flush, leaving the gutter to the footer that wraps it', () => {
    feedbackStore.setMessage('Message queued for the next planner turn.');

    const ui = renderFeature(<FeedbackRow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // The row is bare text: the footer's gutter puts it on column 1, and the mark slot it insets
    // itself by carries it the rest of the way to the text column.
    expect(frame.indexOf('Message queued')).toBe(0);

    ui.unmount();
  });

  it('says nothing while a gate panel owns the legend', () => {
    controlsStore.setInputMode('review');

    const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '').trim()).toBe('');

    ui.unmount();
  });

  it('says nothing while a tiered approval is pending', () => {
    void openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/x.ts',
      phase: 'implementing',
    });

    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '').trim()).toBe('');

    ui.unmount();
  });

  it('names the keys a running build answers to when nothing else owns the row', () => {
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });

    const ui = renderFeature(<FeedbackRow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('esc stop options');
    expect(frame).toContain(RUNNING_LEGEND);

    ui.unmount();
  });

  it('keeps review hints visible even while the composer is focused', () => {
    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('approve · ctrl+e/e edit');

    ui.unmount();
  });

  it('leads a failed connection hint with the error word and a dim cause', () => {
    const ui = renderFeature(
      <FeedbackRow inputHint="Failed server connection lost — ctrl+d to exit, retry with resume" />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Failed');
    expect(frame).toContain('server connection lost — ctrl+d to exit, retry with resume');

    ui.unmount();
  });

  it('renders blank when the input hint is empty so the placeholder owns the hint', () => {
    const ui = renderFeature(<FeedbackRow inputHint="" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame.trim()).toBe('');
    expect(frame).not.toContain('queue a message');

    ui.unmount();
  });

  it('renders the reconnecting connection hint as a single warning state word line', () => {
    const ui = renderFeature(<FeedbackRow inputHint="Reconnecting to server…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Reconnecting to server…');

    ui.unmount();
  });

  it('renders an error as a leading state word plus a dim cause', () => {
    feedbackStore.setError('Failed planner timed out — press r to retry');

    const ui = renderFeature(<FeedbackRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Failed');
    expect(frame).toContain('planner timed out — press r to retry');

    ui.unmount();
  });

  it('summarizes and sanitizes multiline prompt hints', () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    const ui = renderFeature(
      <FeedbackRow
        inputHint={[
          `Task review: token=${rawToken}\u001b]52;c;clipboard\u0007`,
          'Commands: continue, abort',
        ].join('\n')}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Task review: token=***REDACTED***');
    expect(frame).not.toContain('Commands: continue');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('lets live feedback own the row instead of gluing the hint after it', () => {
    feedbackStore.setMessage('Message queued for the next planner turn.');

    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Message queued for the next planner turn.');
    expect(frame).not.toContain('approve · ctrl+e/e edit');

    ui.unmount();
  });

  it('never renders an editor failure run-on with the review key legend', () => {
    feedbackStore.setError('Failed to open editor (vi): spawn vi ENOENT');

    const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Failed to open editor (vi): spawn vi ENOENT');
    expect(frame).not.toContain('y approve');

    ui.unmount();
  });

  it('restores the review key legend once the feedback clears', () => {
    feedbackStore.setError('Failed to open editor (vi): spawn vi ENOENT');
    feedbackStore.setError(null);

    const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('y approve');
    expect(frame).not.toContain('Failed to open editor');

    ui.unmount();
  });
});
