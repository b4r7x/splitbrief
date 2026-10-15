import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Box } from 'ink';
import chalk from 'chalk';
import { ThemeProvider } from '../../../components/theme.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { paint } from '../../../core/theme/paint.js';
import { render } from 'ink-testing-library';
import { renderFeature, tick, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { taskId } from '../../../core/schemas/task.js';
import { glyph } from '../../../lib/glyphs.js';
import {
  formatCollapsedSeatSpansFromIdentities,
  PLANNER_INHERITANCE,
} from '../../../core/crew/identity.js';
import { WORKFLOW_GUTTER_X } from '../layout/chrome-rows.js';
import { getHeaderLayout, Header } from './header.js';

const originalColorLevel = chalk.level;
/** Today's local 17:00: the note the bar shows for a same-day reset is the bare clock, in every timezone the suite runs in. */
const RESET_AT = (() => {
  const at = new Date();
  at.setHours(17, 0, 0, 0);
  return at.getTime();
})();

/** The halt behind the bar's note; the header reads only the seat and the clock beside it. */
const QUOTA_HALT = makeRecoveryIssue({
  reason: 'runner-usage-limit',
  availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
  recommendedAction: 'switch-seat',
  switchSeat: { seat: 'build', candidates: [{ tool: 'opencode' }] },
});

const BUILD_HALT = makeRecoveryIssue({
  reason: 'runner-usage-limit',
  phase: 'implementing',
  seat: 'build',
});

const HALTED_CREW_CONFIG = makeConfig({
  planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
  implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
});

/** Any clock text on a rendered bar. */
function clockText(frame: string | undefined): string | undefined {
  return stripAnsiStyles(frame ?? '').match(/\d+:\d{2}(?::\d{2})?/)?.[0];
}

function resetStores(): void {
  routerStore.reset();
  recoveryNoticeStore.reset();
  terminalSizeStore.reset();
  controlsStore.__testReset();
  approvalPromptStore.__testReset();
  lifecycleStore.reset();
  tasksStore.__testReset();
  tokensStore.__testReset();
  eventsStore.__testReset();
  configStore.__testReset();
}

beforeEach(resetStores);

afterEach(() => {
  chalk.level = originalColorLevel;
  vi.useRealTimers();
  resetStores();
});

describe('Header — layout', () => {
  it('gives the seat line every cell the rail leaves but the gap between them', () => {
    const layout = getHeaderLayout({ cols: 100, railCells: 40 });

    expect(layout.seatRoom).toBe(layout.contentWidth - 40 - 2);
    expect(layout.railWidth).toBe(layout.contentWidth);
  });

  it('shrinks the rail cell to leave room for the seat line', () => {
    const withTail = getHeaderLayout({ cols: 160, railCells: 40, seatCells: 44 });
    const withoutTail = getHeaderLayout({ cols: 160, railCells: 40 });

    expect(withTail.railWidth).toBeLessThan(withoutTail.railWidth);
  });

  it('keeps the rail alone at the narrowest widths', () => {
    const layout = getHeaderLayout({ cols: 22, railCells: 18, seatCells: 10 });

    expect(layout.showSeats).toBe(false);
    expect(layout.railWidth).toBe(layout.contentWidth);
  });

  it('omits the seat line when no seat width is supplied', () => {
    expect(getHeaderLayout({ cols: 120, railCells: 40 }).showSeats).toBe(false);
  });

  it('shows the seat line when the terminal is wide', () => {
    expect(getHeaderLayout({ cols: 160, railCells: 40, seatCells: 44 }).showSeats).toBe(true);
  });

  it('omits the seat line entirely when a wide rail leaves no room', () => {
    expect(getHeaderLayout({ cols: 60, railCells: 50, seatCells: 44 }).showSeats).toBe(false);
  });

  it('keeps the rail its measured width when a long seat line shares the row', () => {
    // The row cannot hand the rail a box narrower than its own measure: a squeezed rail blanks the
    // label its cells were budgeted for, and at 120 columns a 60-cell seat line is the tightest
    // tail that still shows.
    const layout = getHeaderLayout({ cols: 120, railCells: 47, seatCells: 60 });

    expect(layout.showSeats).toBe(true);
    expect(layout.railWidth).toBeGreaterThanOrEqual(47);
  });
});

describe('Header — seat line', () => {
  it.each(['dark', 'light'] as const)(
    'paints each seat and the separators in the %s theme',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      lifecycleStore.__testReset({ status: 'complete' });
      terminalSizeStore.__testReset({ cols: 200, rows: 50, isSmall: false });
      const seatLine = formatCollapsedSeatSpansFromIdentities({
        plan: 'GPT-6-Astra',
        build: 'Gemini 3.8 Flash (High)',
        review: null,
      });
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <Header seatLine={seatLine} />
        </ThemeProvider>,
        { cols: 200, rows: 50 },
      );
      const frame = ui.lastFrame();
      for (const [text, color] of [
        ['PLAN GPT-6-Astra', theme.planner],
        ['BUILD Gemini 3.8 Flash (High)', theme.implementer],
        ['REVIEW = PLAN', theme.reviewer],
        [' · ', theme.textDim],
      ]) {
        expect(frame).toContain(paint(color, text ?? '').replace('\u001b[39m', ''));
      }
      expect(clockText(frame)).toBeUndefined();
      ui.unmount();
    },
  );

  it.each(['dark', 'light'] as const)(
    'keeps reviewer color in the active rail after seat elision in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      lifecycleStore.__testReset({ status: 'running', phase: 'final-review' });
      terminalSizeStore.__testReset({ cols: 200, rows: 50, isSmall: false });
      const seatLine = formatCollapsedSeatSpansFromIdentities({
        plan: 'Astra',
        build: 'Flash',
        review: 'Sol',
        budget: 24,
      });
      expect(seatLine.some((span) => span.seat === 'review')).toBe(false);
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <Header seatLine={seatLine} />
        </ThemeProvider>,
        { cols: 200, rows: 50 },
      );
      const frame = ui.lastFrame();
      expect(frame).toContain(
        paint(theme.reviewer, `${glyph('stageDone')} Review`).replace('\u001b[39m', ''),
      );
      expect(frame.slice(frame.indexOf('PLAN Astra'))).not.toContain(
        paint(theme.reviewer, 'x').split('x')[0],
      );
      ui.unmount();
    },
  );

  const ESC = String.fromCharCode(27);
  const hostileSequence = `${ESC}[2J`;

  async function seatFrame(cols: number, config = makeConfig()): Promise<string> {
    resetStores();
    terminalSizeStore.__testReset({ cols, rows: 24, isSmall: cols < 120 });
    configStore.__testReset({ projectDir: '/tmp/p', config });
    const instance = render(<Header />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');
    instance.unmount();
    return frame;
  }

  it('names all three seats in one collapsed line without a chevron', async () => {
    const frame = await seatFrame(160);

    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');
    expect(frame).toContain('Qwen2.5 Coder 7B');
    expect(frame.slice(frame.indexOf('PLAN'))).not.toContain('›');
  });

  it('gives up one seat name to the tight bar instead of hiding all three', async () => {
    const frame = await seatFrame(110);

    expect(frame).toContain('PLAN');
    expect(frame).toContain('Qwen2.5 Coder 7B');
  });

  it('says the review seat borrows the planner when no reviewer is configured', async () => {
    const frame = await seatFrame(160);

    expect(frame).toContain(PLANNER_INHERITANCE.mark);
  });

  it('names the reviewer seat with its own runner when a reviewer is configured', async () => {
    const frame = await seatFrame(
      200,
      makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } }),
    );

    expect(frame).toContain('REVIEW');
    expect(frame).toContain('GPT-5 Codex');
    expect(frame).not.toContain(PLANNER_INHERITANCE.mark);
  });

  it('sanitizes hostile model ids in the visible seat line', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/p',
      config: makeConfig({ implementer: { model: `qwen${hostileSequence}-coder` } }),
    });

    const instance = render(<Header />);
    await tick();
    const rawFrame = instance.lastFrame() ?? '';

    expect(stripAnsiStyles(rawFrame)).toContain('Qwen Coder');
    expect(rawFrame).not.toContain(hostileSequence);
    instance.unmount();
  });

  it('marks the halted seat with the clock its quota resets on', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    recoveryNoticeStore.open({
      seat: 'build',
      resetAt: RESET_AT,
      issue: QUOTA_HALT,
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });

    const instance = render(<Header />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    expect(frame.indexOf('(resets 17:00)')).toBeGreaterThan(frame.indexOf('BUILD'));
    instance.unmount();
  });

  it('takes the reset clock off the bar once the halt is resolved', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    recoveryNoticeStore.open({
      seat: 'build',
      resetAt: RESET_AT,
      issue: QUOTA_HALT,
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });

    const instance = render(<Header />);
    await tick();
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).toContain('resets 17:00');

    recoveryNoticeStore.clear();
    await tick();
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).not.toContain('resets');
    instance.unmount();
  });

  it('keeps BUILD without a reset or swap offer until the halt clears on a constrained rail', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: HALTED_CREW_CONFIG });
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'running',
      startedAt: Date.now(),
    });
    recoveryNoticeStore.open({
      seat: 'build',
      resetAt: null,
      issue: BUILD_HALT,
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });

    const ui = renderFeature(
      <Box paddingX={WORKFLOW_GUTTER_X}>
        <Header />
      </Box>,
      { cols: 80, rows: 24 },
    );
    await tick();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('BUILD DeepSeek V4.1 Flash via deepseek');
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain('resets');

    recoveryNoticeStore.clear();
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame());
    expect(frame).toContain('PLAN Sonnet 4 · REVIEW = PLAN');
    expect(frame).not.toContain('BUILD');
    ui.unmount();
  });

  it('keeps BUILD for an open halted record at rest with no open notice', async () => {
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: HALTED_CREW_CONFIG });
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'paused',
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
    });
    routerStore.navigate({
      to: 'workflow',
      execution: { kind: 'at-rest' },
      run: makeRunRecord({
        status: {
          kind: 'open',
          stop: { kind: 'waiting-for-you', on: { kind: 'halt', issue: BUILD_HALT } },
          resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 1 },
        },
      }),
    });

    const ui = renderFeature(
      <Box paddingX={WORKFLOW_GUTTER_X}>
        <Header />
      </Box>,
      { cols: 80, rows: 24 },
    );
    await tick();
    expect(stripAnsiStyles(ui.lastFrame())).toContain('BUILD DeepSeek V4.1 Flash via deepseek');
    expect(stripAnsiStyles(ui.lastFrame())).not.toContain('resets');
    ui.unmount();
  });

  it('keeps the halted seat named and spends another seat when the note crowds the bar', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    recoveryNoticeStore.open({
      seat: 'build',
      resetAt: RESET_AT,
      issue: QUOTA_HALT,
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });

    const instance = render(<Header />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('BUILD Qwen2.5 Coder 7B (resets 17:00)');
    instance.unmount();
  });

  it('drops the seat line when the rail crowds the bar', async () => {
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });
    terminalSizeStore.__testReset({ cols: 52, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });

    const instance = render(<Header />);
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('BUILD');
    expect(frame).toContain('Plan');
    instance.unmount();
  });
});

