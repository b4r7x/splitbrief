import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import { renderFeature, tick, flushEffects } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { glyph, spinnerFrames } from '../../../lib/glyphs.js';
import { PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore, type WorkflowTask } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { Sidebar } from './sidebar.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { taskId } from '../../../core/schemas/task.js';
import chalk from 'chalk';
import { defaultTheme } from '../../../components/theme.js';
import { TaskSummary } from '../../../components/task-summary.js';
import { paint } from '../../../core/theme/paint.js';

const originalColorLevel = chalk.level;

function task(
  id: string,
  status: WorkflowTask['status'],
  title: string = `task ${id}`,
): WorkflowTask {
  return { id, title, status };
}

beforeEach(() => {
  resetAllStores();
  configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
});

afterEach(() => {
  chalk.level = originalColorLevel;
  vi.unstubAllEnvs();
  resetAllStores();
});

describe('Sidebar — passed count', () => {
  it('counts only briefs that passed their checks in the header numerator', async () => {
    tasksStore.__testReset({
      tasks: [
        task('1', 'done'),
        task('2', 'escalated'),
        task('3', 'escalated'),
        task('4', 'done'),
        task('5', 'done'),
      ],
    });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('3/5');
    expect(frame).not.toContain('5/5');

    ui.unmount();
  });

  it('marks the brief a run at rest left in progress as stopped, not as working', async () => {
    forceUnicodeGlyphs();
    tasksStore.__testReset({ tasks: [task('T001', 'done'), task('T002', 'in_progress')] });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({
        status: {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
        },
      }),
      execution: { kind: 'at-rest' },
    });

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain(`${glyph('statusCancelled')} T002`);
    expect(frame).not.toContain(glyph('statusInProgress'));

    ui.unmount();
    routerStore.init({ screen: 'home' });
  });

  it('excludes pending and in-progress tasks from the passed numerator', async () => {
    tasksStore.__testReset({
      tasks: [
        task('1', 'done'),
        task('2', 'escalated'),
        task('3', 'in_progress'),
        task('4', 'pending'),
      ],
    });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('1/4');

    ui.unmount();
  });

  it('uses passed, escalated and failed counts from the task list in the footer', async () => {
    tasksStore.__testReset({
      tasks: [task('1', 'done'), task('2', 'done'), task('3', 'escalated'), task('4', 'failed')],
    });

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('2/4');
    expect(frame).toContain('2 passed');
    expect(frame).toContain('1 escalated');
    expect(frame).toContain('1 failed');
    expect(frame).not.toContain('2 done');

    ui.unmount();
  });

  it('shows failed counts without an escalated brief and budgets wrapped footer rows', async () => {
    tasksStore.__testReset({
      tasks: [task('1', 'done'), task('2', 'failed'), task('3', 'in_progress')],
    });
    const ui = renderFeature(<Sidebar width={34} height={14} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('1 passed · 1 failed');
    expect(frame).toContain('task 3');
    expect(frame.split('\n')).toHaveLength(14);
    ui.unmount();
  });

  it('sanitizes secret-like text and terminal controls in task titles', async () => {
    tasksStore.__testReset({
      tasks: [
        task(
          '1',
          'in_progress',
          'ship \u001b[31mred\u001b[0m eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c sk-abcdefghijklmnopqrstuvwxyz',
        ),
      ],
    });

    const ui = renderFeature(<Sidebar width={120} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('ship red ***REDACTED*** sk-***REDACTED***');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('shows a task target when metadata is available and keeps missing metadata clean', async () => {
    tasksStore.__testReset({
      tasks: [
        { ...task('1', 'pending', 'Create helper'), file: 'src/helper.ts', action: 'create' },
        task('2', 'pending', 'No target'),
      ],
    });

    const ui = renderFeature(<Sidebar width={80} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('1 Create helper · src/helper.ts (create)');
    expect(frame).toContain('2 No target');
    expect(frame).not.toContain('undefined');

    ui.unmount();
  });

  it('drops a target whole when only the id and title fit', async () => {
    tasksStore.__testReset({
      tasks: [
        { ...task('T001', 'pending', 'Create helper'), file: 'src/helper.ts', action: 'create' },
      ],
    });
    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('T001 Create helper');
    expect(frame).not.toMatch(/Create helper ·/u);
    ui.unmount();
  });

  it('gives every seat its own row at the narrow floor, cut by cells', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done')] });

    const ui = renderFeature(<Sidebar width={34} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const seatLines = ['PLAN', 'BUILD', 'REVIEW'].map(
      (label) => lines.find((line) => line.includes(label)) ?? '',
    );

    expect(seatLines[0]).toContain('Claude Code CLI');
    expect(seatLines[1]).toContain('Ollama');
    // No reviewer is configured, so the seat says whose runner it borrows.
    expect(seatLines[2]).toContain(PLANNER_INHERITANCE.mark);
    expect(new Set(seatLines).size).toBe(3);
    for (const line of seatLines) {
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(34);
    }

    ui.unmount();
  });

  it('cuts an over-long identity by cells and still leads with the tool name', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'shell', command: 'plan', model: 'a-model-name-that-runs-past-the-panel' },
      }),
    });
    tasksStore.__testReset({ tasks: [task('1', 'done')] });

    const ui = renderFeature(<Sidebar width={34} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const planLine = lines.find((line) => line.includes('PLAN')) ?? '';

    expect(planLine).toContain('Shell');
    expect(planLine).not.toContain('past the panel');
    expect(getTerminalCellWidth(planLine)).toBeLessThanOrEqual(34);

    ui.unmount();
  });

  it('keeps the OpenCode tool on its own row when the model and route need two more', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
      }),
    });
    tasksStore.__testReset({ tasks: [task('1', 'done')] });

    const ui = renderFeature(<Sidebar width={35} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const buildIndex = lines.findIndex((line) => line.includes('BUILD'));

    // The border glyph depends on the glyph set, so only the inner columns are compared.
    expect(lines.slice(buildIndex, buildIndex + 3).map((line) => line.slice(1, -1))).toEqual([
      ' BUILD   OpenCode CLI            ',
      '         DeepSeek V4.1 Flash     ',
      '         via ollama-cloud        ',
    ]);

    ui.unmount();
  });

  it('shows the waiting placeholder while a stage runs with no tasks', async () => {
    tasksStore.__testReset({ tasks: [] });
    lifecycleStore.__testReset({ phase: 'researching', startedAt: Date.now() - 65_000 });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('No tasks yet');
    expect(frame).toMatch(/\bPlan\b/);

    ui.unmount();
  });

  it('holds the spinner frame under reduced motion and shows no run clock', async () => {
    const previousReduceMotion = process.env.SPLITBRIEF_REDUCE_MOTION;
    process.env.SPLITBRIEF_REDUCE_MOTION = '1';
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(0);

    let ui: ReturnType<typeof renderFeature> | null = null;
    try {
      tasksStore.__testReset({ tasks: [] });
      lifecycleStore.__testReset({ phase: 'researching', startedAt: 0 });

      ui = renderFeature(<Sidebar width={30} />);
      const firstFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      const firstSpinnerFrame = spinnerFrames()[0] ?? '';

      expect(firstFrame).toContain(`${firstSpinnerFrame} Plan`);

      await vi.advanceTimersByTimeAsync(1000);
      await flushEffects();

      const nextFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(nextFrame).toContain(`${firstSpinnerFrame} Plan`);
      expect(nextFrame).not.toMatch(/\d+:\d{2}/);
    } finally {
      ui?.unmount();
      if (previousReduceMotion === undefined) {
        delete process.env.SPLITBRIEF_REDUCE_MOTION;
      } else {
        process.env.SPLITBRIEF_REDUCE_MOTION = previousReduceMotion;
      }
      vi.useRealTimers();
    }
  });

  it('shows only the empty note when nothing is running', async () => {
    tasksStore.__testReset({ tasks: [] });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('No tasks yet');
    expect(frame).not.toMatch(/\bPlan\b/);

    ui.unmount();
  });

  it('sidebar shows a static interrupted line without spinner frames', async () => {
    tasksStore.__testReset({ tasks: [] });
    lifecycleStore.__testReset({
      phase: 'researching',
      status: 'interrupted',
      startedAt: Date.now() - 5_000,
    });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Planner interrupted');
    expect(frame).not.toMatch(/\bPlan\b/);

    ui.unmount();
  });

  it('keeps the crew footer visible when the task list is long', async () => {
    const tasks = Array.from({ length: 40 }, (_value, index) =>
      task(String(index + 1), index % 2 === 0 ? 'done' : 'pending'),
    );
    tasksStore.__testReset({ tasks });

    const ui = renderFeature(<Sidebar width={32} height={10} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('20/40');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');

    ui.unmount();
  });
});

