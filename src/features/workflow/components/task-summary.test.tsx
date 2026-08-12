import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { TaskSummary } from './task-summary.js';
import { glyph } from '../../../lib/glyphs.js';

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('TaskSummary', () => {
  it('sanitizes completed task title and file text', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        index={1}
        title={`apply \u001b[31mred\u001b[0m ${jwt}`}
        method="local"
        file="token=sk-abcdefghijklmnopqrstuvwxyz"
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('T1 apply red ***REDACTED***');
    expect(frame).toContain('token=sk-***REDACTED***');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('sanitizes skipped reasons', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        index={2}
        title="skip task"
        method="skipped"
        reason={`blocked by ${jwt} and \u001b[7mcontrol\u001b[0m`}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('blocked by ***REDACTED*** and control');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('renders a failed summary with no ✗ glyph and a single failed word', () => {
    const ui = renderFeature(
      <TaskSummary width={100} index={3} title="wire login route" method="failed" />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('T3 wire login route');
    expect(frame).toContain('failed');
    expect(frame).not.toContain('✗');

    ui.unmount();
  });

  it('keeps the focused accent bar adjacent to the row title without an extra gutter', () => {
    const ui = renderFeature(
      <TaskSummary width={100} index={3} title="wire login route" method="failed" focused={true} />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    const focus = glyph('liveBar');
    expect(frame).toContain(`${focus} T3 wire login route`);
    expect(frame).not.toContain(`${focus}   T3`);

    ui.unmount();
  });

  it('wears the ▌ accent bar when focused', () => {
    const focused = renderFeature(
      <TaskSummary width={100} index={1} title="hash passwords" method="local" focused={true} />,
    );
    const focusedFrame = focused.lastFrame() ?? '';
    expect(focusedFrame).toContain(glyph('liveBar'));
    expect(focusedFrame).toContain('T1 hash passwords');
    focused.unmount();

    const unfocused = renderFeature(
      <TaskSummary width={100} index={1} title="hash passwords" method="local" />,
    );
    expect(unfocused.lastFrame() ?? '').not.toContain(glyph('liveBar'));
    unfocused.unmount();
  });

  it('joins a completed summary file and meta with a soft separator', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        index={1}
        title="add session schema"
        method="local"
        file="src/auth/session.ts"
        duration={48000}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain(glyph('check'));
    expect(frame).toContain('src/auth/session.ts');
    expect(frame).toContain('·');

    ui.unmount();
  });
});
