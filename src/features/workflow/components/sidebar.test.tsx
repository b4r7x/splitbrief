import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { glyph } from '../../../lib/glyphs.js';
import { configStore } from '../../../stores/project/config.js';
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
    expect(frame).toContain('2 local');
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

  it('names both runner models on the role line, color-coded by role', async () => {
    tasksStore.__testReset({ tasks: [task('1', 'done')] });

    const ui = renderFeature(<Sidebar width={60} />);
    await tick();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('planner claude-code');
    expect(frame).toContain('impl');
    expect(frame).toContain('Qwen 2.5 Coder 7B');
    expect(frame).toContain(glyph('connectorHandoff'));

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