describe('Sidebar — titled border', () => {
  beforeEach(forceUnicodeGlyphs);

  it.each([
    { tier: 'unicode', corner: '┌', rule: '─', end: '┐', side: '│', bottom: '└' },
    { tier: 'ascii', corner: '+', rule: '-', end: '+', side: '|', bottom: '+' },
  ])('puts the count into the $tier top border without changing the height', async (border) => {
    chalk.level = 3;
    if (border.tier === 'ascii') vi.stubEnv('TERM', 'dumb');
    tasksStore.__testReset({
      tasks: [task('1', 'pending'), task('2', 'pending'), task('3', 'pending')],
      totalTasks: 3,
    });

    const ui = renderFeature(<Sidebar width={40} height={14} />);
    await tick();
    const frame = ui.lastFrame() ?? '';
    const lines = stripAnsiStyles(frame).split('\n');

    expect(lines[0]).toBe(`${border.corner} Tasks 0/3 ${border.rule.repeat(27)}${border.end}`);
    expect(frame.split('\n')[0]).toContain(
      paint(defaultTheme.textDim, ' Tasks 0/3 ').replace('\u001b[39m', ''),
    );
    expect(getTerminalCellWidth(lines[0] ?? '')).toBe(40);
    expect(lines[1]).toBe(`${border.side}${' '.repeat(38)}${border.side}`);
    expect(lines[2]).toContain('task 1');
    expect(lines).toHaveLength(14);
    expect(lines[13]?.startsWith(border.bottom)).toBe(true);
    expect(lines.filter((line) => line.includes('Tasks'))).toHaveLength(1);

    ui.unmount();
  });

  it.each([
    { tier: 'unicode', corner: '┌', end: '┐' },
    { tier: 'ascii', corner: '+', end: '+' },
  ])('truncates a count inside both $tier corners without wrapping', async (border) => {
    if (border.tier === 'ascii') vi.stubEnv('TERM', 'dumb');
    tasksStore.__testReset({ totalTasks: Number.MAX_SAFE_INTEGER });

    const ui = renderFeature(<Sidebar width={24} height={14} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines[0]?.startsWith(`${border.corner} Tasks 0/`)).toBe(true);
    expect(lines[0]?.endsWith(`… ${border.end}`)).toBe(true);
    expect(getTerminalCellWidth(lines[0] ?? '')).toBe(24);
    expect(lines).toHaveLength(14);
    expect(lines.filter((line) => line.includes('Tasks'))).toHaveLength(1);

    ui.unmount();
  });
});

