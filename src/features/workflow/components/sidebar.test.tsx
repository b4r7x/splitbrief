import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../stores/project/config.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import type { WorkflowTask } from '../../../stores/workflow/tasks.js';
import { Sidebar } from './sidebar.js';

function task(id: string, status: WorkflowTask['status']): WorkflowTask {
  return { id, title: `task ${id}`, status };
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
});
