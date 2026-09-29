import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { renderFeature, tick, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import {
  approvalPromptStore,
  closeApprovalPrompt,
  openApprovalPrompt,
} from '../../../stores/approval-prompt/prompt.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { markWorkflowPaused } from '../../../stores/workflow/actions/pause.js';
import { markWorkflowResumed } from '../../../stores/workflow/actions/resume.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { configStore } from '../../../stores/project/config.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { glyph } from '../../../lib/glyphs.js';
import { PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
import { WORKFLOW_GUTTER_X } from '../layout/chrome-rows.js';
import { getHeaderLayout, Header } from './header.js';

const STARTED_AT = new Date(0).toISOString();
/** Today's local 17:00: the note the bar shows for a same-day reset is the bare clock, in every timezone the suite runs in. */
const RESET_AT = (() => {
  const at = new Date();
  at.setHours(17, 0, 0, 0);
  return at.getTime();
})();

/** The halt behind the bar's note; the header reads only the seat and the clock beside it. */
const QUOTA_HALT = makeRecoveryIssue({
  reason: 'runner-usage-limit',
  availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
  recommendedAction: 'switch-seat',
  switchSeat: { seat: 'build', candidates: [{ tool: 'opencode' }] },
});

/** The clock the bar pins right, read off a rendered frame. */
function clockText(frame: string | undefined): string | undefined {
  return stripAnsiStyles(frame ?? '').match(/\d+:\d{2}(?::\d{2})?/)?.[0];
}

function resetStores(): void {
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
  vi.useRealTimers();
  resetStores();
});

describe('Header — layout', () => {
  it('shows the elapsed tail when there is ample width', () => {
    const layout = getHeaderLayout({ cols: 100, railCells: 40 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.railWidth).toBeLessThanOrEqual(layout.contentWidth);
  });

  it('shrinks the rail cell to leave room for the seat + elapsed tail', () => {
    const withTail = getHeaderLayout({ cols: 160, railCells: 40, seatCells: 44 });
    const withoutTail = getHeaderLayout({ cols: 160, railCells: 40 });

    expect(withTail.railWidth).toBeLessThan(withoutTail.railWidth);
  });

  it('keeps the elapsed clock at narrow widths where the status word would still fit', () => {
    const layout = getHeaderLayout({ cols: 40, railCells: 20 });

    expect(layout.showElapsed).toBe(true);
    expect(layout.railWidth).toBeGreaterThan(0);
  });

  it('keeps the rail alone at the narrowest widths, dropping the elapsed tail', () => {
    const layout = getHeaderLayout({ cols: 22, railCells: 18 });

    expect(layout.showElapsed).toBe(false);
    expect(layout.railWidth).toBeGreaterThan(0);
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
  const ESC = String.fromCharCode(27);
  const hostileSequence = `${ESC}[2J`;

  async function seatFrame(cols: number, config = makeConfig()): Promise<string> {
    resetStores();
    terminalSizeStore.__testReset({ cols, rows: 24, isSmall: cols < 120 });
    configStore.__testReset({ projectDir: '/tmp/p', config });
    const instance = render(<Header startedAt={STARTED_AT} />);
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
    expect(frame).toContain('qwen2.5-coder:7b');
    expect(frame.slice(frame.indexOf('PLAN'))).not.toContain(glyph('connectorSame'));
  });

  it('gives up one seat name to the tight bar instead of hiding all three', async () => {
    const frame = await seatFrame(110);

    expect(frame).toContain('PLAN');
    expect(frame).toContain('qwen2.5-coder:7b');
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
    expect(frame).toContain('gpt-5-codex');
    expect(frame).not.toContain(PLANNER_INHERITANCE.mark);
  });

  it('sanitizes hostile model ids in the visible seat line', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/p',
      config: makeConfig({ implementer: { model: `qwen${hostileSequence}-coder` } }),
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const rawFrame = instance.lastFrame() ?? '';

    expect(stripAnsiStyles(rawFrame)).toContain('qwen-coder');
    expect(rawFrame).not.toContain(hostileSequence);
    instance.unmount();
  });

  it('marks the halted seat with the clock its quota resets on', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    recoveryNoticeStore.open({ seat: 'build', resetAt: RESET_AT, issue: QUOTA_HALT });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('BUILD qwen2.5-coder:7b (resets 17:00)');
    expect(frame.indexOf('(resets 17:00)')).toBeGreaterThan(frame.indexOf('BUILD'));
    instance.unmount();
  });

  it('takes the reset clock off the bar once the halt is resolved', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    recoveryNoticeStore.open({ seat: 'build', resetAt: RESET_AT, issue: QUOTA_HALT });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).toContain('resets 17:00');

    recoveryNoticeStore.clear();
    await tick();
    expect(stripAnsiStyles(instance.lastFrame() ?? '')).not.toContain('resets');
    instance.unmount();
  });

  it('keeps the halted seat named and spends another seat when the note crowds the bar', async () => {
    resetStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });
    recoveryNoticeStore.open({ seat: 'build', resetAt: RESET_AT, issue: QUOTA_HALT });

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).toContain('BUILD qwen2.5-coder:7b (resets 17:00)');
    instance.unmount();
  });

  it('drops the seat line but keeps the elapsed clock when the rail crowds the bar', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: true });
    configStore.__testReset({ projectDir: '/tmp/p', config: makeConfig() });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('BUILD');
    expect(frame).toContain('0:05');
    instance.unmount();
  });
});