describe('Sidebar — minimum-height contract', () => {
  it.each([0, 1, 2])('never paints outside its explicit %i-row height', async (height) => {
    tasksStore.__testReset({
      tasks: [task('1', 'in_progress', 'a task that should stay clipped')],
      totalTasks: 1,
    });

    const ui = renderFeature(<Sidebar width={34} height={height} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const paintedRows = frame === '' ? [] : frame.split('\n');

    expect(paintedRows.length, `painted rows at height ${height}`).toBeLessThanOrEqual(height);
    ui.unmount();
  });

  it('can grow from an unusable height without changing its hook order', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'pending')] });

    const ui = renderFeature(<Sidebar width={34} height={1} />);
    await tick();
    ui.rerender(<Sidebar width={34} height={2} />);
    await tick();

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Tasks');
    ui.unmount();
  });

  function useOpenCodeBuildSeat(): void {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' },
      }),
    });
    tasksStore.__testReset({ tasks: [task('1', 'done'), task('2', 'in_progress')] });
  }

  it('gives each seat one row when the wrapped crew does not fit above the bottom border', async () => {
    forceUnicodeGlyphs();
    useOpenCodeBuildSeat();

    const ui = renderFeature(<Sidebar width={34} height={7} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines).toHaveLength(7);
    expect(lines.slice(3, 6).map((line) => line.slice(1, -1))).toEqual([
      ' PLAN    Claude Code CLI · auto ',
      ' BUILD   DeepSeek V4.1 Flash    ',
      ` REVIEW  ${PLANNER_INHERITANCE.mark}`.padEnd(32),
    ]);
    expect(lines[6]).toBe(`└${'─'.repeat(32)}┘`);

    ui.unmount();
  });

  it.each([
    { height: 6, crew: ['PLAN', 'BUILD'] },
    { height: 5, crew: ['PLAN'] },
    { height: 4, crew: [] },
  ])('clips the crew inside the bottom border at height $height', async ({ height, crew }) => {
    forceUnicodeGlyphs();
    useOpenCodeBuildSeat();

    const ui = renderFeature(<Sidebar width={34} height={height} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines).toHaveLength(height);
    expect(lines[2]?.slice(1, -1)).toBe(` ${'─'.repeat(30)} `);
    expect(lines.slice(3, -1).map((line) => line.slice(2).split(' ')[0])).toEqual(crew);
    expect(lines.at(-1)).toBe(`└${'─'.repeat(32)}┘`);

    ui.unmount();
  });
});

