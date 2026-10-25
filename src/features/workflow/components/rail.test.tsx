import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { defaultTheme, ThemeProvider } from '../../../components/theme.js';
import { resolveTheme } from '../../../core/theme/resolve.js';
import { paint } from '../../../core/theme/paint.js';
import { Box } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { withCaptureEnvironment } from '#testing/visual/gallery/environment.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { glyph } from '../../../lib/glyphs.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { makeReviewFixInsertedEvents } from '#testing/helpers/events/task.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { getRailStages, type RailStageStatus } from '../../../core/rail-stages.js';
import {
  RAIL_MARKER_SLOT_WIDTH,
  railConnectorString,
  WORKFLOW_GUTTER_X,
} from '../layout/chrome-rows.js';
import {
  buildRailFraction,
  getRailStageZones,
  hitRailStage,
  RAIL_FORM_C_CANCELLED_SUFFIX,
} from '../layout/hit-test.js';
import { measureRailCells, Rail, RailFormB, railFormCText } from './rail.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { readRailSnapshot } from '../layout/snapshot.js';

const STAGES = ['Plan', 'Build', 'Review'];
const originalColorLevel = chalk.level;

const DONE = glyph('stageDone');
const PENDING = glyph('stagePending');
const CANCELLED = glyph('statusCancelled');

function briefs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `T${String(index + 1).padStart(3, '0')}`,
    title: `Brief ${index + 1}`,
    status: 'done' as const,
  }));
}

// 0-based column of a stage label as actually painted, to compare against the hit-test zones (which
// are laid out in the same space, from RAIL_CONTENT_LEFT_COL onward).
function renderedStageCol(frame: string, label: string): number {
  const line = stripAnsiStyles(frame)
    .split('\n')
    .find((row) => row.includes(label));
  if (line === undefined) throw new Error(`label ${label} not in frame`);
  return line.indexOf(label);
}

function lineContaining(frame: string, needle: string): string {
  const line = stripAnsiStyles(frame)
    .split('\n')
    .find((row) => row.includes(needle));
  if (line === undefined) throw new Error(`"${needle}" not in frame`);
  return line;
}

// The rail renders inline inside the header row, which sits in the WORKFLOW_GUTTER_X gutter, so its
// first stage marker sits on the gutter column. A standalone render mirrors the same inset so the
// hit-test geometry stays honest.
function renderRail(form: 'B' | 'C', buildBlockShown = false) {
  return renderFeature(
    <Box paddingLeft={WORKFLOW_GUTTER_X}>
      <Rail form={form} buildBlockShown={buildBlockShown} />
    </Box>,
  );
}

beforeEach(() => {
  lifecycleStore.__testReset();
  terminalSizeStore.reset();
  eventsStore.__testReset();
  tasksStore.__testReset();
  tokensStore.__testReset();
  skillsStore.reset();
  overlayStore.reset();
});

afterEach(() => {
  chalk.level = originalColorLevel;
});

