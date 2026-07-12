import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { abortStore } from '../../../stores/workflow/abort.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { WORKFLOW_CONTENT_PADDING_X } from '../layout/rect.js';
import { resolveAttachFeedbackHint } from '../input-hints.js';
import { FeedbackRow } from './feedback-row.js';

describe('FeedbackRow', () => {
  beforeEach(() => {
    abortStore.clear();
    resetAllStores();
  });

  afterEach(() => {
    abortStore.clear();
    resetAllStores();
  });

  it('aligns armed interrupt feedback with the workflow content inset', () => {
    abortStore.arm('interrupt');

    const ui = renderFeature(<FeedbackRow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.indexOf('esc again to interrupt')).toBe(WORKFLOW_CONTENT_PADDING_X);

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

  it('renders blank when the attached client is connected so the placeholder owns the hint', () => {
    const ui = renderFeature(<FeedbackRow inputHint={resolveAttachFeedbackHint('connected')} />);
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

  it('keeps explicit feedback visible alongside the hint text', () => {
    feedbackStore.setMessage('Message queued for the next planner turn.');

    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Message queued for the next planner turn.');
    expect(frame).toContain('approve · ctrl+e/e edit');

    ui.unmount();
  });
});
