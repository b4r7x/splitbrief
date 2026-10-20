import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { recoveryPromptSummaryRows } from '../recovery-prompt.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { render } from 'ink-testing-library';
import { renderFeature } from '#testing/helpers/ink.js';
import { PromptBody } from './prompt-body.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';

const RECOVERY_PROMPT = [
  'recovery needed · validation failed after 2 attempts',
  '',
  'task t3 · add session middleware',
  'files src/auth/session.ts',
  '',
  '▌ [space]  pause · no new brief starts, changes kept',
  '[r] retry same worker',
  '[b] route to bigger worker · claude-sonnet',
  '[a] abort',
].join('\n');

const originalColorLevel = chalk.level;

const CONFLICT_PROMPT = [
  'recovery needed · your edits conflict with t4',
  '',
  'task t4 · wire login route',
  '',
  '▌ [p] ask planner to rebase on your edits',
  '(approve / edit / reject the proposal)',
  '[r] retry same worker',
].join('\n');

const REVIEW_PROMPT = [
  '✓ t3 ready for review · add session middleware',
  '',
  'status passed',
  'checks 3/3 green',
  '',
  '▌ [c] continue',
  '[a] abort',
].join('\n');

const FAILED_REVIEW_PROMPT = [
  't3 failed review · add session middleware',
  '',
  'status failed',
  'checks 1/3 green',
  '',
  '▌ [r] redo task',
  '[a] abort',
].join('\n');