describe('Rail — Form B (horizontal pipeline)', () => {
  it('renders the three stages on one row, done and active filled and pending a ring', async () => {
    chalk.level = 3;
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    const railLine = frame.split('\n').find((row) => row.includes('Plan')) ?? '';
    for (const stage of STAGES) expect(railLine).toContain(stage);
    // plan done and build active wear the filled mark (weight tells them apart), review the ring.
    expect(railLine).toContain(`${DONE} Build`);
    expect(railLine).toContain(`${DONE} Plan`);
    expect(railLine).toContain(`${PENDING} Review`);
    const raw = ui.lastFrame() ?? '';
    expect(raw).toContain(paint(defaultTheme.success, `${DONE} `).replace('\u001b[39m', ''));
    expect(raw).toContain(paint(defaultTheme.planner, 'Plan').replace('\u001b[39m', ''));
    expect(raw).toContain(
      paint(defaultTheme.border, railConnectorString()).replace('\u001b[39m', ''),
    );
    expect(raw).toContain(paint(defaultTheme.textDim, `${PENDING} Review`));
    expect(raw).toContain(
      chalk.bold(paint(defaultTheme.implementer, `${DONE} Build`)).replaceAll('\u001b[39m', ''),
    );
    expect(raw).not.toContain(paint(defaultTheme.accent, `${DONE} `).replace('\u001b[39m', ''));
    ui.unmount();
  });

  it('distinguishes idle (no active marker) from a running first stage without color', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'idle' });
    const idle = renderRail('B');
    await tick();
    const idleFrame = stripAnsiStyles(idle.lastFrame() ?? '');
    idle.unmount();

    lifecycleStore.__testReset({ phase: 'specifying', status: 'running', startedAt: 0 });
    const running = renderRail('B');
    await tick();
    const runningFrame = stripAnsiStyles(running.lastFrame() ?? '');
    running.unmount();

    expect(runningFrame).not.toBe(idleFrame);
    expect(idleFrame).not.toContain(DONE);
    // The active marker sits on the first stage, ahead of its label.
    expect(runningFrame).toContain(`${DONE} Plan`);
    expect(runningFrame).toContain(`${PENDING} Build`);
  });

  it.each([
    ['implementing', 'running'],
    ['complete', 'complete'],
  ] as const)(
    'aligns every Form-B stage label with its hit-test zone at %s (marker at the zone left edge)',
    async (phase, status) => {
      const cols = 80;
      terminalSizeStore.__testReset({ cols, rows: 40, isSmall: false });
      lifecycleStore.__testReset({ phase, status, startedAt: 0 });
      tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
      const ui = renderRail('B');
      await tick();
      const frame = ui.lastFrame() ?? '';

      const zones = getRailStageZones({ form: 'B', phase, cols, fraction: '' });
      expect(zones).toHaveLength(3);
      for (const zone of zones) {
        // The label is painted one marker slot to the right of the zone's left edge (the marker).
        expect(renderedStageCol(frame, formatStageLabel(zone.stage))).toBe(
          zone.left + RAIL_MARKER_SLOT_WIDTH,
        );
      }
      ui.unmount();
    },
  );

  it('paints no background pill behind the active stage — weight carries it', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const raw = ui.lastFrame() ?? '';

    // No SGR background sequence (48;… truecolor/256 or the 40–47 basic range) anywhere in the rail.
    expect(raw).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*4[0-8][;m]`));
    ui.unmount();
  });

  it('encodes the handoff without color: an arrow on each of the two role seams', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const railLine = lineContaining(ui.lastFrame() ?? '', 'Plan');

    // With ANSI stripped the role hue is gone, so the seam reads only by the connector shape: the
    // two role seams (plan→build, build→review) paint the arrow.
    expect(railLine.split(railConnectorString()).length - 1).toBe(2);
    ui.unmount();
  });

  it('reserves no activity row and shows no active marker when cancelled', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'cancelled',
      cancelled: true,
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      reason: 'user_cancelled',
    });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    for (const stage of STAGES) expect(frame).toContain(stage);
    expect(frame).toContain(`${CANCELLED} Build`);
    expect(frame).not.toContain('Implementing…');
    ui.unmount();
  });
});

describe('Rail colors', () => {
  const states: readonly RailStageStatus[] = ['active', 'done', 'pending', 'failed', 'cancelled'];

  it.each([
    ['dark', 'B'],
    ['dark', 'C'],
    ['light', 'B'],
    ['light', 'C'],
  ] as const)('paints stage marks and labels in %s Form %s', (variant, form) => {
    chalk.level = 3;
    const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
    for (const status of states) {
      const mark =
        status === 'failed'
          ? glyph('statusFailed')
          : status === 'cancelled'
            ? CANCELLED
            : status === 'pending'
              ? PENDING
              : DONE;
      for (const [stage, label, seatTone] of [
        ['plan', 'Plan', 'planner'],
        ['build', 'Build', 'implementer'],
        ['review', 'Review', 'reviewer'],
        ['apply', 'Apply', 'text'],
      ] as const) {
        const markTone =
          status === 'active'
            ? seatTone
            : status === 'done'
              ? 'success'
              : status === 'failed'
                ? 'error'
                : status === 'cancelled'
                  ? 'warning'
                  : 'textDim';
        const ui = renderFeature(
          <ThemeProvider theme={theme}>
            {form === 'B' ? (
              <RailFormB stages={[{ stage, status }]} contentWidth={200} />
            ) : (
              <Rail form={form} stages={[{ stage, status }]} />
            )}
          </ThemeProvider>,
        );
        const frame = ui.lastFrame();
        const labelTone = status === 'pending' ? 'textDim' : seatTone;
        expect(frame).toContain(paint(theme[markTone], `${mark} `).replace('\u001b[39m', ''));
        expect(frame).toContain(
          paint(
            theme[labelTone],
            status === 'pending' || status === 'active' ? `${mark} ${label}` : label,
          ).replace('\u001b[39m', ''),
        );
        expect(frame).not.toContain(paint(theme.accent, `${mark} `).replace('\u001b[39m', ''));
        if (status === 'active') expect(frame).toContain('\u001b[1m');
        ui.unmount();
      }
    }
  });

  it.each([
    ['dark', 'B'],
    ['dark', 'C'],
    ['light', 'B'],
    ['light', 'C'],
  ] as const)('keeps the stopped run on Build in its seat tone in %s Form %s', (variant, form) => {
    chalk.level = 3;
    const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'paused' });
    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <Rail form={form} />
      </ThemeProvider>,
    );
    const frame = ui.lastFrame();
    expect(frame).toContain(
      `\u001b[1m${paint(theme.implementer, `${DONE} Build`).replace('\u001b[39m', '')}`,
    );
    expect(frame).not.toContain(paint(theme.accent, `${DONE} `).replace('\u001b[39m', ''));
    expect(frame).toContain('\u001b[1m');
    ui.unmount();
  });

  it.each(['dark', 'light'] as const)(
    'paints Form C seat, fraction and halt separately in %s',
    (variant) => {
      chalk.level = 3;
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      tasksStore.__testReset({ currentTask: 2, totalTasks: 5 });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
      const active = renderFeature(
        <ThemeProvider theme={theme}>
          <Rail form="C" />
        </ThemeProvider>,
      );
      const frame = active.lastFrame();
      expect(frame).toContain(paint(theme.implementer, `${DONE} Build`).replace('\u001b[39m', ''));
      expect(frame).not.toContain(paint(theme.accent, `${DONE} `).replace('\u001b[39m', ''));
      expect(frame).toContain(paint(theme.textDim, '  0/5 passed').replace('\u001b[39m', ''));
      expect(frame).not.toContain(paint(theme.success, 'passed').replace('\u001b[39m', ''));
      active.unmount();
      const halted = renderFeature(
        <ThemeProvider theme={theme}>
          <Rail form="C" stages={[{ stage: 'review', status: 'cancelled' }]} />
        </ThemeProvider>,
      );
      expect(halted.lastFrame()).toContain(
        paint(theme.warning, `${CANCELLED} `).replace('\u001b[39m', ''),
      );
      expect(halted.lastFrame()).toContain(
        paint(theme.reviewer, 'Review').replace('\u001b[39m', ''),
      );
      expect(halted.lastFrame()).toContain(paint(theme.warning, RAIL_FORM_C_CANCELLED_SUFFIX));
      halted.unmount();
    },
  );
});

describe('Rail — a passed review', () => {
  // The engine phase is `complete` from the passing review until the run settles at rest as ready
  // to apply or closed. That phase does not tell the two apart, so the rail never reads done.
  it.each([
    ['B', ['Plan', 'Build', 'Review']],
    ['C', ['Review']],
  ] as const)('keeps every stage marked in form %s and never reads done', async (form, labels) => {
    chalk.level = 3;
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'complete', status: 'complete', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 12, totalTasks: 10, tasks: briefs(12) });
    eventsStore.__testReset({
      events: [{ type: 'workflow_complete', ts: 1, phase: 'complete', review: 'passed' }],
    });
    const ui = renderRail(form);
    await tick();
    const raw = ui.lastFrame() ?? '';
    const frame = stripAnsiStyles(raw).trim();

    for (const label of labels) expect(frame).toContain(`${DONE} ${label}`);
    expect(frame.split(DONE)).toHaveLength(labels.length + 1);
    expect(frame).not.toContain('done');
    expect(frame).not.toContain('briefs passed');
    expect(frame).not.toContain('12/12');
    // Every stage is behind the run: none is bold as the stage the run is on.
    expect(raw).not.toContain('\u001b[1m');
    expect(
      measureRailCells({
        phase: 'complete',
        status: 'complete',
        cancelled: false,
        form,
        cols: 100,
        tasks: tasksStore.get(),
        events: eventsStore.get().events,
        recoveryAt: null,
        buildBlockShown: false,
      }),
    ).toBe(getTerminalCellWidth(frame));
    ui.unmount();
  });

  it.each([
    ['B', 'unicode-mono', '●'],
    ['C', 'unicode-mono', '●'],
    ['B', 'ascii-mono', '*'],
    ['C', 'ascii-mono', '*'],
  ] as const)('uses the done mark in form %s at %s', async (form, profile, mark) => {
    await withCaptureEnvironment({ viewport: { cols: 100, rows: 40 }, profile }, async () => {
      lifecycleStore.__testReset({ phase: 'complete', status: 'complete' });
      const ui = renderRail(form);
      await tick();
      const frame = stripAnsiStyles(ui.lastFrame());
      ui.unmount();
      expect(frame).toContain(`${mark} Review`);
      expect(frame).not.toContain('done');
    });
  });
});

describe('Rail — completion after a failed review', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
  });

  it('never says done while the review failed, and marks the review stage failed', async () => {
    chalk.level = 3;
    tasksStore.__testReset({ currentTask: 10, totalTasks: 10, tasks: briefs(10) });
    eventsStore.__testReset({
      events: [
        { type: 'workflow_complete', ts: 1, phase: 'complete', review: 'failed', blocking: 2 },
      ],
    });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain('done');
    expect(frame).toContain(`${DONE} Build`);
    expect(frame).toContain(`${glyph('statusFailed')} Review`);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.reviewer, 'Review').replace('\u001b[39m', ''),
    );
    ui.unmount();
  });
});

describe('Rail — completion with a halt open', () => {
  // A run read back with its failed review pending recovery carries the halt, not the log event that
  // announced it; the rail reads the halt.
  it('marks the review failed while a recovery waits at the end of the run', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    recoveryNoticeStore.open({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: makeRecoveryIssue({
        reason: 'review-failed',
        availableActions: ['revise', 'end-run'],
        recommendedAction: 'revise',
      }),
      at: { kind: 'review', cycle: 2 },
    });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain('done');
    expect(frame).toContain(`${glyph('statusFailed')} Review`);
    ui.unmount();
    recoveryNoticeStore.reset();
  });

  // The review passed and Apply halted: the rail the run at rest painted stays when it continues.
  it('marks Apply failed and the review done while an Apply halt waits', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    eventsStore.__testReset({
      events: [{ type: 'workflow_complete', ts: 1, phase: 'complete', review: 'passed' }],
    });
    recoveryNoticeStore.open({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: makeRecoveryIssue({
        reason: 'apply-conflict',
        phase: 'complete',
        availableActions: ['retry-same-worker', 'end-run'],
        recommendedAction: 'retry-same-worker',
      }),
      at: { kind: 'apply' },
    });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${DONE} Review`);
    expect(frame).toContain(`${glyph('statusFailed')} Apply`);
    expect(
      measureRailCells({
        phase: 'complete',
        status: 'complete',
        cancelled: false,
        form: 'B',
        cols: 100,
        tasks: tasksStore.get(),
        events: eventsStore.get().events,
        recoveryAt: { kind: 'apply' },
        buildBlockShown: false,
      }),
    ).toBe(getTerminalCellWidth(frame.trim()));
    ui.unmount();
    recoveryNoticeStore.reset();
  });
});

