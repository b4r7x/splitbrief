import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { TASKS_FILE } from '../../../core/paths.js';
import { runPlanningPhase } from './run.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'quick',
} as const;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('quick-planning-test');
  dirs.push(projectDir);
  const sessionId = 'sess-quick';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('runQuickPlanning', () => {
  it('cancels when the planner returns zero tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [{ text: '# empty', filename: TASKS_FILE }],
      }),
    });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'quick' } });
    const { bus, events } = makeBusRecorder();

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        metadata: TEST_METADATA,
        bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      },
      planner,
      state: createInitialState('feature'),
      feature: 'feature',
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toHaveLength(0);
    expect(events.find((event) => event.type === 'plan_approved')).toBeUndefined();
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      message: expect.stringContaining('quick planner returned zero tasks'),
    });
  });
});
