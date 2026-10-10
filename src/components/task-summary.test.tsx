import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { defaultTheme } from './theme.js';
import { paint } from '../core/theme/paint.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { TaskSummary, fitDetailRun } from './task-summary.js';
import { glyph } from '../lib/glyphs.js';
import { getTerminalCellWidth } from '../utils/display-text.js';

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const originalColorLevel = chalk.level;

afterEach(() => {
  chalk.level = originalColorLevel;
});

beforeEach(forceUnicodeGlyphs);

describe('TaskSummary', () => {
  it.each([
    ['no-verdict', 'no verdict', '✗'],
    ['stopped', 'stopped', '×'],
  ] as const)('keeps the %s stage marker and duration at 60 columns', (outcome, title, mark) => {
    const ui = renderFeature(
      <TaskSummary
        width={60}
        id="Review T001"
        title={title}
        state={{ kind: 'stage', outcome, detail: ['49.0s'] }}
      />,
      { cols: 60, rows: 18 },
    );
    expect(stripAnsiStyles(ui.lastFrame()).trim()).toBe(`${mark} Review T001 ${title}  49.0s`);
    ui.unmount();
  });

  it.each([18, 22, 60, 80])('keeps the settled brief id whole at %s columns', (width) => {
    const ui = renderFeature(
      <TaskSummary
        width={width}
        id="T001"
        title="Add the book catalogue schema"
        state={{ kind: 'settled', method: 'local' }}
        duration={5000}
      />,
      { cols: width, rows: 18 },
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(`${glyph('stageDone')} T001 `);
    expect(getTerminalCellWidth(frame)).toBeLessThanOrEqual(width);
    if (width === 18) {
      expect(frame).toBe(` ${glyph('stageDone')} T001 Add the b…`);
      expect(frame).not.toContain('local');
    } else if (width >= 60) {
      expect(frame).toBe(
        ` ${glyph('stageDone')} T001 Add the book catalogue schema  passed · 5.0s`,
      );
    }
    ui.unmount();
  });

  it('paints a settled stage mark, head and sanitized detail run', () => {
    for (const failed of [false, true]) {
      const ui = renderFeature(
        <TaskSummary
          width={80}
          id="Review 1"
          title={failed ? '' : 'passed'}
          state={{
            kind: 'stage',
            outcome: failed ? 'failed' : 'passed',
            detail: ['fixes \u001b[31mT006\u001b[0m', '8.0s'],
          }}
        />,
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');

      expect(frame).toContain(
        `${glyph(failed ? 'statusFailed' : 'stageDone')} Review 1 ${failed ? 'failed' : 'passed'}`,
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
      { kind: 'stage', outcome: 'failed', detail: ['fixes T904', '8.0s'] },
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

    expect(line.startsWith(` ${glyph('stageDone')} `)).toBe(true);
    expect(line[1]).toBe(glyph('stageDone'));

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

  it('marks an escalated brief with the sidebar ▲, never the success mark', () => {
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
      expect(frame).not.toContain(glyph('stageDone'));

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

    expect(frame).toContain(glyph('stageDone'));
    expect(stripAnsiStyles(frame)).toContain('src/auth/session.ts · passed · 48.0s');

    ui.unmount();
  });

  it('keeps method and duration at 60, 80 and 120 widths while keeping first directory and file name', () => {
    const head = 'T1';
    const longPath =
      'src/engine/subsystems/workflow/coordinator/deeply/nested/components/tasks/resume.ts';
    for (const width of [60, 80, 120]) {
      const fitted = fitDetailRun({ id: head, title: '' }, [longPath, 'passed', '48.0s'], width);
      expect(fitted.tail).toContain('passed');
      expect(fitted.tail).toContain('48.0s');
      expect(fitted.tail[0]?.startsWith('src/')).toBe(true);
      expect(fitted.tail[0]?.endsWith('resume.ts')).toBe(true);
    }
  });

  it('drops retries before shortening file segment', () => {
    const fitted = fitDetailRun(
      { id: 'T1', title: '' },
      ['src/auth/session.ts', 'passed', '2 retries', '48.0s'],
      45,
    );
    expect(fitted.tail).toContain('passed');
    expect(fitted.tail).toContain('48.0s');
    expect(fitted.tail).not.toContain('2 retries');
  });

  it.each([60, 80, 120])(
    'elides whole directories at %s columns with and without retries',
    (width) => {
      const file = 'testing/visual/fixtures/workflow/checkpoints/deeply/nested/projections.ts';
      const expected =
        width === 60
          ? 'testing/…/nested/projections.ts'
          : width === 80
            ? 'testing/…/checkpoints/deeply/nested/projections.ts'
            : file;
      for (const retries of [[], ['1 retry'], ['2 retries']]) {
        for (const settled of [undefined, true]) {
          const fitted = fitDetailRun(
            { id: 'T1', title: '' },
            [file, 'passed', ...retries, '2m 0s'],
            width,
            settled,
          );
          expect(fitted.tail).toEqual([
            expected,
            'passed',
            ...(width === 120 ? retries : []),
            '2m 0s',
          ]);
          expect(
            getTerminalCellWidth(` ● ${fitted.head}  ${fitted.tail.join(' · ')}`),
          ).toBeLessThanOrEqual(width);
        }
      }
    },
  );

  it('gives up the first directory and then the path marker before cutting a file name', () => {
    const file = 'testing/visual/fixtures/workflow/projections.ts';
    for (const width of [60, 80, 120]) {
      for (const [room, expected] of [
        [24, 'testing/…/projections.ts'],
        [16, '…/projections.ts'],
        [14, 'projections.ts'],
        [8, 'pro…s.ts'],
      ] as const) {
        const head = 'T1'.padEnd(width - 22 - room, 'x');
        const fitted = fitDetailRun(
          { id: head, title: '' },
          [file, 'passed', '1 retry', '2m 0s'],
          width,
          true,
        );
        expect(fitted.tail).toEqual([expected, 'passed', '2m 0s']);
      }
    }
  });

  it('uses the settled retry priority for the closed signup row', () => {
    const fitted = fitDetailRun(
      { id: 'T002', title: 'Wire validator into the signup form' },
      ['src/components/signup/form.ts', 'passed', '1 retry', '2m 21s'],
      80,
      true,
    );
    expect(fitted.tail).toEqual(['src/…/form.ts', 'passed', '2m 21s']);
  });

  it('cuts title last when room runs out completely', () => {
    const fitted = fitDetailRun(
      { id: 'T1', title: 'long task title that exceeds the budget' },
      ['src/auth/session.ts', 'passed', '48.0s'],
      26,
    );
    expect(fitted.tail).toEqual(['passed', '48.0s']);
    expect(fitted.head.endsWith('…')).toBe(true);
  });

  it('renders settled task summary keeping method and duration at narrow width', () => {
    const ui = renderFeature(
      <TaskSummary
        width={60}
        id="T1"
        title="hash passwords"
        state={{ kind: 'settled', method: 'local' }}
        file="src/engine/subsystems/workflow/coordinator/resume.ts"
        duration={48000}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('passed');
    expect(frame).toContain('48.0s');
    expect(frame).toContain('src/');
    expect(frame).toContain('resume.ts');

    ui.unmount();
  });
});
