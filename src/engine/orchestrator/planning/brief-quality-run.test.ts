import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { error } from '../../../utils/error.js';
import { addUsageAndSave } from '../state-ops.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  TEST_METADATA,
  makeBriefQualityFailureTask,
  makePassingTask,
  setupProject,
} from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { formatTasks } from '../../spec/formatter.js';
import { runBriefQuality } from './brief-quality-run.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

function makeInput(tasks = [makePassingTask()]) {
  const { projectDir, sessionId } = setupProject(dirs);
  const { callbacks } = makeCallbacks();
  const { bus, events } = makeBusRecorder();
  const planner = makePlanner();
  const state = { ...createInitialState('feature'), phase: 'reviewing-plan' as const };
  const wctx = makeWctx({
    projectDir,
    sessionId,
    callbacks,
    bus,
    metadata: TEST_METADATA,
    planner,
  });

  return { projectDir, sessionId, state, planner, wctx, events, tasks };
}

describe('runBriefQuality', () => {
  it('returns a successful preparation without a terminal planning result', async () => {
    const input = makeInput();

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result).toMatchObject({ ok: true, state: input.state, tasks: input.tasks });
    if (!result.ok) return;
    expect(result.report.passed).toBe(true);
    expect(input.events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('turns a failed quality report into a terminal planning failure', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const input = makeInput([invalidTask]);
    vi.mocked(input.planner.review).mockResolvedValue({
      text: formatTasks([invalidTask]),
      usage: null,
    });

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({ cancelled: true, failed: true, tasks: [] });
    expect(result.result.state.phase).toBe('idle');
    expect(input.events.some((event) => event.type === 'error')).toBe(true);
  });

  it('converts a thrown repair into the same terminal planning result', async () => {
    const input = makeInput([makeBriefQualityFailureTask()]);
    vi.mocked(input.planner.review).mockRejectedValue(new Error('repair failed'));

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({ cancelled: true, failed: true, tasks: [] });
    const failure = input.events.find((event) => event.type === 'error');
    expect(failure?.type === 'error' && failure.message).toContain('repair failed');
  });

  it('preserves abort semantics while converting an aborted repair', async () => {
    const input = makeInput([makeBriefQualityFailureTask()]);
    vi.mocked(input.planner.review).mockRejectedValue(
      error('operation-aborted', 'workflow-rewind'),
    );

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({ cancelled: true, failed: false });
    expect(input.events.some((event) => event.type === 'error')).toBe(false);
  });

  it('rebases terminal failure on the latest persisted usage state', async () => {
    const input = makeInput([makeBriefQualityFailureTask()]);
    saveState({ projectDir: input.projectDir, sessionId: input.sessionId }, input.state);
    vi.mocked(input.planner.review).mockRejectedValue(new Error('repair failed after usage'));

    addUsageAndSave(
      {
        projectDir: input.projectDir,
        sessionId: input.sessionId,
        bus: input.wctx.bus,
      },
      input.state,
      'planner',
      { inputTokens: 19, outputTokens: 7 },
    );

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.state.tokenUsage).toMatchObject({
      plannerInput: 19,
      plannerOutput: 7,
    });
    expect(
      loadState({ projectDir: input.projectDir, sessionId: input.sessionId })?.tokenUsage,
    ).toMatchObject({
      plannerInput: 19,
      plannerOutput: 7,
    });
  });
});