describe('PromptBody', () => {
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    chalk.level = originalColorLevel;
  });

  it('paints the dim key column and marks the recommended row with words, without a bar', () => {
    const ui = render(<PromptBody prompt={RECOVERY_PROMPT} height={20} width={60} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const pauseRow = frame.split('\n').find((line) => line.includes('pause'));

    expect(frame).not.toContain('▌');
    expect(pauseRow).toBe('  space   pause recommended');
    expect(pauseRow).not.toContain('…');
    expect(frame).toContain('  r       retry same worker');
    expect(frame).toContain('  a       abort');
  });

  it('renders the rebase tail as a separate indented continuation line', () => {
    const ui = render(<PromptBody prompt={CONFLICT_PROMPT} height={20} width={70} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('p   ask planner to rebase on your edits');
    expect(frame).toContain('      (approve / edit / reject the proposal)');
  });

  it('keeps the passing review headline with its ✓ marker', () => {
    const ui = render(<PromptBody prompt={REVIEW_PROMPT} height={20} width={70} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('✓ t3 ready for review · add session middleware');
    expect(frame).toContain('c   continue recommended');
  });

  it('keeps the failed review headline word and cause readable', () => {
    chalk.level = 3;
    const ui = render(<PromptBody prompt={FAILED_REVIEW_PROMPT} height={20} width={70} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('t3 failed review · add session middleware');
    expect(ui.lastFrame()).toContain(paint(defaultTheme.error, 'failed').replace('\u001b[39m', ''));
    expect(frame).toContain('r   redo task recommended');
  });

  // The panel is sized from countPromptBodyRows, so a row that paints taller than the model
  // measured costs a row above it: at 76 columns the recommended tail used to wrap onto its own
  // line and the headline lost its first cell, at 56 it lost the whole row.
  it('paints exactly the rows the model measured, headline first, at every width', () => {
    for (const width of [116, 76, 56, 32]) {
      for (const height of [countPromptBodyRows(RECOVERY_PROMPT, width), 6]) {
        const ui = render(<PromptBody prompt={RECOVERY_PROMPT} height={height} width={width} />);
        const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

        expect(lines).toHaveLength(height);
        expect(lines[0]).toContain('recovery needed');
        expect(lines.filter((line) => line.includes('recommended'))).toHaveLength(1);

        ui.unmount();
      }
    }
  });

  it('renders nothing when height is non-positive', () => {
    const ui = render(<PromptBody prompt={RECOVERY_PROMPT} height={0} width={70} />);
    expect(ui.lastFrame() ?? '').toBe('');
  });
  it.each([
    ['validation-failed', 'Needs you'],
    ['seat-protocol-error', 'Seat down'],
  ] as const)('colors the %s halt and keeps its explanation in the prose tone', (reason, label) => {
    chalk.level = 3;
    const prompt = recoveryPromptSummaryRows(
      makeRecoveryIssue({
        reason,
        seat: 'review',
        message: 'REVIEW answer needs repair',
        attempts: undefined,
      }),
      100,
    );
    const ui = render(<PromptBody prompt={prompt} height={20} width={100} />);
    expect(ui.lastFrame()).toContain(paint(defaultTheme.warning, label).replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(paint(defaultTheme.text, 'REVIEW').replace('\u001b[39m', ''));
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.text, 'REVIEW answer needs repair').replace('\u001b[39m', ''),
    );
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      `${label} · REVIEW answer needs repair`,
    );
    ui.unmount();
  });

  it('keeps recovery span and fact colors when empty detail lines are removed', () => {
    chalk.level = 3;
    const prompt = recoveryPromptSummaryRows(
      makeRecoveryIssue({
        reason: 'seat-protocol-error',
        seat: 'review',
        message: 'Provider refused request',
        attempts: undefined,
        taskId: undefined,
        taskTitle: undefined,
        files: [],
        affectedTaskIds: [],
        details: ['First\n\nsecond'],
      }),
      76,
    );
    const ui = render(
      <PromptBody prompt={prompt} height={countPromptBodyRows(prompt, 76)} width={76} />,
    );
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(paint(defaultTheme.warning, 'Seat down').replace('\u001b[39m', ''));
    expect(frame).toContain(
      paint(defaultTheme.text, 'Provider refused request').replace('\u001b[39m', ''),
    );
    for (const fact of ['  First', '  second']) {
      expect(frame).toContain(paint(defaultTheme.textDim, fact).replace('\u001b[39m', ''));
    }
    expect(stripAnsiStyles(frame)).toContain('  First\n  second');
    ui.unmount();
  });

  it.each(['dark', 'light'] as const)(
    'keeps recovery rows and span colors for a detail ending in a terminal reset in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const prompt = recoveryPromptSummaryRows(
        makeRecoveryIssue({
          reason: 'seat-protocol-error',
          seat: 'review',
          message: 'Provider refused request',
          attempts: undefined,
          taskId: undefined,
          taskTitle: undefined,
          files: [],
          affectedTaskIds: [],
          details: ['abcdefghijklmnopqr   \u001b[0m'],
        }),
        20,
      );
      const height = countPromptBodyRows(prompt, 20);
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <PromptBody prompt={prompt} height={height} width={20} />
        </ThemeProvider>,
      );
      try {
        const frame = ui.lastFrame();
        expect(height).toBe(4);
        expect(stripAnsiStyles(frame).split('\n')).toEqual([
          'Seat down · Provide…',
          '',
          '  abcdefghijklmnopqr',
          '  ',
        ]);
        expect(frame).toContain(
          paint(theme[stateTone('attention')], 'Seat down').replace('\u001b[39m', ''),
        );
        expect(frame).toContain(paint(theme.textDim, ' · ').replace('\u001b[39m', ''));
        expect(frame).toContain(paint(theme.text, 'Provide').replace('\u001b[39m', ''));
        expect(frame).toContain(
          paint(theme.textDim, '  abcdefghijklmnopqr').replace('\u001b[39m', ''),
        );
      } finally {
        ui.unmount();
      }
    },
  );

  it.each([30, 120])(
    'wraps a fact-free structured headline at width %s with its prose tone',
    (width) => {
      chalk.level = 3;
      const text =
        'REVIEW answer needs repair because the answer did not include any usable evidence from the required checks for this brief';
      const prompt = recoveryPromptSummaryRows(
        makeRecoveryIssue({
          reason: 'seat-protocol-error',
          seat: 'review',
          message: text,
          attempts: undefined,
          taskId: undefined,
          taskTitle: undefined,
          files: [],
          details: [],
          affectedTaskIds: [],
        }),
        width,
      );
      const height = countPromptBodyRows(prompt, width);
      expect(height).toBe(width === 30 ? 5 : 2);
      const ui = render(<PromptBody prompt={prompt} height={height} width={width} />);
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(frame.split('\n')).toEqual(
        width === 30
          ? [
              'Seat down · REVIEW answer ',
              'needs repair because the ',
              'answer did not include any ',
              'usable evidence from the ',
              'required checks for this brief',
            ]
          : [
              'Seat down · REVIEW answer needs repair because the answer did not include any usable evidence from the required checks ',
              'for this brief',
            ],
      );
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme.text, 'REVIEW').replace('\u001b[39m', ''),
      );
      expect(frame).not.toContain('…');
      ui.unmount();
    },
  );

  it('colors a generic primary question with text', () => {
    chalk.level = 3;
    const ui = render(
      <PromptBody prompt="Which behavior should this keep?" height={2} width={70} />,
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.text, 'Which behavior should this keep?').replace('\u001b[39m', ''),
    );
    ui.unmount();
  });

  it('separates headline continuations with one blank row and the fact indent', () => {
    chalk.level = 3;
    const ui = render(
      <PromptBody
        prompt={[
          {
            kind: 'headline',
            tone: 'attention',
            text: 'Review\n\n\nWaiting for evidence',
            parts: [
              { text: 'Review', tone: 'reviewer' },
              { text: '\n\n\nWaiting for evidence', tone: 'textDim' },
            ],
          },
        ]}
        height={3}
        width={30}
      />,
    );
    expect(stripAnsiStyles(ui.lastFrame() ?? '').split('\n')).toEqual([
      'Review',
      '',
      '  Waiting for evidence',
    ]);
    expect(ui.lastFrame()).toContain(paint(defaultTheme.reviewer, 'Review'));
    ui.unmount();
  });
  it('keeps terminal control and secret sanitization for structured recovery rows', () => {
    chalk.level = 3;
    const prompt = recoveryPromptSummaryRows(
      makeRecoveryIssue({
        reason: 'seat-protocol-error',
        seat: 'review',
        message: 'REVIEW \u001b[31mred\u001b[0m sk-abcdefghijklmnopqrstuvwxyz',
        attempts: undefined,
      }),
      100,
    );
    const ui = render(<PromptBody prompt={prompt} height={20} width={100} />);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(
      'Seat down · REVIEW red sk-***REDACTED***',
    );
    expect(ui.lastFrame()).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(ui.lastFrame()).not.toContain('\u001b[31m');
    expect(ui.lastFrame()).toContain(paint(defaultTheme.text, 'REVIEW').replace('\u001b[39m', ''));
    ui.unmount();
  });
});