// A live run that passed its review resumes into Apply with `workflow_resumed` in `complete`: the
// rail stays the one the run at rest painted, with Apply as the stage the run is on.
describe('Rail — a live run resumed into its Apply step', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    addEvent({ type: 'workflow_complete', ts: 1, phase: 'complete', review: 'passed' });
    addEvent({ type: 'workflow_resumed', ts: 2, phase: 'complete', inProcess: true });
  });

  afterEach(() => {
    recoveryNoticeStore.reset();
  });

  it('keeps every stage done and shows Apply as the stage it runs', async () => {
    chalk.level = 3;
    const ui = renderRail('B');
    await tick();
    const raw = ui.lastFrame() ?? '';
    const frame = stripAnsiStyles(raw);

    for (const label of STAGES) expect(frame).toContain(`${DONE} ${label}`);
    expect(frame).toContain(`${DONE} Apply`);
    expect(frame).not.toContain(PENDING);
    // Apply is the stage the run is on: bold, and the only bold stage.
    expect(raw).toContain(`\u001b[1m${paint(defaultTheme.text, `${DONE} Apply`)}`);
    expect(raw.split('\u001b[1m')).toHaveLength(2);
    expect(
      measureRailCells({
        phase: lifecycleStore.get().phase,
        status: lifecycleStore.get().status,
        cancelled: false,
        form: 'B',
        cols: 100,
        tasks: tasksStore.get(),
        events: eventsStore.get().events,
        recoveryAt: null,
        buildBlockShown: false,
      }),
    ).toBe(getTerminalCellWidth(frame.trim()));
    ui.unmount();
  });

  it('marks Apply failed when Apply halts after the resume', async () => {
    recoveryNoticeStore.open({
      seat: null,
      ranOn: null,
      resetAt: null,
      issue: makeRecoveryIssue({
        reason: 'apply-partial',
        phase: 'complete',
        availableActions: ['retry-same-worker', 'restore-backup'],
        recommendedAction: 'retry-same-worker',
      }),
      at: { kind: 'apply' },
    });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    for (const label of STAGES) expect(frame).toContain(`${DONE} ${label}`);
    expect(frame).toContain(`${glyph('statusFailed')} Apply`);
    ui.unmount();
  });
});