describe('Header — rail', () => {
  it('renders the phase rail in place of any task title', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });

    const instance = render(<Header />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    // The rail's stage labels are present; the verbose phase verb never reaches the header.
    expect(frame).toContain('Plan');
    expect(frame).toContain('Build');
    expect(frame).not.toContain('planning');
    instance.unmount();
  });

  it('paints the first stage label even when the seat line shares the row', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    lifecycleStore.__testReset({
      phase: 'specifying',
      status: 'running',
      startedAt: Date.now(),
    });

    // The library's fixed 100-column stdout would lay the bar out at a width its store never
    // named, so the exact-geometry probe mounts through the viewport-aware harness, inside the
    // gutter the workflow header wraps the row in.
    const ui = renderFeature(
      <Box paddingX={WORKFLOW_GUTTER_X}>
        <Header />
      </Box>,
      { cols: 120, rows: 40 },
    );
    await tick();
    const row = (stripAnsiStyles(ui.lastFrame()).split('\n')[0] ?? '').trimEnd();
    ui.unmount();

    // The active marker opens the rail on the gutter column the hit-test zones use, and its label
    // follows one marker slot in. A budget error blanks `Plan` while keeping its cells.
    expect(row.indexOf(glyph('stageDone'))).toBe(WORKFLOW_GUTTER_X);
    expect(row).toContain(`${glyph('stageDone')} Plan`);
    // The seat line stops short of the right gutter.
    expect(row.length).toBeLessThanOrEqual(120 - WORKFLOW_GUTTER_X);
  });

  it('does not repeat the cancelled status word that the rail already owns', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'researching',
      status: 'cancelled',
      cancelled: true,
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      reason: 'user_cancelled',
    });

    const instance = render(<Header />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('cancelled');
    instance.unmount();
  });

  it('shows no clock for the whole run, running or done', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(65_000);
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });

    const instance = render(<Header />);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushEffects();
    expect(clockText(instance.lastFrame())).toBeUndefined();
    instance.unmount();

    lifecycleStore.__testReset({ phase: 'complete', status: 'complete', startedAt: 0 });
    const done = render(<Header />);
    expect(clockText(done.lastFrame())).toBeUndefined();
    done.unmount();
  });
});
