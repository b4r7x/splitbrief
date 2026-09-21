import { afterEach, describe, expect, it } from 'vitest';
import { runBriefQualityGate, runBriefQualityWithRepair } from './brief-quality-gate.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeMessage, makeStateWithQueue, setupProject } from '#testing/helpers/queue.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { formatTasks } from '../../spec/formatter.js';
import { readQueueForPrompt } from '../queue/drain.js';
import { enqueueUserMessage } from '../queue/submit.js';

const completeTask = {
  id: 'T001',
  tests: ['validates email format with regex'],
  implementationSteps: ['1. Add validateEmail function'],
  scope: { inBounds: ['email validation'], outOfBounds: ['UI changes'] },
  evidence: ['test coverage shows > 90%'],
};

describe('runBriefQualityGate', () => {
  it('passes a task whose only defect is a warning', () => {
    const result = runBriefQualityGate({
      tasks: [makeTask({ ...completeTask, typeDefs: '' })],
      projectDir: process.cwd(),
    });

    expect(result.report.issues).toEqual([
      expect.objectContaining({ code: 'missing_type_definitions', severity: 'warning' }),
    ]);
    expect(result).toMatchObject({ errorCount: 0, warningCount: 1, ok: true });
  });

  it('blocks on error issues and attributes every issue to its task', () => {
    const result = runBriefQualityGate({
      tasks: [makeTask({ id: 'T001' })],
      projectDir: process.cwd(),
    });

    expect(result.report.issues.map((issue) => issue.code)).toEqual([
      'missing_scope',
      'missing_evidence',
      'missing_type_definitions',
    ]);
    expect(result.report.issues.every((issue) => issue.taskId === 'T001')).toBe(true);
    expect(result).toMatchObject({ errorCount: 2, warningCount: 1, ok: false });
  });
});

describe('runBriefQualityWithRepair', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  function startPausedRepair() {
    const { projectDir, sessionId } = setupProject(dirs);
    const ref = { projectDir, sessionId };
    const state = {
      ...makeStateWithQueue([{ ...makeMessage('use JWT'), id: 'msg-a' }]),
      phase: 'planning' as const,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();

    let prompt = '';
    let started: () => void = () => {};
    const reviewStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (outcome: { text: string } | Error) => void = () => {};
    const reviewFinished = new Promise<{ text: string } | Error>((resolve) => {
      finish = resolve;
    });
    const planner = makePlanner({
      review: async (seen: string) => {
        prompt = seen;
        started();
        const outcome = await reviewFinished;
        if (outcome instanceof Error) throw outcome;
        return { text: outcome.text, usage: null };
      },
    });

    const running = runBriefQualityWithRepair({
      tasks: [makeTask(completeTask)],
      state,
      planner,
      projectDir,
      sessionId,
      callbacks: makeCallbacks().callbacks,
      bus,
      metadata: TEST_METADATA,
      maxRetries: 0,
    });

    const enqueueB = async () => {
      await reviewStarted;
      const enqueued = enqueueUserMessage({
        projectDir,
        sessionId,
        state,
        text: 'also add refresh tokens',
        phase: 'planning',
        bus,
      });
      if (enqueued.message === undefined) throw new Error('expected B to be queued');
      return enqueued.message.id;
    };

    return { ref, events, running, enqueueB, finish, prompt: () => prompt };
  }

  it('acknowledges only the queued input its regeneration applied', async () => {
    const { ref, events, running, enqueueB, finish, prompt } = startPausedRepair();

    const bId = await enqueueB();
    finish({ text: formatTasks([makeTask(completeTask)]) });
    const result = await running;

    expect(prompt()).toContain('use JWT');
    expect(prompt()).not.toContain('also add refresh tokens');
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
      expect.objectContaining({ count: 1, ids: ['msg-a'] }),
    ]);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted.map((message) => [message.id, message.drainedAt !== undefined])).toEqual([
      ['msg-a', true],
      [bId, false],
    ]);
    const next = readQueueForPrompt({ ...ref, state: result.state });
    expect(next.messages.map((message) => message.id)).toEqual([bId]);
  });

  it('acknowledges neither message when the regeneration fails', async () => {
    const { ref, events, running, enqueueB, finish } = startPausedRepair();

    const bId = await enqueueB();
    finish(new Error('planner failed'));
    await expect(running).rejects.toThrow('planner failed');

    expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
    const persisted = loadState(ref)?.messageQueue ?? [];
    expect(persisted.every((message) => message.drainedAt === undefined)).toBe(true);
    const state = loadState(ref);
    if (state === null) throw new Error('expected persisted workflow state');
    const next = readQueueForPrompt({ ...ref, state });
    expect(next.messages.map((message) => message.id)).toEqual(['msg-a', bId]);
  });
});