const LONG_TITLE = 'A task title that is exactly forty chars';

describe('Sidebar — title budget', () => {
  it('fits a long task title on one line inside its box at widths 30, 34, 48 and 60', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'in_progress', LONG_TITLE)] });

    for (const width of [30, 34, 48, 60]) {
      const ui = renderFeature(<Sidebar width={width} />);
      await tick();
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      const lines = frame.split('\n');

      expect(
        lines.filter((line) => line.includes('A task title that')),
        `title rows at width ${width}`,
      ).toHaveLength(1);
      for (const line of lines) {
        expect(
          getTerminalCellWidth(line),
          `line at width ${width} exceeds the box`,
        ).toBeLessThanOrEqual(width);
      }

      ui.unmount();
    }
  });

  it('never paints the footer rule wider than the box', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done', LONG_TITLE)] });

    for (const width of [30, 60]) {
      const ui = renderFeature(<Sidebar width={width} />);
      await tick();
      const frame = stripAnsiStyles(ui.lastFrame() ?? '');
      const ruleLine =
        frame.split('\n').find((line) => /^[ \t]*[|│]?[ \t]*[-─]+[ \t]*[|│]?[ \t]*$/u.test(line)) ??
        '';

      expect(ruleLine, `footer rule at width ${width}`).not.toBe('');
      expect(
        getTerminalCellWidth(ruleLine),
        `footer rule at width ${width} exceeds the box`,
      ).toBeLessThanOrEqual(width);

      ui.unmount();
    }
  });

  it('keeps the status word for the rare states even at the narrow floor', async () => {
    chalk.level = 3;
    tasksStore.__testReset({
      tasks: [
        task('T001', 'escalated', LONG_TITLE),
        task('T002', 'failed', LONG_TITLE),
        task('T003', 'skipped', LONG_TITLE),
      ],
    });

    const ui = renderFeature(<Sidebar width={34} />);
    await tick();
    const rows = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => /T00[123]/u.test(line));

    // A dash against a circle is the whole distinction between skipped and queued, so the states
    // the user has to act on keep their word however narrow the panel gets.
    expect(rows[0]).toContain('escalated');
    expect(rows[1]).toContain('failed');
    expect(ui.lastFrame()).toContain(paint(defaultTheme.error, '  failed'));
    expect(rows[2]).toContain('skipped');
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row).toContain(`T00${index + 1} A task`);
      expect(row).toContain('…');
      expect(getTerminalCellWidth(row)).toBeLessThanOrEqual(34);
    }
    expect(new Set(rows.map((row) => row.indexOf('T00'))).size).toBe(1);
    expect(new Set(rows.map((row) => row.indexOf('…'))).size).toBe(1);
    expect(new Set(rows.map((row) => row.search(/escalated|failed|skipped/u))).size).toBe(1);

    ui.unmount();
  });

  it('gives every row one truncation column once any row carries a status word', async () => {
    tasksStore.__testReset({
      tasks: [
        task('1', 'in_progress', LONG_TITLE),
        task('2', 'escalated', LONG_TITLE),
        task('3', 'done', LONG_TITLE),
      ],
    });

    for (const width of [34, 48]) {
      const ui = renderFeature(<Sidebar width={width} />);
      await tick();
      const rows = stripAnsiStyles(ui.lastFrame() ?? '')
        .split('\n')
        .filter((line) => line.includes('A task title'));

      expect(rows, `rows at width ${width}`).toHaveLength(3);
      const cuts = rows.map((row) => row.indexOf('…'));
      expect(new Set(cuts).size, `titles rag at width ${width}: ${JSON.stringify(rows)}`).toBe(1);

      ui.unmount();
    }
  });

  it('reserves no status column when nothing is escalated, failed, or skipped', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'in_progress', LONG_TITLE)] });
    const withoutTail = renderFeature(<Sidebar width={34} />);
    await tick();
    const plain =
      stripAnsiStyles(withoutTail.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes('A task title')) ?? '';
    withoutTail.unmount();

    tasksStore.__testReset({
      tasks: [task('1', 'in_progress', LONG_TITLE), task('2', 'skipped', LONG_TITLE)],
    });
    const withTail = renderFeature(<Sidebar width={34} />);
    await tick();
    const reserved =
      stripAnsiStyles(withTail.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes('A task title')) ?? '';
    withTail.unmount();

    expect(sidebarTitleCells(reserved)).toBeLessThan(sidebarTitleCells(plain));
  });
});

