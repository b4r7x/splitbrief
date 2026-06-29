import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { abortStore } from '../../../stores/workflow/abort.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
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

    expect(frame.indexOf('Esc again to interrupt')).toBe(WORKFLOW_CONTENT_PADDING_X);

    ui.unmount();
  });

  it('keeps review hints visible even while the composer is focused', () => {
    const ui = renderFeature(<FeedbackRow inputHint="approve | Ctrl+E/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('approve | Ctrl+E/e edit');

    ui.unmount();
  });

  it('shows pending queue state without hiding the active hint', () => {
    lifecycleStore.__testReset({ queueDepth: 1 });

    const ui = renderFeature(<FeedbackRow inputHint="approve | Ctrl+E/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('approve | Ctrl+E/e edit');
    expect(frame).toContain('queued 1');
    expect(frame.indexOf('approve | Ctrl+E/e edit')).toBeLessThan(frame.indexOf('queued 1'));

    ui.unmount();
  });

  it('keeps review commands visible with a compact queue label', () => {
    lifecycleStore.__testReset({ queueDepth: 12 });

    const ui = renderFeature(<FeedbackRow inputHint="approve | Ctrl+E/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('approve | Ctrl+E/e edit');
    expect(frame).toContain('queued 12');
    expect(frame).not.toContain('pending next planner turn');
    expect(frame).not.toContain('queued:');

    ui.unmount();
  });

  it('leads a failed connection hint with the error word and a dim cause', () => {
    const ui = renderFeature(
      <FeedbackRow inputHint="failed server connection lost — Ctrl+D to exit, retry with resume" />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('failed');
    expect(frame).toContain('server connection lost — Ctrl+D to exit, retry with resume');

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
    const ui = renderFeature(<FeedbackRow inputHint="reconnecting to server…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('reconnecting to server…');

    ui.unmount();
  });

  it('renders an error as a leading state word plus a dim cause', () => {
    feedbackStore.setError('failed planner timed out — press r to retry');

    const ui = renderFeature(<FeedbackRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('failed');
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

  it('keeps explicit feedback above queue and hint text', () => {
    lifecycleStore.__testReset({ queueDepth: 1 });
    feedbackStore.setMessage('Message queued for the next planner turn.');

    const ui = renderFeature(<FeedbackRow inputHint="approve | Ctrl+E/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Message queued for the next planner turn.');
    expect(frame).toContain('approve | Ctrl+E/e edit');
    expect(frame).not.toContain('Queued 1 message pending next planner turn.');

    ui.unmount();
  });
});
