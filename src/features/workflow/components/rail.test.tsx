import { describe, expect, it, beforeEach } from 'vitest';
import { Box } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { glyph } from '../../../lib/glyphs.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { skillsStore } from '../../../stores/project/skills.js';
import {
  getRailStages,
  RAIL_MARKER_SLOT_WIDTH,
  railConnectorString,
} from '../layout/chrome-rows.js';
import {
  buildRailFraction,
  getRailStageZones,
  RAIL_FORM_C_CANCELLED_SUFFIX,
} from '../layout/hit-test.js';
import { Rail, railFormCText } from './rail.js';

const STAGES = ['spec', 'plan', 'briefs', 'build', 'verify'];

const ACTIVE = glyph('stageActive');
const DONE = glyph('stageDone');
const PENDING = glyph('stagePending');

function countActiveMarkers(frame: string): number {
  return stripAnsiStyles(frame).split(ACTIVE).length - 1;
}

// 1-based column of a stage label as actually painted, to compare against hit-test zones.
function renderedStageCol(frame: string, label: string): number {
  const line = stripAnsiStyles(frame)
    .split('\n')
    .find((row) => row.includes(label));
  if (line === undefined) throw new Error(`label ${label} not in frame`);
  return line.indexOf(label) + 1;
}

function lineContaining(frame: string, needle: string): string {
  const line = stripAnsiStyles(frame)
    .split('\n')
    .find((row) => row.includes(needle));
  if (line === undefined) throw new Error(`"${needle}" not in frame`);
  return line;
}

// The rail renders inline inside the header row, now flush to the terminal edge (no paddingX), so
// its first stage marker sits at screen column 1 (RAIL_CONTENT_LEFT_COL). Standalone renders keep
// that flush layout so the hit-test geometry stays honest.
function renderRail(form: 'B' | 'C') {
  return renderFeature(
    <Box>
      <Rail form={form} />
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
});