function sidebarTitleCells(row: string): number {
  const body = row.trimEnd().slice(5, -2);
  const title = body.replace(/ {2,}[A-Za-z]+ *$/u, '');
  return getTerminalCellWidth(title.trimEnd());
}

describe('Sidebar — persistent task list', () => {
  it('keeps completed tasks listed with a done marker once later tasks start', async () => {
    forceUnicodeGlyphs();
    tasksStore.__testReset({
      tasks: [task('1', 'done', 'First task'), task('2', 'in_progress', 'Second task')],
      totalTasks: 2,
    });

    const ui = renderFeature(<Sidebar width={40} height={20} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const doneRow = frame.split('\n').find((line) => line.includes('First task')) ?? '';
    const activeRow = frame.split('\n').find((line) => line.includes('Second task')) ?? '';

    expect(doneRow).toContain('●');
    expect(activeRow).toContain(glyph('statusInProgress'));
    expect(activeRow).toContain(glyph('liveBar'));

    ui.unmount();
  });

  it('counts against the announced plan size rather than the tasks started so far', async () => {
    tasksStore.__testReset({
      tasks: [task('1', 'done'), task('2', 'in_progress')],
      totalTasks: 5,
    });

    const ui = renderFeature(<Sidebar width={40} height={20} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Tasks 1/5');
    expect(frame).toContain('+3 more');

    ui.unmount();
  });

  it('keeps title width stable when a hidden failed status tail enters the window', async () => {
    const sharedTitle = 'a very long shared task title that must truncate';
    const makeTasks = (runningIndex: number): WorkflowTask[] =>
      Array.from({ length: 12 }, (_value, index) =>
        task(
          String(index + 1),
          index === 8
            ? 'failed'
            : index === runningIndex
              ? 'in_progress'
              : index < 4
                ? 'done'
                : 'pending',
          index === 6 ? sharedTitle : `task ${index + 1}`,
        ),
      );

    tasksStore.__testReset({ tasks: makeTasks(4), totalTasks: 12 });
    const first = renderFeature(<Sidebar width={40} height={17} />);
    await tick();
    const firstRow =
      stripAnsiStyles(first.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes(sharedTitle.slice(0, 12))) ?? '';
    first.unmount();

    tasksStore.__testReset({ tasks: makeTasks(10), totalTasks: 12 });
    const second = renderFeature(<Sidebar width={40} height={17} />);
    await tick();
    const secondRow =
      stripAnsiStyles(second.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes(sharedTitle.slice(0, 12))) ?? '';

    expect(firstRow).toBe(secondRow);
    expect(firstRow).toContain('…');
    second.unmount();
  });

  it('lines the empty state up with the column the task titles use', async () => {
    tasksStore.__testReset({ tasks: [] });
    lifecycleStore.__testReset({ phase: 'researching', startedAt: Date.now() - 65_000 });

    const ui = renderFeature(<Sidebar width={34} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const titleColumn = (needle: string): number =>
      (lines.find((line) => line.includes(needle)) ?? '').indexOf(needle);

    // The stage label sits on the title column; its spinner takes the marker column, so the empty
    // state uses the same two-column grid as a populated list.
    expect(titleColumn('Plan')).toBe(titleColumn('No tasks yet'));
    ui.unmount();

    tasksStore.__testReset({ tasks: [task('1', 'in_progress', 'A real title')] });
    const populated = renderFeature(<Sidebar width={34} />);
    await tick();
    const populatedTitle = (
      stripAnsiStyles(populated.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes('1 A real title')) ?? ''
    ).indexOf('1 A real title');

    expect(titleColumn('No tasks yet')).toBe(populatedTitle);

    populated.unmount();
  });

  it('names what the window hid instead of leaving a bare count', async () => {
    const tasks = Array.from({ length: 24 }, (_value, index) =>
      task(
        String(index + 1),
        index < 11 ? 'done' : index === 11 ? 'in_progress' : 'pending',
        `task number ${index + 1}`,
      ),
    );
    tasksStore.__testReset({ tasks, totalTasks: 24 });

    const ui = renderFeature(<Sidebar width={34} height={20} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // The counts follow the row budget; what matters is that each edge names the state it hides.
    expect(frame).toMatch(/\d+ done above/u);
    expect(frame).toMatch(/\d+ queued below/u);

    ui.unmount();
  });

  it('falls back to a plain count when the hidden slice is not all one status', async () => {
    const tasks = Array.from({ length: 24 }, (_value, index) =>
      task(
        String(index + 1),
        index < 11
          ? index === 0
            ? 'escalated'
            : 'done'
          : index === 11
            ? 'in_progress'
            : 'pending',
        `task number ${index + 1}`,
      ),
    );
    tasksStore.__testReset({ tasks, totalTasks: 24 });

    const ui = renderFeature(<Sidebar width={34} height={20} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toMatch(/\d+ above/u);
    expect(frame).not.toContain('done above');

    ui.unmount();
  });

  it('windows a long plan around the running task and reports what it hid', async () => {
    const tasks = Array.from({ length: 14 }, (_value, index) =>
      task(
        String(index + 1),
        index < 8 ? 'done' : index === 8 ? 'in_progress' : 'pending',
        `task number ${index + 1}`,
      ),
    );
    tasksStore.__testReset({ tasks, totalTasks: 14 });

    const ui = renderFeature(<Sidebar width={40} height={16} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('task number 9');
    expect(frame).toContain('above');
    expect(frame).toContain('below');
    expect(frame).not.toContain('task number 1 ');
    expect(frame.split('\n').filter((line) => line.includes('task number'))).not.toHaveLength(14);

    ui.unmount();
  });

  it('keeps the footer visible when the plan is far longer than the sidebar', async () => {
    const tasks = Array.from({ length: 60 }, (_value, index) =>
      task(String(index + 1), index < 30 ? 'done' : index === 30 ? 'in_progress' : 'pending'),
    );
    tasksStore.__testReset({ tasks, totalTasks: 60 });

    const ui = renderFeature(<Sidebar width={40} height={14} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const lines = frame.split('\n');

    expect(frame).toContain('Tasks 30/60');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');
    expect(lines).toHaveLength(14);

    ui.unmount();
  });

  it('uses all seven task rows above a three-row crew footer at height fourteen', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'shell', command: 'plan' },
        implementer: { kind: 'shell', command: 'build', model: 'build-model' },
      }),
    });
    tasksStore.__testReset({
      tasks: Array.from({ length: 7 }, (_, index) => task(String(index + 1), 'pending')),
      totalTasks: 7,
    });

    const ui = renderFeature(<Sidebar width={40} height={14} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const lines = frame.split('\n');

    expect(lines.filter((line) => /task \d/u.test(line))).toHaveLength(7);
    expect(frame).not.toMatch(/\b(above|below)\b/u);
    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');
    expect(lines).toHaveLength(14);

    ui.unmount();
  });
});

describe('Sidebar — unbudgeted height', () => {
  beforeEach(forceUnicodeGlyphs);

  it('lists every task when the caller passes no height', async () => {
    tasksStore.__testReset({
      tasks: [
        task('1', 'done', 'first title'),
        task('2', 'done', 'second title'),
        task('3', 'in_progress', 'third title'),
      ],
      totalTasks: 6,
    });

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const lines = frame.split('\n');

    expect(lines[0]).toBe(`┌ Tasks 2/6 ${'─'.repeat(27)}┐`);
    expect(lines[1]).toBe(`│${' '.repeat(38)}│`);
    expect(lines[2]).toContain('first title');
    expect(frame).toContain('first title');
    expect(frame).toContain('second title');
    expect(frame).toContain('third title');
    expect(frame).toContain('+3 more');
    expect(frame).not.toContain('below');

    ui.unmount();
  });
});

describe('Sidebar — reviewer seat', () => {
  it('names the reviewer seat with its own runner when a reviewer is configured', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex' } }),
    });

    const ui = renderFeature(<Sidebar width={50} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('REVIEW');
    expect(frame).toContain('GPT-5 Codex');
    expect(frame).not.toContain(PLANNER_INHERITANCE.mark);
    ui.unmount();
  });
});

