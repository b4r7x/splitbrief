import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import {
  TEST_METADATA,
  makePassingPlanner,
  setupProject,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('runBriefsApprovalLoop failure boundaries', () => {
  it('fails closed when the approval prompt throws instead of prompting forever', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const onApprovalNeeded = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runBriefsApprovalLoop({
      tasks: [],
      planner: makePassingPlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: { ...createInitialState('feature'), phase: 'reviewing-briefs' },
      config: makeConfig({ workflow: { mode: 'standard', approve: 'none' } }),
      metadata: TEST_METADATA,
    });

    expect(result).toMatchObject({ outcome: 'failed' });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