describe('Rail — Form B (horizontal pipeline)', () => {
  it('renders the five stages on one row with state-encoding markers, exactly one active', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    const railLine = frame.split('\n').find((row) => row.includes('spec')) ?? '';
    for (const stage of STAGES) expect(railLine).toContain(stage);
    // spec/plan/briefs done (●), build active (◉), verify pending (○).
    expect(countActiveMarkers(frame)).toBe(1);
    expect(railLine).toContain(`${ACTIVE} build`);
    expect(railLine).toContain(`${DONE} spec`);
    expect(railLine).toContain(`${PENDING} verify`);
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
    expect(idleFrame).not.toContain(ACTIVE);
    expect(countActiveMarkers(runningFrame)).toBe(1);
    // The active marker sits on the first stage, ahead of its label.
    expect(runningFrame).toContain(`${ACTIVE} spec`);
  });

  it('aligns every Form-B stage label with its hit-test zone (marker at the zone left edge)', async () => {
    const cols = 80;
    terminalSizeStore.__testReset({ cols, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const frame = ui.lastFrame() ?? '';

    const zones = getRailStageZones({ form: 'B', phase: 'implementing', cols, fraction: '' });
    expect(zones).toHaveLength(5);
    for (const zone of zones) {
      // The label is painted one marker slot to the right of the zone's left edge (the marker).
      expect(renderedStageCol(frame, zone.stage)).toBe(zone.left + RAIL_MARKER_SLOT_WIDTH);
    }
    ui.unmount();
  });

  it('paints no background pill behind the active stage — bold and the marker carry it', async () => {
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

  it('encodes the handoff without color: two seam arrows, chevrons between same-role stages', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('B');
    await tick();
    const railLine = lineContaining(ui.lastFrame() ?? '', 'spec');

    // With ANSI stripped the role hue is gone, so the seam reads only by the connector shape: the
    // two role seams (briefs→build, build→verify) paint the arrow; the other gaps paint chevrons.
    const arrow = railConnectorString(true);
    const chevron = railConnectorString(false);
    expect(railLine.split(arrow).length - 1).toBe(2);
    expect(railLine.split(chevron).length - 1).toBe(2);
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
    expect(countActiveMarkers(frame)).toBe(0);
    expect(frame).not.toContain('Implementing…');
    ui.unmount();
  });
});

describe('Rail — completion reward', () => {
  it('collapses to the single done line with the only ✓ in the rail', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    tasksStore.__testReset({ currentTask: 7, totalTasks: 7 });
    tokensStore.__testReset({ localCount: 7 });
    eventsStore.__testReset({
      events: [
        {
          type: 'drift_report',
          ts: 1,
          phase: 'final-review',
          passed: true,
          score: 1,
          errorCount: 0,
          warningCount: 0,
        },
      ],
    });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('statusDone')} done`);
    expect(frame).toContain('7/7 local');
    expect(frame).toContain('no drift');
    expect(countActiveMarkers(frame)).toBe(0);
    expect(frame).not.toContain('spec');
    ui.unmount();
  });

  it('reports a drift failure on the completion line', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 40, isSmall: false });
    lifecycleStore.__testReset({
      phase: 'complete',
      status: 'complete',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });
    tasksStore.__testReset({ currentTask: 7, totalTasks: 7 });
    tokensStore.__testReset({ localCount: 7 });
    eventsStore.__testReset({
      events: [
        {
          type: 'drift_report',
          ts: 1,
          phase: 'final-review',
          passed: false,
          score: 0,
          errorCount: 2,
          warningCount: 0,
        },
      ],
    });
    const ui = renderRail('B');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('drift found');
    ui.unmount();
  });
});

describe('Rail — Form C (narrow floor)', () => {
  it('builds the active stage line without a task fraction outside task stages', () => {
    expect(railFormCText(getRailStages('planning'), '')).toBe(`${ACTIVE} plan`);
  });

  it('builds the active task stage line with its task fraction', () => {
    expect(railFormCText(getRailStages('implementing'), '3/7')).toBe(`${ACTIVE} build  task 3/7`);
  });

  it('builds the cancelled stage line without a task fraction', () => {
    expect(railFormCText(getRailStages('implementing', { cancelled: true }), '3/7')).toBe(
      `${PENDING} build${RAIL_FORM_C_CANCELLED_SUFFIX}`,
    );
  });

  it('renders only the active stage and its fraction, no verb', async () => {
    terminalSizeStore.__testReset({ cols: 24, rows: 30, isSmall: false });
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running', startedAt: 0 });
    tasksStore.__testReset({ currentTask: 3, totalTasks: 7 });
    const ui = renderRail('C');
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('build');
    expect(frame).toContain(ACTIVE);
    expect(frame).toContain('task 3/7');
    expect(frame).not.toContain('implementing');
    expect(frame).not.toContain('verify');
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
      fraction: buildRailFraction('build', 3, 7),
    });
    const buildZone = zones.find((zone) => zone.stage === 'build');
    expect(buildZone).toBeDefined();
    // The marker opens the zone; the label sits one marker slot in.
    expect(renderedStageCol(frame, 'build')).toBe((buildZone?.left ?? 0) + RAIL_MARKER_SLOT_WIDTH);
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
    expect(frame).not.toContain('task 3/7');
    expect(countActiveMarkers(frame)).toBe(0);

    const zones = getRailStageZones({
      form: 'C',
      phase: 'implementing',
      cols,
      fraction: '',
      cancelled: true,
    });
    const buildZone = zones.find((zone) => zone.stage === 'build');
    const buildLine = frame.split('\n').find((line) => line.includes('build')) ?? '';
    const cancelledEnd = buildLine.indexOf('cancelled') + 'cancelled'.length;
    expect(cancelledEnd).toBeLessThanOrEqual(buildZone?.right ?? 0);
    ui.unmount();
  });
});