describe('Sidebar — a crew wider than the seat column', () => {
  beforeEach(forceUnicodeGlyphs);

  // The smoke crew of 2026-10-10: at the 48-column cap each identity overruns the 36-cell budget.
  const smokeCrew = () =>
    makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
      implementer: { kind: 'cli', tool: 'antigravity', model: 'gemini-3.8-flash-high' },
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    });

  function seatBlock(frame: string, label: string): string {
    const lines = stripAnsiStyles(frame).split('\n');
    const index = lines.findIndex((line) => line.includes(`${label} `));
    return [lines[index] ?? '', lines[index + 1] ?? '']
      .map((line) => line.replace(/[│┌┐└┘─]/g, '').trim())
      .join(' ');
  }

  it('wraps each identity onto a second row instead of shedding the model or the effort', async () => {
    configStore.__testReset({ projectDir: '/tmp/project', config: smokeCrew() });
    tasksStore.__testReset({ tasks: [task('1', 'pending')] });

    const ui = renderFeature(<Sidebar width={48} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(seatBlock(frame, 'PLAN')).toBe('PLAN    OpenAI Codex CLI GPT-6-Astra · xhigh');
    expect(seatBlock(frame, 'BUILD')).toBe(
      'BUILD   Google Antigravity CLI Gemini 3.8 Flash · high',
    );
    expect(seatBlock(frame, 'REVIEW')).toBe('REVIEW  OpenAI Codex CLI GPT-6.1-Sol · high');
    for (const line of stripAnsiStyles(frame).split('\n')) {
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(48);
    }

    ui.unmount();
  });

  it('keeps one row per seat when the identity fits', async () => {
    configStore.__testReset({ projectDir: '/tmp/project', config: smokeCrew() });
    tasksStore.__testReset({ tasks: [task('1', 'pending')] });

    const ui = renderFeature(<Sidebar width={80} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines.find((line) => line.includes('PLAN '))).toContain(
      'OpenAI Codex CLI · GPT-6-Astra · xhigh',
    );
    expect(lines.find((line) => line.includes('BUILD '))).toContain(
      'Google Antigravity CLI · Gemini 3.8 Flash · high',
    );

    ui.unmount();
  });

  it('budgets the wrapped seat rows so the panel keeps its height and every seat row', async () => {
    configStore.__testReset({ projectDir: '/tmp/project', config: smokeCrew() });
    tasksStore.__testReset({
      tasks: Array.from({ length: 30 }, (_, index) => task(String(index + 1), 'pending')),
    });

    const ui = renderFeature(<Sidebar width={48} height={20} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.split('\n')).toHaveLength(20);
    expect(frame).toContain('GPT-6-Astra · xhigh');
    expect(frame).toContain('Gemini 3.8 Flash · high');
    expect(frame).toContain('GPT-6.1-Sol · high');
    expect(frame).toContain('PLAN');
    expect(frame).toContain('BUILD');
    expect(frame).toContain('REVIEW');

    ui.unmount();
  });
});

