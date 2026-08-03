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
    expect(frame).toContain('2 Local');
    expect(frame).toContain('1 Escalated');

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

  it('keeps canonical runner metadata visible and bounded on a narrow role line', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done')] });

    const ui = renderFeature(<Sidebar width={60} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    const runnerLine = frame.split('\n').find((line) => line.includes('Planner')) ?? '';

    expect(runnerLine).toContain('Planner Claude Code CLI');
    expect(runnerLine).toContain('Implementer');
    expect(runnerLine).toContain('Qwen 2.5 Coder');
    expect(runnerLine).toContain('…');
    expect(runnerLine).toContain(glyph('connectorHandoff'));
    expect(getTerminalCellWidth(runnerLine)).toBeLessThanOrEqual(60);

    ui.unmount();
  });

  it('shows the waiting placeholder while a stage runs with no tasks', async () => {
    tasksStore.__testReset({ tasks: [] });
    lifecycleStore.__testReset({ phase: 'researching', startedAt: Date.now() - 65_000 });

    const ui = renderFeature(<Sidebar width={30} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('No tasks yet');
    expect(frame).toContain('Planner is working');
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
    expect(frame).not.toContain('Planner is working');

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
    expect(frame).not.toContain('Planner is working');
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
    expect(frame).toContain('Local');

    ui.unmount();
  });
});
