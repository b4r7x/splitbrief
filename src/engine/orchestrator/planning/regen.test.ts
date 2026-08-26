import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ensureSessionDir, readSpecFile, writeSpecFile } from '../../../core/paths-io.js';
import { PLAN_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestSinks, REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { formatTasks } from '../../spec/formatter.js';
import { createEventBus } from '../../events/bus.js';
import { regeneratePlanAndTasks, regenerateTasks } from './regen.js';

let dirs: string[] = [];

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
  it('rejects an invalid plan replacement before writing, publishing, or prompting for tasks', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const previousPlan = readSpecFile({ projectDir, sessionId }, PLAN_FILE);
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({
        text: 'planner prose without an artifact heading',
        usage: { inputTokens: 17, outputTokens: 9 },
      }),
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
    ).rejects.toMatchObject({ kind: 'planning-invalid-artifact' });

    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(readSpecFile({ projectDir, sessionId }, PLAN_FILE)).toBe(previousPlan);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted).not.toBeNull();
    if (persisted === null) throw new Error('expected usage state to be persisted');
    expect(persisted.tokenUsage).toMatchObject({ plannerInput: 17, plannerOutput: 9 });
  });

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
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Prior Task Briefs\n\nUnchanged.\n',
      TEST_METADATA,
    );
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
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
    expect(
      events.filter((event) => event.type === 'artifact_written').map((event) => event.filename),
    ).toEqual([PLAN_FILE]);
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
  });
});

describe('regenerateTasks', () => {
  it('binds the recovery provider call to the supplied epoch, operation, and request identity', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const dispatch = vi.fn().mockResolvedValue({
      kind: 'completed',
      requestId: 'request-expected',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      text: REAL_TASKS_MD,
      providerCode: null,
      usage: null,
    });
    const planner = makePlanner();

    const result = await regenerateTasks({
      projectDir,
      sessionId,
      planner,
      callbacks: makeCallbacks().callbacks,
      bus: createEventBus(),
      state: createInitialState('feature'),
      metadata: TEST_METADATA,
      briefRecovery: {
        epochId: 'epoch-expected',
        operationId: 'operation-expected',
        requestId: 'request-expected',
        provider: { dispatch },
      },
    });

    expect(result.tasks).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        epochId: 'epoch-expected',
        operationId: 'operation-expected',
        requestId: 'request-expected',
      }),
    );
    expect(planner.review).not.toHaveBeenCalled();
  });

  it('preserves the paid operation identity when malformed regenerated output fails parsing', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const dispatch = vi.fn().mockResolvedValue({
      kind: 'completed',
      requestId: 'request-malformed',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      text: '---\nid: T001\n---\n',
      providerCode: null,
      usage: { inputTokens: 11, outputTokens: 5 },
    });
    const planner = makePlanner();

    await expect(
      regenerateTasks({
        projectDir,
        sessionId,
        planner,
        callbacks: makeCallbacks().callbacks,
        bus: createEventBus(),
        state: createInitialState('feature'),
        metadata: TEST_METADATA,
        briefRecovery: {
          epochId: 'epoch-malformed',
          operationId: 'operation-malformed',
          requestId: 'request-malformed',
          provider: { dispatch },
        },
      }),
    ).rejects.toThrow('Invalid task block');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      epochId: 'epoch-malformed',
      operationId: 'operation-malformed',
      requestId: 'request-malformed',
    });
    expect(planner.review).not.toHaveBeenCalled();
  });

  it('compiles the prompt from the tasks.md on disk, not the stale in-memory state.tasks', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();

    const onDisk = makeTask({ id: 'T001', title: 'Disk version of the brief' });
    const stale = makeTask({ id: 'T001', title: 'Stale in-memory brief' });
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, formatTasks([onDisk]), TEST_METADATA);
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);

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
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
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
    expect(existsSync(join(sessionDir(projectDir, sessionId), TASKS_FILE))).toBe(false);
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
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('persists planner usage when strict Task Brief parsing rejects a replacement', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    writeSpecFile(
      { projectDir, sessionId },
      TASKS_FILE,
      '# Prior Task Briefs\n\nUnchanged.\n',
      TEST_METADATA,
    );
    const priorTasksBytes = readSpecFile({ projectDir, sessionId }, TASKS_FILE);
    const malformedTaskLikeBlock = `---
id: T002
title:
action: invalid
file:
depends_on: []
---

### Description
This replacement must fail strict parsing.
`;
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({
        text: malformedTaskLikeBlock,
        usage: { inputTokens: 31, outputTokens: 7 },
      }),
    });

    await expect(
      regenerateTasks({
        projectDir,
        sessionId,
        planner,
        callbacks: makeCallbacks().callbacks,
        bus,
        state: createInitialState('feat'),
        metadata: TEST_METADATA,
      }),
    ).rejects.toMatchObject({ kind: 'parse-tasks-invalid-block' });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted).not.toBeNull();
    if (persisted === null) throw new Error('expected usage state to be persisted');
    expect(persisted.tokenUsage).toMatchObject({ plannerInput: 31, plannerOutput: 7 });
    expect(readSpecFile({ projectDir, sessionId }, TASKS_FILE)).toBe(priorTasksBytes);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('an abort during regeneration review parks the retry prompt instead of failing', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const sinks = createTestSinks();
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'retry with more detail',
    });

    const regenerated = makeTask({ id: 'T001', title: 'Regenerated brief' });
    const prompts: string[] = [];
    const planner = makePlanner({
      review: async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          sinks.abortTurn();
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
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });
});
