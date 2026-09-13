import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { BuildProgressBlock } from './build-progress.js';

beforeEach(() => {
  resetAllStores();
  configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
  lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
  tasksStore.__testReset({
    totalTasks: 3,
    currentAttempt: 1,
    tasks: [
      { id: 'T001', title: 'One', status: 'done' },
      { id: 'T002', title: 'Two', status: 'in_progress' },
      { id: 'T003', title: 'Three', status: 'pending' },
    ],
  });
});

afterEach(() => {
  resetAllStores();
});

describe('BuildProgressBlock', () => {
  it('states the counts, the attempt and why there is no ETA', () => {
    const ui = renderFeature(<BuildProgressBlock cols={120} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('1/3 briefs passed');
    expect(frame).toContain('attempt 1 of');
    expect(frame).toContain('ETA unavailable: no brief finished yet');

    ui.unmount();
  });

  it('spreads the same facts over more rows when the terminal is narrow', () => {
    const ui = renderFeature(<BuildProgressBlock cols={60} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(5);

    ui.unmount();
  });
});