describe('Header — rail and elapsed', () => {
  it('renders the phase rail in place of any task title', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: false });
    lifecycleStore.__testReset({ phase: 'planning', status: 'running', startedAt: 0 });

    const instance = render(<Header startedAt={STARTED_AT} />);
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
        <Header startedAt={new Date().toISOString()} />
      </Box>,
      { cols: 120, rows: 40 },
    );
    await tick();
    const row = (stripAnsiStyles(ui.lastFrame()).split('\n')[0] ?? '').trimEnd();
    ui.unmount();

    // The active marker opens the rail on the gutter column the hit-test zones use, and its label
    // follows one marker slot in. A budget error blanks `Spec` while keeping its cells.
    expect(row.indexOf(glyph('stageActive'))).toBe(WORKFLOW_GUTTER_X);
    expect(row).toContain(`${glyph('stageActive')} Spec`);
    // The seat line and the clock stop short of the right gutter.
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

    const instance = render(<Header startedAt={STARTED_AT} />);
    await tick();
    const frame = stripAnsiStyles(instance.lastFrame() ?? '');

    expect(frame).not.toContain('cancelled');
    instance.unmount();
  });

  it('freezes elapsed time when lifecycle is cancelled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    lifecycleStore.__testReset({
      phase: 'researching',
      status: 'cancelled',
      cancelled: true,
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      reason: 'user_cancelled',
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const firstFrame = instance.lastFrame() ?? '';

    vi.advanceTimersByTime(30_000);

    expect(firstFrame).toContain('0:05');
    expect(instance.lastFrame() ?? '').toContain('0:05');
    instance.unmount();
  });

  it('renders elapsed time from the lifecycle start when resuming an older workflow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_605_000);
    lifecycleStore.__testReset({
      phase: 'planning',
      status: 'running',
      startedAt: 0,
    });

    const instance = render(<Header startedAt={new Date(3_600_000).toISOString()} />);
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('1:00:05');
    instance.unmount();
  });

  it('renders elapsed time from replayed lifecycle start when resuming an older workflow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(61_000);
    addEvent({
      type: 'workflow_started',
      ts: 1_000,
      phase: 'planning',
      feature: 'resumed workflow',
    });

    const instance = render(<Header startedAt={new Date(60_000).toISOString()} />);
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('1:00');
    expect(frame).not.toContain('0:01');
    instance.unmount();
  });

  it('freezes elapsed time when lifecycle is complete', () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 12_000,
      durationMs: 12_000,
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    const firstFrame = instance.lastFrame() ?? '';

    vi.advanceTimersByTime(30_000);

    expect(firstFrame).toContain('0:12');
    expect(instance.lastFrame() ?? '').toContain('0:12');
    instance.unmount();
  });

  it('freezes the elapsed clock while parked and resumes on resume', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(5_000);
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'running',
      startedAt: 0,
    });

    const instance = render(<Header startedAt={STARTED_AT} />);
    expect(instance.lastFrame() ?? '').toContain('0:05');

    await vi.advanceTimersByTimeAsync(5_000);
    await flushEffects();
    expect(instance.lastFrame() ?? '').toContain('0:10');

    markWorkflowPaused();
    await flushEffects();
    expect(instance.lastFrame() ?? '').toContain('0:10');

    await vi.advanceTimersByTimeAsync(20_000);
    await flushEffects();
    expect(instance.lastFrame() ?? '').toContain('0:10');

    markWorkflowResumed();
    await flushEffects();
    expect(instance.lastFrame() ?? '').toContain('0:30');

    await vi.advanceTimersByTimeAsync(2_000);
    await flushEffects();
    expect(instance.lastFrame() ?? '').toContain('0:32');
    instance.unmount();
  });

  // Each of these waits on the user inside a running run. The run clock counts that time, so the
  // wait never finds it frozen and the answer never makes it jump.
  it.each([
    {
      wait: 'the spec gate',
      phase: 'reviewing-spec',
      open: () => controlsStore.setInputMode('review'),
      answer: () => controlsStore.clearInputMode(),
    },
    {
      wait: 'the plan gate',
      phase: 'reviewing-plan',
      open: () => controlsStore.setInputMode('review'),
      answer: () => controlsStore.clearInputMode(),
    },
    {
      wait: 'a planner question',
      phase: 'specifying',
      open: () => controlsStore.setInputMode('question'),
      answer: () => controlsStore.clearInputMode(),
    },
    {
      wait: 'an approval',
      phase: 'implementing',
      open: () => {
        void openApprovalPrompt({
          tier: 'sticky',
          actionClass: 'network',
          actionDescription: 'push to origin',
          phase: 'implementing',
        });
      },
      answer: () => closeApprovalPrompt({ decision: 'allow', scope: 'once' }),
    },
    {
      wait: 'a recovery choice',
      phase: 'implementing',
      open: () => recoveryNoticeStore.open({ seat: 'build', resetAt: RESET_AT, issue: QUOTA_HALT }),
      answer: () => recoveryNoticeStore.clear(),
    },
  ] as const)(
    'keeps the run clock counting while $wait waits on the user',
    async ({ phase, open, answer }) => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(5_000);
      lifecycleStore.__testReset({ phase, status: 'running', startedAt: 0 });

      const instance = render(<Header startedAt={STARTED_AT} />);
      expect(clockText(instance.lastFrame())).toBe('0:05');

      open();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushEffects();
      const whileWaiting = clockText(instance.lastFrame());
      answer();
      await flushEffects();
      const afterAnswer = clockText(instance.lastFrame());
      expect({ whileWaiting, afterAnswer }).toEqual({ whileWaiting: '1:05', afterAnswer: '1:05' });

      await vi.advanceTimersByTimeAsync(2_000);
      await flushEffects();
      expect(clockText(instance.lastFrame())).toBe('1:07');
      instance.unmount();
    },
  );
});
