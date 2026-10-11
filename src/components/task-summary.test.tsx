import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import chalk from 'chalk';
import { defaultTheme } from './theme.js';
import { paint } from '../core/theme/paint.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { TaskSummary, fitDetailRun as fitDetailSpans } from './task-summary.js';
import { glyph } from '../lib/glyphs.js';
import { getTerminalCellWidth } from '../utils/display-text.js';
import { getMethodDisplay } from '../core/sessions/display.js';
import { taskTargetParts } from '../stores/workflow/tasks.js';
import { stageSummaryRow } from '../features/workflow/components/conversation-flow/stage-summary.js';

const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

const jwt =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const originalColorLevel = chalk.level;

afterEach(() => {
  chalk.level = originalColorLevel;
});

function expectForeground(frame: string, text: string, color: string | undefined): void {
  const [opening] = paint(color, '\0').split('\0');
  if (opening === undefined || opening === '') throw new Error(`No foreground for ${color}`);
  expect(frame).toContain(`${opening}${text}`);
}

function fitDetailRun(
  task: Parameters<typeof fitDetailSpans>[0],
  tail: string[],
  width: number,
  settled?: boolean,
) {
  const fitted = fitDetailSpans(
    task,
    tail.map((text) => ({ text, tone: 'textDim' })),
    width,
    settled,
  );
  return { head: fitted.head, tail: fitted.tail.map((span) => span.text) };
}

beforeEach(forceUnicodeGlyphs);