describe('Sidebar — usage lives in /usage', () => {
  // The same priced fixture `useCostStats` uses: a run whose tokens do carry a price, so an amount
  // would be painted if the footer still asked for one.
  function seedPricedRun(): void {
    tokensStore.__testReset({
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
    });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'priced-model',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
    });
    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        vendor: {
          id: 'vendor',
          models: { 'priced-model': { id: 'priced-model', cost: { input: 1, output: 2 } } },
        },
      },
      fetchedAt: 1,
      validatedAt: 1,
    });
  }

  it('paints no local row or money for a run whose usage is priced', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done'), task('2', 'done')] });
    seedPricedRun();

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toMatch(/\blocal\b/u);
    expect(frame).not.toContain('$');
    expect(frame).not.toContain('3.00');
    ui.unmount();
  });

  it('paints no token total for a run whose usage is priced', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done'), task('2', 'done')] });
    seedPricedRun();

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toContain('1,000,000');
    expect(frame).not.toContain('2000k');
    expect(frame).not.toMatch(/\btokens?\b/i);
    expect(frame).not.toMatch(/\blocal\b/u);
    ui.unmount();
  });
});

describe('Sidebar — no mode row', () => {
  it('names no mode, even when the engine resolves one', async () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ workflow: { mode: 'standard' } }),
    });
    addEvent({ type: 'mode_resolved', ts: 1, phase: 'planning', mode: 'quick', approve: 'none' });

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).not.toMatch(/\b(quick|standard|speckit)\b/);

    ui.unmount();
  });
});

