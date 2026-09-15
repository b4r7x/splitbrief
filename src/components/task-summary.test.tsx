import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { TaskSummary } from './task-summary.js';
import { glyph } from '../lib/glyphs.js';

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('TaskSummary', () => {
  it('sanitizes completed task title and file text', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T1"
        title={`apply \u001b[31mred\u001b[0m ${jwt}`}
        state={{ kind: 'settled', method: 'local' }}
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
        id="T2"
        title="skip task"
        state={{ kind: 'settled', method: 'skipped' }}
        reason={`blocked by ${jwt} and \u001b[7mcontrol\u001b[0m`}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('blocked by ***REDACTED*** and control');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('paints the ✗ marker and a single failed word', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T3"
        title="wire login route"
        state={{ kind: 'settled', method: 'failed' }}
      />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('T3 wire login route');
    expect(frame).toContain('failed');
    expect(frame).toContain(glyph('statusFailed'));

    ui.unmount();
  });

  it('keeps the focused accent bar adjacent to the row title without an extra gutter', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T3"
        title="wire login route"
        state={{ kind: 'settled', method: 'failed' }}
        focused={true}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    const focus = glyph('liveBar');
    expect(frame).toContain(`${focus} T3 wire login route`);
    expect(frame).not.toContain(`${focus}   T3`);

    ui.unmount();
  });

  it('wears the ▌ accent bar when focused', () => {
    const focused = renderFeature(
      <TaskSummary
        width={100}
        id="T1"
        title="hash passwords"
        state={{ kind: 'settled', method: 'local' }}
        focused={true}
      />,
    );
    const focusedFrame = focused.lastFrame() ?? '';
    expect(focusedFrame).toContain(glyph('liveBar'));
    expect(focusedFrame).toContain('T1 hash passwords');
    focused.unmount();

    const unfocused = renderFeature(
      <TaskSummary
        width={100}
        id="T1"
        title="hash passwords"
        state={{ kind: 'settled', method: 'local' }}
      />,
    );
    expect(unfocused.lastFrame() ?? '').not.toContain(glyph('liveBar'));
    unfocused.unmount();
  });

  it('marks an escalated brief with the sidebar ▲, never the success check', () => {
    for (const method of ['escalated-intermediate', 'escalated-hint', 'escalated-full'] as const) {
      const ui = renderFeature(
        <TaskSummary
          width={100}
          id="T1"
          title="hash passwords"
          state={{ kind: 'settled', method }}
        />,
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');

      expect(frame).toContain(`${glyph('statusEscalated')} T1 hash passwords`);
      expect(frame).not.toContain(glyph('check'));

      ui.unmount();
    }
  });

  it('joins a completed summary file and meta with a soft separator', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T1"
        title="add session schema"
        state={{ kind: 'settled', method: 'local' }}
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
