import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import { act } from 'react';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { glyph, spinnerFrames } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import type { WorkflowTask } from '../../../stores/workflow/tasks.js';
import { Sidebar } from './sidebar.js';

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
  resetAllStores();
});

describe('Sidebar — completed count', () => {
  it('counts escalated tasks as completed in the header numerator', async () => {
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

    expect(frame).toContain('5/5');
    expect(frame).not.toContain('3/5');

    ui.unmount();
  });

  it('excludes pending and in-progress tasks from the completed numerator', async () => {
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

    expect(frame).toContain('2/4');

    ui.unmount();
  });

  it('splits the breakdown line into local vs escalated', async () => {
    tasksStore.__testReset({
      tasks: [task('1', 'done'), task('2', 'done'), task('3', 'escalated')],
    });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('3/3');
    expect(frame).toContain('2 done');
    expect(frame).toContain('1 escalated');

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

    expect(frame).toContain('Create helper · src/helper.ts (create)');
    expect(frame).toContain('No target');
    expect(frame).not.toContain('undefined');

    ui.unmount();
  });

  it('keeps both runners named at the narrow floor instead of spending the row on one', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done')] });

    const ui = renderFeature(<Sidebar width={34} />);
    await tick();
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const plannerLine = lines.find((line) => line.includes('Planner')) ?? '';
    const implementerLine = lines.find((line) => line.includes('Implementer')) ?? '';

    // A single shared row spent its whole width on the planner and cut the implementer away.
    expect(plannerLine).toContain('Planner Claude Code CLI');
    expect(implementerLine).toContain('Implementer');
    expect(implementerLine).toContain('Qwen 2.5 Coder');
    expect(plannerLine).not.toBe(implementerLine);
    expect(lines.some((line) => line.includes('Reviewer'))).toBe(false);
    for (const line of [plannerLine, implementerLine]) {
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(34);
    }

    ui.unmount();
  });

  it('shows the waiting placeholder while a stage runs with no tasks', async () => {
    tasksStore.__testReset({ tasks: [] });
    lifecycleStore.__testReset({ phase: 'researching', startedAt: Date.now() - 65_000 });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('No tasks yet');
    expect(frame).toContain('Spec');

    ui.unmount();
  });

  it('keeps the waiting clock live under reduced motion without advancing the frame', async () => {
    const previousReduceMotion = process.env.SPLITBRIEF_REDUCE_MOTION;
    process.env.SPLITBRIEF_REDUCE_MOTION = '1';
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let ui: ReturnType<typeof renderFeature> | null = null;
    try {
      tasksStore.__testReset({ tasks: [] });
      lifecycleStore.__testReset({ phase: 'researching', startedAt: 0 });

      ui = renderFeature(<Sidebar width={30} />);
      const firstFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      const firstSpinnerFrame = spinnerFrames()[0] ?? '';

      expect(firstFrame).toContain(`${firstSpinnerFrame} Spec`);
      expect(firstFrame).toContain('0:00');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      const nextFrame = stripAnsiStyles(ui.lastFrame() ?? '');
      expect(nextFrame).toContain(`${firstSpinnerFrame} Spec`);
      expect(nextFrame).toContain('0:01');
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
    expect(frame).not.toContain('Spec');

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
    expect(frame).not.toContain('Spec');

    ui.unmount();
  });

  it('keeps footer cost and status visible when the task list is long', async () => {
    const tasks = Array.from({ length: 40 }, (_value, index) =>
      task(String(index + 1), index % 2 === 0 ? 'done' : 'pending'),
    );
    tasksStore.__testReset({ tasks });

    const ui = renderFeature(
      <Box height={10}>
        <Sidebar width={32} />
      </Box>,
    );
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('20/40');
    expect(frame).toContain('standard');
    expect(frame).toContain('local');

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
        frame.split('\n').find((line) => /^[ \t]*\|?[ \t]*[-─]+[ \t]*\|?[ \t]*$/u.test(line)) ?? '';

      expect(ruleLine, `footer rule at width ${width}`).not.toBe('');
      expect(
        getTerminalCellWidth(ruleLine),
        `footer rule at width ${width} exceeds the box`,
      ).toBeLessThanOrEqual(width);

      ui.unmount();
    }
  });

  it('keeps the status word for the rare states even at the narrow floor', async () => {
    tasksStore.__testReset({
      tasks: [
        task('1', 'escalated', LONG_TITLE),
        task('2', 'failed', LONG_TITLE),
        task('3', 'skipped', LONG_TITLE),
      ],
    });

    const ui = renderFeature(<Sidebar width={34} />);
    await tick();
    const rows = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.includes('A task title'));

    // A dash against a circle is the whole distinction between skipped and queued, so the states
    // the user has to act on keep their word however narrow the panel gets.
    expect(rows[0]).toContain('escalated');
    expect(rows[1]).toContain('failed');
    expect(rows[2]).toContain('skipped');

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
    tasksStore.__testReset({
      tasks: [task('1', 'done', 'First task'), task('2', 'in_progress', 'Second task')],
      totalTasks: 2,
    });

    const ui = renderFeature(<Sidebar width={40} height={20} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const doneRow = frame.split('\n').find((line) => line.includes('First task')) ?? '';
    const activeRow = frame.split('\n').find((line) => line.includes('Second task')) ?? '';

    expect(doneRow).toContain(glyph('check'));
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
    const first = renderFeature(<Sidebar width={40} height={16} />);
    await tick();
    const firstRow =
      stripAnsiStyles(first.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes(sharedTitle.slice(0, 12))) ?? '';
    first.unmount();

    tasksStore.__testReset({ tasks: makeTasks(10), totalTasks: 12 });
    const second = renderFeature(<Sidebar width={40} height={16} />);
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
    expect(titleColumn('Spec')).toBe(titleColumn('No tasks yet'));
    ui.unmount();

    tasksStore.__testReset({ tasks: [task('1', 'in_progress', 'A real title')] });
    const populated = renderFeature(<Sidebar width={34} />);
    await tick();
    const populatedTitle = (
      stripAnsiStyles(populated.lastFrame() ?? '')
        .split('\n')
        .find((line) => line.includes('A real title')) ?? ''
    ).indexOf('A real title');

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
    expect(frame).toContain('standard');
    expect(frame).toContain('local');
    expect(lines.length).toBeLessThanOrEqual(15);

    ui.unmount();
  });
});

describe('Sidebar — unbudgeted height', () => {
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

    const ui = renderFeature(<Sidebar width={40} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Reviewer');
    expect(frame).toContain('GPT-5 Codex');
    ui.unmount();
  });
});