describe('Sidebar concept colors', () => {
  it('keeps the skipped summary word, mark and sidebar tail in the same dim color', () => {
    forceUnicodeGlyphs();
    chalk.level = 3;
    tasksStore.__testReset({ tasks: [task('T002', 'skipped', 'Stock brief')] });
    const ui = renderFeature(
      <Box flexDirection="column">
        <TaskSummary
          width={60}
          id="T002"
          title="Receive stock"
          state={{ kind: 'settled', method: 'skipped' }}
        />
        <Sidebar width={60} />
      </Box>,
    );
    const frame = ui.lastFrame();
    for (const text of [
      ` ${glyph('statusSkipped')} T002 Receive stock  skipped`,
      ` ${glyph('statusSkipped')} T002 Stock brief`,
      '  skipped',
    ]) {
      expect.soft(frame).toContain(paint(defaultTheme.textDim, text));
    }
    ui.unmount();
  });

  it.each([
    ['in_progress', 'accent', 'statusInProgress'],
    ['done', 'success', 'stageDone'],
    ['failed', 'error', 'statusFailed'],
    ['escalated', 'warning', 'statusEscalated'],
    ['skipped', 'textDim', 'statusSkipped'],
  ] as const)('paints the %s mark with %s', (status, tone, mark) => {
    chalk.level = 3;
    tasksStore.__testReset({ tasks: [task('T001', status, 'Task title')] });
    const ui = renderFeature(<Sidebar width={60} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme[tone], `${status === 'skipped' ? ' ' : ''}${glyph(mark)} `).replace(
        '\u001b[39m',
        '',
      ),
    );
    if (status === 'failed' || status === 'escalated' || status === 'skipped') {
      expect(ui.lastFrame()).toContain(
        paint(defaultTheme[tone], `  ${status}`).replace('\u001b[39m', ''),
      );
    }
    ui.unmount();
  });

  it('colors Planner and interrupted separately', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'planning' });
    const ui = renderFeature(<Sidebar width={60} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.planner, 'Planner').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, 'interrupted').replace('\u001b[39m', ''),
    );
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Planner interrupted');
    ui.unmount();
  });

  it('keeps the planning stage in the planner color without the removed local share', () => {
    chalk.level = 3;
    lifecycleStore.__testReset({ status: 'running', phase: 'planning' });
    const ui = renderFeature(<Sidebar width={60} />);
    expect(ui.lastFrame()).toContain(paint(defaultTheme.planner, 'Plan').replace('\u001b[39m', ''));
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('local');
    ui.unmount();
  });
  it('colors the summary state words while keeping counts dim', () => {
    chalk.level = 3;
    tasksStore.__testReset({ tasks: [task('T001', 'done'), task('T002', 'escalated')] });
    const ui = renderFeature(<Sidebar width={60} />);
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.success, 'passed').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.warning, 'escalated').replace('\u001b[39m', ''),
    );
    expect(ui.lastFrame()).toContain(
      paint(defaultTheme.textDim, ' · 1 ').replace('\u001b[39m', ''),
    );
    expect(stripAnsiStyles(ui.lastFrame())).toContain('1 passed · 1 escalated');
    ui.unmount();
  });
});