describe('Rail — Form C (narrow floor)', () => {
  it.each([true, false])(
    'matches render, measure and hit-test with build block shown %s',
    async (buildBlockShown) => {
      terminalSizeStore.__testReset({ cols: 22, rows: 24, isSmall: true });
      lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
      for (const event of makeReviewFixInsertedEvents()) addEvent(event);
      if (!buildBlockShown) overlayStore.open('stop-sheet');
      const ui = renderRail('C', buildBlockShown);
      await tick();
      const frame = stripAnsiStyles(ui.lastFrame() ?? '').trim();

      expect(frame).toBe(buildBlockShown ? `${DONE} Build` : `${DONE} Build  4/7 passed`);
      expect(
        measureRailCells({
          phase: 'implementing',
          status: 'running',
          cancelled: false,
          form: 'C',
          cols: 22,
          tasks: tasksStore.get(),
          events: eventsStore.get().events,
          recoveryAt: null,
          buildBlockShown,
        }),
      ).toBe(getTerminalCellWidth(frame));
      const zones = readRailSnapshot().zones;
      const right = WORKFLOW_GUTTER_X + getTerminalCellWidth(frame) - 1;
      expect(zones[0]?.right).toBe(right);
      expect(hitRailStage(zones, right, 1)).toBe(1);
      expect(hitRailStage(zones, right + 1, 1)).toBeNull();
      ui.unmount();
    },
  );

  it('builds the active stage line without a task fraction outside task stages', () => {
    expect(railFormCText({ stages: getRailStages('planning'), fraction: '' })).toBe(`${DONE} Plan`);
  });

  it('builds the active build stage line with its passed fraction', () => {
    expect(railFormCText({ stages: getRailStages('implementing'), fraction: '3/7' })).toBe(
      `${DONE} Build  3/7 passed`,
    );
  });

  it('builds the cancelled stage line without a task fraction', () => {
    expect(
      railFormCText({
        stages: getRailStages('implementing', { cancelled: true }),
        fraction: '3/7',
      }),
    ).toBe(`${CANCELLED} Build${RAIL_FORM_C_CANCELLED_SUFFIX}`);
  });

  it('renders only the active stage and its fraction, no verb', async () => {
    terminalSizeStore.__testReset({ cols: 24, rows: 30, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('C');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Build');
    expect(frame).toContain(`${DONE} Build`);
    expect(frame).toContain('0/7 passed');
    expect(frame).not.toContain('implementing');
    expect(frame).not.toContain('Review');
    ui.unmount();
  });

  it('anchors the rendered active stage marker to its hit-test zone', async () => {
    const cols = 44;
    terminalSizeStore.__testReset({ cols, rows: 30, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('C');
    await tick();
    const frame = ui.lastFrame() ?? '';

    const zones = getRailStageZones({
      form: 'C',
      phase: 'implementing',
      cols,
      fraction: buildRailFraction('build', 0, 7),
    });
    const buildZone = zones.find((zone) => zone.stage === 'build');
    expect(buildZone).toBeDefined();
    // The marker opens the zone; the label sits one marker slot in.
    expect(renderedStageCol(frame, 'Build')).toBe((buildZone?.left ?? 0) + RAIL_MARKER_SLOT_WIDTH);
    ui.unmount();
  });

  it('paints the cancelled suffix and keeps the narrow cancelled stage inside its zone', async () => {
    const cols = 44;
    terminalSizeStore.__testReset({ cols, rows: 30, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'implementing',
      status: 'cancelled',
      cancelled: true,
      startedAt: 0,
      endedAt: 5_000,
      durationMs: 5_000,
      reason: 'user_cancelled',
    });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('C');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('cancelled');
    expect(frame).not.toContain('3/7 passed');
    expect(frame).toContain(`${CANCELLED} Build`);

    const zones = getRailStageZones({
      form: 'C',
      phase: 'implementing',
      cols,
      fraction: '',
      cancelled: true,
    });
    const buildZone = zones.find((zone) => zone.stage === 'build');
    const buildLine = frame.split('\n').find((line) => line.includes('Build')) ?? '';
    const cancelledEndCol = buildLine.indexOf('cancelled') + 'cancelled'.length - 1;
    expect(cancelledEndCol).toBeLessThanOrEqual(buildZone?.right ?? 0);
    ui.unmount();
  });
});
