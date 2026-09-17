import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../stores/project/config.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
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

/** A brief on its second attempt, with a six-figure count the block would once have rounded. */
function seedRunningAttemptTokens(): void {
  tokensStore.__testReset({
    localCount: 1,
    perTask: {
      T002: {
        totalTokens: 148_000,
        title: 'Two',
        attempts: [
          { method: 'local', retryCount: 0, implementerTokens: 24_000, escalationTokens: 0 },
          { method: 'local', retryCount: 1, implementerTokens: 124_000, escalationTokens: 0 },
        ],
      },
    },
  });
}

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

  it('names no token count for a brief whose attempt booked one', () => {
    seedRunningAttemptTokens();

    for (const cols of [120, 80, 60]) {
      const ui = renderFeature(<BuildProgressBlock cols={cols} />);
      const frame = ui.lastFrame() ?? '';

      expect(frame).toContain('1/3 briefs passed');
      expect(frame).toContain('implementing');
      expect(frame).not.toMatch(/token/i);
      expect(frame).not.toContain('124k');
      expect(frame).not.toContain('0k');

      ui.unmount();
    }
  });
});
