import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { formatTasks } from '../../spec/formatter.js';
import { regeneratePlanAndTasks, regenerateTasks } from './regen.js';
import type { WorkflowSinks } from '../types.js';

let dirs: string[] = [];

function makeSinks(): WorkflowSinks & { trigger: () => boolean; hasHandler: () => boolean } {
  let abortHandler: (() => void) | null = null;
  return {
    setAbortHandler: (h) => {
      abortHandler = h;
    },
    setQueueHandler: () => {},
    hasHandler: () => abortHandler !== null,
    trigger: () => {
      if (!abortHandler) return false;
      abortHandler();
      return true;
    },
  };
}

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('regen-test');
  dirs.push(projectDir);
  const sessionId = 'sess-regen';
  ensureSessionDir(projectDir, sessionId);
  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nDraft.\n', null);
  writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nDraft.\n', null);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function planningStateWithQueuedMessage() {
  let state = createInitialState('feature');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  return {
    ...state,
    messageQueue: [
      {
        id: 'queued-1',
        text: 'include retry handling in regenerated briefs',
        queuedAt: new Date().toISOString(),
        phase: 'planning' as const,
        deliveredViaNative: false,
        nativeDeliveryState: 'pending' as const,
        origin: 'user-input' as const,
      },
    ],
  };
}

describe('regeneratePlanAndTasks', () => {
  it('leaves queued feedback pending when task regeneration fails after plan regeneration', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan\n\nRegenerated.\n', usage: null })
        .mockRejectedValueOnce(new Error('task regeneration failed')),
    });

    await expect(
      regeneratePlanAndTasks({
        projectDir,
        sessionId,
        planner,
        callbacks,
        bus,
        state: planningStateWithQueuedMessage(),
        metadata: TEST_METADATA,
      }),
    ).rejects.toThrow('task regeneration failed');

    const saved = loadState({ projectDir, sessionId });
    expect(saved?.messageQueue[0]?.drainedAt).toBeUndefined();
    expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
  });

  it('commits queued feedback after plan and task regeneration both succeed', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan\n\nRegenerated.\n', usage: null })
        .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null }),
    });

    const result = await regeneratePlanAndTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state: planningStateWithQueuedMessage(),
      metadata: TEST_METADATA,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(events.some((event) => event.type === 'queue_drained' && event.count === 1)).toBe(true);
  });
});

describe('regenerateTasks', () => {
  it('compiles the prompt from the tasks.md on disk, not the stale in-memory state.tasks', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();

    const onDisk = makeTask({ id: 'T001', title: 'Disk version of the brief' });
    const stale = makeTask({ id: 'T001', title: 'Stale in-memory brief' });
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks([onDisk]), TEST_METADATA);

    let seenPrompt = '';
    const planner = makePlanner({
      review: async (prompt: string) => {
        seenPrompt = prompt;
        return { text: formatTasks([onDisk]), usage: null };
      },
    });

    const state = { ...createInitialState('feat'), tasks: [stale] };

    await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      metadata: TEST_METADATA,
    });

    expect(seenPrompt).toContain('Disk version of the brief');
    expect(seenPrompt).not.toContain('Stale in-memory brief');
  });

  it('falls back to state.tasks when tasks.md is absent on disk', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();

    const inMemory = makeTask({ id: 'T001', title: 'Only-in-memory brief' });

    let seenPrompt = '';
    const planner = makePlanner({
      review: async (prompt: string) => {
        seenPrompt = prompt;
        return { text: formatTasks([inMemory]), usage: null };
      },
    });

    const state = { ...createInitialState('feat'), tasks: [inMemory] };

    await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      metadata: TEST_METADATA,
    });

    expect(seenPrompt).toContain('Only-in-memory brief');
  });

  it('warns on the bus when regenerated Task Briefs contain an unknown ### section (F-429 / N399)', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();

    const regeneratedWithUnknownSection = `${REAL_TASKS_MD}
### Future Considerations

- this heading is outside the canonical grammar and will be dropped
`;
    const planner = makePlanner({
      review: async () => ({ text: regeneratedWithUnknownSection, usage: null }),
    });

    const state = createInitialState('feat');

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus,
      state,
      metadata: TEST_METADATA,
    });

    expect(result.tasks).toHaveLength(1);
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.includes('Future Considerations'),
    );
    expect(warning).toBeDefined();
  });

  it('an abort during regeneration review parks the retry prompt instead of failing', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const sinks = makeSinks();
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'retry with more detail',
    });

    const regenerated = makeTask({ id: 'T001', title: 'Regenerated brief' });
    const prompts: string[] = [];
    const planner = makePlanner({
      review: async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          sinks.trigger();
          throw new Error('aborted');
        }
        return { text: formatTasks([regenerated]), usage: null };
      },
    });

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state: createInitialState('feat'),
      metadata: TEST_METADATA,
      sinks,
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('retry with more detail');
    expect(result.tasks).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn_interrupted')).toHaveLength(1);
  });
});