describe('TaskSummary', () => {
  it('accepts one heading source for a stage', () => {
    type StageProps = ReturnType<typeof stageSummaryRow> & { width: number };
    expectTypeOf<StageProps>().toExtend<Parameters<typeof TaskSummary>[0]>();
    expectTypeOf<StageProps & { id: string; title: string }>().not.toExtend<
      Parameters<typeof TaskSummary>[0]
    >();
  });
  it('keeps the heading ellipsis when a Review label fills the available cells', () => {
    chalk.level = 3;
    const ui = renderFeature(
      <TaskSummary
        width={9}
        state={{
          kind: 'stage',
          headingParts: {
            id: [
              { text: 'Review', tone: 'reviewer' },
              { text: ' T001', tone: 'textDim' },
            ],
            title: { text: 'no verdict', tone: 'error' },
          },
          outcome: 'no-verdict',
          detail: [],
        }}
      />,
      { cols: 9, rows: 18 },
    );
    const frame = ui.lastFrame();
    expect(stripAnsiStyles(frame).trim()).toBe('✗ Revie…');
    expectForeground(frame, 'Revie…', defaultTheme.reviewer);
    ui.unmount();
  });

  it.each([
    ['no-verdict', 'no verdict', '✗'],
    ['stopped', 'stopped', '×'],
  ] as const)('keeps the %s stage marker and duration at 60 columns', (outcome, title, mark) => {
    const ui = renderFeature(
      <TaskSummary
        width={60}
        state={{
          kind: 'stage',
          headingParts: {
            id: [
              { text: 'Review', tone: 'reviewer' },
              { text: ' T001', tone: 'textDim' },
            ],
            title: { text: title, tone: outcome === 'stopped' ? 'warning' : 'error' },
          },
          outcome,
          detail: ['49.0s'],
        }}
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
      expect(frame).not.toContain(getMethodDisplay('local', defaultTheme).text);
    } else if (width >= 60) {
      expect(frame).toBe(
        ` ${glyph('stageDone')} T001 Add the book catalogue schema  passed · 5.0s`,
      );
    }
    ui.unmount();
  });

  it('drops target annotations before shortening the path', () => {
    const target = taskTargetParts({
      file: 'testing/visual/fixtures/workflow/registry.ts',
      files: ['registry.ts', 'a.ts', 'b.ts', 'c.ts'],
      action: 'modify',
    });
    const method = getMethodDisplay('local', defaultTheme).text;
    const head = 'T002 Register fixtures';
    const exactPathWidth = getTerminalCellWidth(` ✓ ${head}  ${target.path} · ${method} · 2m 0s`);
    for (const width of [60, exactPathWidth, 120]) {
      const ui = renderFeature(
        <TaskSummary
          width={width}
          id="T002"
          title="Register fixtures"
          state={{ kind: 'settled', method: 'local' }}
          file={target.path}
          fileNote={target.note}
          extraFiles={target.extraFiles}
          duration={120_000}
        />,
        { cols: width, rows: 18 },
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain(`${method} · 2m 0s`);
      expect(frame).toContain(width === 60 ? '…/registry.ts' : target.path);
      if (width === 120) expect(frame).toContain(`${target.path} (modify) · +3 files`);
      else expect(frame).not.toContain(target.note);
      expect(getTerminalCellWidth(frame)).toBeLessThanOrEqual(width);
      ui.unmount();
    }
  });

  it('keeps the extra file count in its own token when the target has no action', () => {
    const target = taskTargetParts({ file: 'src/a.ts', files: ['src/a.ts', 'src/b.ts'] });
    const ui = renderFeature(
      <TaskSummary
        width={80}
        id="T001"
        title="Update report"
        state={{ kind: 'settled', method: 'local' }}
        file={target.path}
        fileNote={target.note}
        extraFiles={target.extraFiles}
      />,
      { cols: 80, rows: 18 },
    );
    expect(stripAnsiStyles(ui.lastFrame())).toContain('src/a.ts · +1 file · passed');
    ui.unmount();
  });

  it.each([1, 2])('drops a skipped reason that has no character within %s cells', (room) => {
    const task = { id: 'T002', title: 'Receive stock' };
    const head = `${task.id} ${task.title}`;
    const width = getTerminalCellWidth(` ✓ ${head}  skipped · `) + room;
    expect(fitDetailRun(task, ['skipped', '作業を続けられません'], width, true)).toEqual({
      head,
      tail: ['skipped'],
    });
  });

  it('keeps a skipped reason with one character and its ellipsis', () => {
    const task = { id: 'T002', title: 'Receive stock' };
    const head = `${task.id} ${task.title}`;
    const width = getTerminalCellWidth(` ✓ ${head}  skipped · `) + 2;
    expect(fitDetailRun(task, ['skipped', 'Denied by hook'], width, true).tail).toEqual([
      'skipped',
      'D…',
    ]);
  });

  it.each([40, 60])(
    'keeps the skipped brief title ahead of a long reason at %s columns',
    (width) => {
      chalk.level = 3;
      const ui = renderFeature(
        <TaskSummary
          width={width}
          id="T002"
          title="Receive stock"
          state={{ kind: 'settled', method: 'skipped' }}
          file="src/orders.js"
          fileNote="(modify)"
          reason="The worker cannot continue because the selected account has reached its usage limit"
        />,
        { cols: width, rows: 18 },
      );
      const rawFrame = ui.lastFrame();
      const frame = stripAnsiStyles(rawFrame);
      expect(frame).toContain('T002 Receive stock');
      expect(frame).toContain('skipped');
      expect(getTerminalCellWidth(frame)).toBeLessThanOrEqual(width);
      expect(rawFrame).toBe(paint(defaultTheme.textDim, frame));
      ui.unmount();
    },
  );

  it.each([false, true])('keeps the skipped mark and word dim when focused=%s', (focused) => {
    chalk.level = 3;
    const ui = renderFeature(
      <TaskSummary
        width={100}
        id="T002"
        title="Receive stock"
        state={{ kind: 'settled', method: 'skipped' }}
        file="src/orders.js"
        reason="Denied by hook"
        focused={focused}
      />,
    );
    const frame = ui.lastFrame();
    expect(frame).toContain(
      paint(
        defaultTheme.textDim,
        `${focused ? '' : ' '}${glyph('statusSkipped')} T002 Receive stock  src/orders.js · skipped · Denied by hook`,
      ),
    );
    ui.unmount();
  });

  it.each([5, 6, 8])('keeps a cut stage word in its seat tone at %s columns', (width) => {
    chalk.level = 3;
    const ui = renderFeature(
      <TaskSummary
        state={{
          kind: 'stage',
          headingParts: {
            id: [{ text: 'Plan', tone: 'planner' }],
            title: { text: 'Long feature title', tone: 'text' },
          },
          outcome: 'passed',
          detail: [],
        }}
        width={width}
      />,
      { cols: width, rows: 18 },
    );
    const head = width === 5 ? 'P…' : width === 6 ? 'Pl…' : 'Plan';
    expectForeground(ui.lastFrame(), head, defaultTheme.planner);
    expect(getTerminalCellWidth(stripAnsiStyles(ui.lastFrame()))).toBeLessThanOrEqual(width);
    ui.unmount();
  });

  it.each([
    ['cancelled', 'stopped', 'warning'],
    ['cancelled', 'cancelled', 'warning'],
    ['failed', 'failed', 'error'],
  ] as const)('keeps halted %s %s colored after fitting', (tone, word, token) => {
    chalk.level = 3;
    for (const width of [16, 60, 120]) {
      const ui = renderFeature(
        <TaskSummary
          id="T1"
          title=""
          state={{ kind: 'halted', tone, word }}
          width={width}
          file={width > 16 ? 'src/a.ts' : undefined}
          note="2 partial files"
        />,
      );
      const frame = ui.lastFrame();
      expectForeground(frame, word, defaultTheme[token]);
      expectForeground(
        frame,
        ` ${glyph(tone === 'failed' ? 'statusFailed' : 'statusCancelled')} `,
        defaultTheme[token],
      );
      if (width > 16) {
        expectForeground(frame, ' · 2 partial files', defaultTheme.textDim);
      }
      expect(getTerminalCellWidth(stripAnsiStyles(frame))).toBeLessThanOrEqual(width);
      ui.unmount();
    }
  });
  it.each([false, true])(
    'colors the settled review seat and failed=%s state separately',
    (failed) => {
      chalk.level = 3;
      const summary = stageSummaryRow({
        stage: 'review',
        scope: 'final',
        ordinal: 1,
        outcome: failed ? 'failed' : 'passed',
        failedCommands: [],
        failedChecks: 0,
        fixes: [],
        duration: 1_000,
      });
      const ui = renderFeature(<TaskSummary {...summary} width={120} />);
      const frame = ui.lastFrame();
      expectForeground(frame, 'Review', defaultTheme.reviewer);
      expectForeground(
        frame,
        failed ? ' failed' : 'passed',
        failed ? defaultTheme.error : defaultTheme.success,
      );
      expect(frame).toContain('1.0s');
      ui.unmount();
    },
  );

  it.each([
    [20, '✗ Review T001 fail…', ' fail…'],
    [60, '✗ Review T001 failed  1.0s', ' failed'],
  ] as const)('keeps the failed task review heading at %s columns', (width, expected, suffix) => {
    chalk.level = 3;
    const summary = stageSummaryRow({
      stage: 'review',
      scope: 'task',
      afterTaskId: 'T001',
      ordinal: 1,
      outcome: 'failed',
      failedCommands: [],
      failedChecks: 0,
      fixes: [],
      duration: 1_000,
    });
    const ui = renderFeature(<TaskSummary {...summary} width={width} />, { cols: width, rows: 18 });
    const frame = ui.lastFrame();
    expect(stripAnsiStyles(frame).trim()).toBe(expected);
    expectForeground(frame, 'Review', defaultTheme.reviewer);
    expectForeground(frame, ' T001', defaultTheme.textDim);
    expectForeground(frame, suffix, defaultTheme.error);
    if (width === 60) expectForeground(frame, '  1.0s', defaultTheme.textDim);
    ui.unmount();
  });

  it('colors the settled Plan label with planner and its title with text', () => {
    chalk.level = 3;
    const summary = stageSummaryRow({ stage: 'plan', feature: 'Fix the tests', duration: 1_000 });
    const ui = renderFeature(<TaskSummary {...summary} width={120} />);
    expectForeground(ui.lastFrame(), 'Plan', defaultTheme.planner);
    expectForeground(ui.lastFrame(), ' Fix the tests', defaultTheme.text);
    ui.unmount();
  });
  it('paints a settled stage mark, head and sanitized detail run', () => {
    for (const failed of [false, true]) {
      const ui = renderFeature(
        <TaskSummary
          width={80}
          state={{
            kind: 'stage',
            outcome: failed ? 'failed' : 'passed',
            headingParts: {
              id: [
                { text: 'Review', tone: 'reviewer' },
                { text: ' 1', tone: 'textDim' },
              ],
              title: failed ? null : { text: 'passed', tone: 'success' },
            },
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
      {
        kind: 'stage',
        headingParts: {
          id: [
            { text: 'Review', tone: 'reviewer' },
            { text: ' 1', tone: 'textDim' },
          ],
          title: null,
        },
        outcome: 'failed',
        detail: ['fixes T904', '8.0s'],
      },
    ] as const) {
      const row = state.kind === 'stage' ? { state } : { state, id: 'Review 1', title: '' };
      const ui = renderFeature(<TaskSummary width={80} {...row} />);
      const frame = ui.lastFrame() ?? '';

      expectForeground(
        frame,
        state.kind === 'stage' ? 'Review' : 'Review 1',
        state.kind === 'stage' ? defaultTheme.reviewer : defaultTheme.text,
      );
      expectForeground(frame, ' failed', defaultTheme.error);
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

  it.each(['failed', 'skipped'] as const)(
    'keeps the file on a %s heading at narrow widths',
    (method) => {
      const ui = renderFeature(
        <TaskSummary
          width={60}
          id="T2"
          title="Receive stock"
          state={{ kind: 'settled', method }}
          file="src/orders/receiving/deliveries/orders.js"
          reason={method === 'skipped' ? 'Denied by hook' : undefined}
        />,
      );
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame).toContain('orders.js');
      expect(frame).toContain(method);
      expect(frame.split('\n')).toHaveLength(1);
      ui.unmount();
    },
  );

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
    expect(frame).toContain(paint(defaultTheme.error, ' failed'));
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
