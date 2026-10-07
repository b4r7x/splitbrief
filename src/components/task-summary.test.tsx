import { afterEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { defaultTheme } from './theme.js';
import { paint } from '../core/theme/paint.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { TaskSummary } from './task-summary.js';
import { glyph } from '../lib/glyphs.js';

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const originalColorLevel = chalk.level;

afterEach(() => {
  chalk.level = originalColorLevel;
});

describe('TaskSummary', () => {
  it('paints a settled stage mark, head and sanitized detail run', () => {
    for (const failed of [false, true]) {
      const ui = renderFeature(
        <TaskSummary
          width={80}
          id="Review 1"
          title={failed ? '' : 'passed'}
          state={{
            kind: 'stage',
            failed,
            detail: ['fixes \u001b[31mT006\u001b[0m', '8.0s'],
          }}
        />,
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');

      expect(frame).toContain(
        `${glyph(failed ? 'statusFailed' : 'check')} Review 1 ${failed ? 'failed' : 'passed'}`,
      );
      expect(frame).toContain('fixes T006 · 8.0s');
      expect(frame).not.toContain('\u001b');

      ui.unmount();
    }
  });

  it('paints a failed review head and suffix with the failed brief treatment', () => {
    chalk.level = 3;
    for (const state of [
      { kind: 'settled', method: 'failed' },
      { kind: 'stage', failed: true, detail: ['fixes T904', '8.0s'] },
    ] as const) {
      const ui = renderFeature(<TaskSummary width={80} id="Review 1" title="" state={state} />);
      const frame = ui.lastFrame() ?? '';

      const [headColor] = paint(defaultTheme.textDim, '\0').split('\0');
      const [failedColor] = paint(defaultTheme.dimError, '\0').split('\0');
      expect(frame).toContain(`${headColor}Review 1${failedColor} failed`);
      expect(stripAnsiStyles(frame)).toContain('Review 1 failed');
      expect(stripAnsiStyles(frame).match(/failed/gu)).toHaveLength(1);
      if (state.kind === 'stage') expect(stripAnsiStyles(frame)).toContain('fixes T904 · 8.0s');

      ui.unmount();
    }
  });

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
    chalk.level = 3;
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
    expect(frame).toContain(paint(defaultTheme.dimError, ' failed'));
    expect(frame).toContain(glyph('statusFailed'));

    ui.unmount();
  });

  it('opens with the transcript one-cell lead so the mark lands on column 1', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T1"
        title="hash passwords"
        state={{ kind: 'settled', method: 'local' }}
      />,
    );
    const line =
      stripAnsiStyles(ui.lastFrame() ?? '')
        .split('\n')
        .find((candidate) => candidate.includes('T1 hash passwords')) ?? '';

    expect(line.startsWith(` ${glyph('check')} `)).toBe(true);
    expect(line[1]).toBe(glyph('check'));

    ui.unmount();
  });

  it('paints the focus bar into the lead cell and keeps the mark on the line', () => {
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T3"
        title="wire login route"
        state={{ kind: 'settled', method: 'failed' }}
        focused={true}
      />,
    );
    const line =
      stripAnsiStyles(ui.lastFrame() ?? '')
        .split('\n')
        .find((candidate) => candidate.includes('T3 wire login route')) ?? '';

    // The same shape a focused transcript row wears: the bar where the lead was, the mark on
    // column 1, the title on column 3.
    expect(line.startsWith(`${glyph('liveBar')}${glyph('statusFailed')} T3 wire login route`)).toBe(
      true,
    );

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
