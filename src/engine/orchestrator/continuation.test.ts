import { describe, it, expect, afterEach } from 'vitest';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import { taskId } from '../../core/schemas/task.js';
import { createInitialState } from '../../core/state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from '../../core/paths-io.js';
import { STATE_FILE } from '../../core/paths.js';
import {
  createContinuationHolder,
  readInterruptedPartial,
  withContinuationLoop,
  type ContinuationLoopCtx,
} from './continuation.js';
import { composeContinuation } from '../spec/prompts/continuation.js';
import { appendMessage } from '../../core/sessions/log-writer.js';
import { createEventBus } from '../events/bus.js';
import { processError } from '../../lib/process/errors.js';
import type { WorkflowSinks } from './types.js';

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

let dirs: string[] = [];

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('continuation-test');
  dirs.push(projectDir);
  const sessionId = 'sess-continue';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('readInterruptedPartial', () => {
  it('returns the last interrupted flush and ignores completed messages', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const ref = { projectDir, sessionId };
    appendMessage(ref, { role: 'assistant', text: 'an older cut', interrupted: true });
    appendMessage(ref, { role: 'assistant', text: 'a finished call' });
    appendMessage(ref, { role: 'assistant', text: 'the cut attempt', interrupted: true });

    expect(await readInterruptedPartial(ref)).toBe('the cut attempt');
  });

  it('is absent when nothing was ever cut', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    appendMessage({ projectDir, sessionId }, { role: 'assistant', text: 'a finished call' });

    expect(await readInterruptedPartial({ projectDir, sessionId })).toBeUndefined();
  });
});

describe('createContinuationHolder', () => {
  it('hands the seed to the step it was recorded at, once', () => {
    const holder = createContinuationHolder({
      step: { kind: 'planner', call: 'spec' },
      partial: 'half a spec',
      steer: 'shorter',
    });

    expect(holder.take({ kind: 'planner', call: 'spec' })).toEqual({
      partial: 'half a spec',
      steer: 'shorter',
    });
    expect(holder.take({ kind: 'planner', call: 'spec' })).toBeUndefined();
  });

  it('withholds a brief seed from another task, kind, or attempt', () => {
    const holder = createContinuationHolder({
      step: { kind: 'brief', taskId: taskId('T001'), attempt: 2 },
      partial: 'half a brief',
    });

    expect(holder.take({ kind: 'brief', taskId: taskId('T002'), attempt: 2 })).toBeUndefined();
    expect(holder.take({ kind: 'planner', call: 'tasks' })).toBeUndefined();
    // A reset attempt of the same brief is a fresh try, not this partial's resume:
    // the ladder cleared attempt 2 back to 0, so the mid-step partial no longer applies.
    expect(holder.take({ kind: 'brief', taskId: taskId('T001'), attempt: 0 })).toBeUndefined();
    expect(holder.take({ kind: 'brief', taskId: taskId('T001'), attempt: 2 })).toEqual({
      partial: 'half a brief',
    });
  });

  it('holds a steer for the step a boundary park stopped before', () => {
    const holder = createContinuationHolder();
    holder.hold({ kind: 'brief', taskId: taskId('T002'), attempt: 0 }, 'use the new helper');

    expect(holder.take({ kind: 'brief', taskId: taskId('T002'), attempt: 0 })).toEqual({
      steer: 'use the new helper',
    });
  });

  it('holds nothing when the operator continued without words', () => {
    const holder = createContinuationHolder();
    holder.hold({ kind: 'brief', taskId: taskId('T002'), attempt: 0 }, undefined);

    expect(holder.take({ kind: 'brief', taskId: taskId('T002'), attempt: 0 })).toBeUndefined();
  });
});

const PLANNER_STEP: StepRef = { kind: 'planner', call: 'research' };

describe('withContinuationLoop', () => {
  it('returns the body value on happy path and leaves awaitingContinue false', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');
    const ctx: ContinuationLoopCtx = {
      projectDir,
      sessionId,
      callbacks,
      bus: createEventBus(),
      sinks,
    };

    const result = await withContinuationLoop<number>({
      ctx,
      state,
      step: PLANNER_STEP,
      body: async () => 42,
    });

    expect(result.value).toBe(42);
    expect(result.state.awaitingContinue).toBe(false);
  });

  it('enters continuation mode when body throws with per-call signal aborted, then re-runs with a continuation prompt', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const userReplies: string[] = [];
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async (partial) => {
        userReplies.push(partial);
        return 'please finish it';
      },
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    let attempt = 0;
    const seenPartials: (string | undefined)[] = [];
    const seenSteers: (string | undefined)[] = [];

    const result = await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
      state,
      step: PLANNER_STEP,
      body: async ({ signal, partial, steer, recordOutput }) => {
        attempt += 1;
        seenPartials.push(partial);
        seenSteers.push(steer);

        if (attempt === 1) {
          recordOutput('partial-output-1');
          // Body is expected to honour abort — simulate by throwing after sink abort trigger.
          sinks.trigger();
          if (signal.aborted) throw new Error('aborted');
        }
        return 'ok';
      },
    });

    expect(result.value).toBe('ok');
    expect(attempt).toBe(2);
    expect(seenPartials[0]).toBeUndefined();
    expect(seenPartials[1]).toBe('partial-output-1');
    expect(seenSteers[1]).toBe('please finish it');
    expect(userReplies).toEqual(['partial-output-1']);
    // RESUME_STEP was the last transition — the loop exited with the park cleared.
    expect(result.state.awaitingContinue).toBe(false);
  });

  it('an aborted call never proceeds as success even when the runner exits cleanly', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'keep going',
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    let attempt = 0;
    const result = await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
      state,
      step: PLANNER_STEP,
      body: async ({ signal, recordOutput }) => {
        attempt += 1;
        if (attempt === 1) {
          recordOutput('first try');
          sinks.trigger();
          expect(signal.aborted).toBe(true);
          return 'clean-exit-from-killed-runner';
        }
        return 'final-success';
      },
    });

    expect(attempt).toBe(2);
    expect(result.value).toBe('final-success');
  });

  it('a pending boundary interrupt parks at the next call boundary', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    let pending = true;
    const sinks = {
      ...makeSinks(),
      consumeBoundaryInterrupt: () => {
        const wasPending = pending;
        pending = false;
        return wasPending;
      },
    };
    const partials: string[] = [];
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async (partial) => {
        partials.push(partial);
        return 'steer this way';
      },
    });
    const state: WorkflowState = createInitialState('feat');

    const prompts: string[] = [];
    const result = await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
      state,
      step: PLANNER_STEP,
      body: async ({ partial, steer }) => {
        prompts.push(composeContinuation({ basePrompt: 'the primary prompt', partial, steer }));
        return 'done';
      },
    });

    expect(result.value).toBe('done');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('steer this way');
    expect(prompts[0]).toContain('the primary prompt');
    expect(partials).toEqual(['']);
    expect(result.state.awaitingContinue).toBe(false);
  });

  it('a parked boundary interrupt preserves the primary prompt', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const state: WorkflowState = createInitialState('feat');

    const runParked = async (reply: string) => {
      let pending = true;
      const sinks = {
        ...makeSinks(),
        consumeBoundaryInterrupt: () => {
          const wasPending = pending;
          pending = false;
          return wasPending;
        },
      };
      const { callbacks } = makeCallbacks({ onContinuationNeeded: async () => reply });
      const bodyArgs: { partial: string | undefined; steer: string | undefined }[] = [];
      const prompts: string[] = [];
      await withContinuationLoop<string>({
        ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
        state,
        step: PLANNER_STEP,
        body: async ({ partial, steer }) => {
          bodyArgs.push({ partial, steer });
          prompts.push(
            partial === undefined && steer === undefined
              ? 'PRIMARY PROMPT'
              : composeContinuation({ basePrompt: 'PRIMARY PROMPT', partial, steer }),
          );
          return 'done';
        },
      });
      return { bodyArgs, prompts };
    };

    const emptyEnter = await runParked('');
    expect(emptyEnter.bodyArgs).toEqual([{ partial: undefined, steer: undefined }]);
    expect(emptyEnter.prompts).toEqual(['PRIMARY PROMPT']);

    const steered = await runParked('focus on the auth module');
    expect(steered.bodyArgs[0]?.partial).toBeUndefined();
    expect(steered.prompts[0]).toContain('focus on the auth module');
    expect(steered.prompts[0]).toContain('PRIMARY PROMPT');
  });

  it('an outer-signal abort while parked skips the RESUME_STEP save', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const outer = new AbortController();
    let resolvePrompt: (text: string) => void = () => {};
    let promptOpened: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      promptOpened = resolve;
    });
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: () => {
        promptOpened();
        return new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        });
      },
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    const loop = withContinuationLoop<string>({
      ctx: {
        projectDir,
        sessionId,
        callbacks,
        bus: createEventBus(),
        sinks,
        signal: outer.signal,
      },
      state,
      step: PLANNER_STEP,
      body: async ({ signal }) => {
        sinks.trigger();
        if (signal.aborted) throw new Error('aborted');
        return 'never';
      },
    });

    await parked;
    outer.abort(new Error('workflow rewound'));
    resolvePrompt('resume anyway');

    await expect(loop).rejects.toThrow('workflow rewound');
    const statePath = join(projectDir, '.splitbrief', 'sessions', sessionId, STATE_FILE);
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      awaitingContinue?: boolean;
      interruptedStep?: { step: StepRef; source: string };
    };
    expect(saved.awaitingContinue).toBe(true);
    expect(saved.interruptedStep?.step).toEqual(PLANNER_STEP);
    expect(saved.interruptedStep?.source).toBe('user');
  });

  it('a command-idle-timeout failure routes to the continuation prompt', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'retry please',
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    let attempt = 0;
    const result = await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, bus, sinks },
      state,
      step: PLANNER_STEP,
      body: async ({ signal, partial, steer, recordOutput }) => {
        attempt += 1;
        if (attempt === 1) {
          recordOutput('silent partial');
          expect(signal.aborted).toBe(false);
          throw processError.idleTimeout({ command: 'opencode', idleMs: 300_000 });
        }
        expect(partial).toContain('silent partial');
        expect(steer).toBe('retry please');
        return 'recovered';
      },
    });

    expect(attempt).toBe(2);
    expect(result.value).toBe('recovered');
    expect(events.filter((e) => e.type === 'turn_interrupted')[0]).toMatchObject({
      source: 'watchdog',
    });
  });

  it('continueAfterAbort publishes turn_interrupted', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const publishedBeforePrompt: boolean[] = [];
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => {
        publishedBeforePrompt.push(events.some((e) => e.type === 'turn_interrupted'));
        return 'go on';
      },
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    let attempt = 0;
    await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, bus, sinks },
      state,
      step: PLANNER_STEP,
      body: async ({ signal }) => {
        attempt += 1;
        if (attempt === 1) {
          sinks.trigger();
          if (signal.aborted) throw new Error('aborted');
        }
        return 'ok';
      },
    });

    expect(publishedBeforePrompt).toEqual([true]);
    const interrupted = events.filter((e) => e.type === 'turn_interrupted');
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ source: 'user' });
  });

  it('propagates a non-abort throw immediately when no continuation handler is set', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    // Explicitly remove the default handler — this variant models a planner error path.
    callbacks.onContinuationNeeded = undefined;
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    const err = new Error('planner exploded');
    await expect(
      withContinuationLoop<number>({
        ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
        state,
        step: PLANNER_STEP,
        body: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });

  it('propagates abort-throws without entering continuation when the outer signal is also aborted', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks({ onContinuationNeeded: async () => 'never' });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');
    const outer = new AbortController();
    outer.abort();

    const err = new Error('aborted');
    await expect(
      withContinuationLoop<number>({
        ctx: {
          projectDir,
          sessionId,
          callbacks,
          bus: createEventBus(),
          sinks,
          signal: outer.signal,
        },
        state,
        step: PLANNER_STEP,
        body: async ({ signal }) => {
          sinks.trigger();
          expect(signal.aborted).toBe(true);
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });

  it('persists continuation transitions through persistRef when execution cwd differs', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const stagedDir = createTempDir('continuation-staged');
    dirs.push(stagedDir);
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'resume',
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    let attempt = 0;
    await withContinuationLoop<string>({
      ctx: {
        projectDir: stagedDir,
        sessionId,
        persistRef: { projectDir, sessionId },
        callbacks,
        bus: createEventBus(),
        sinks,
      },
      state,
      step: PLANNER_STEP,
      body: async ({ signal, recordOutput }) => {
        attempt += 1;
        if (attempt === 1) {
          recordOutput('partial');
          sinks.trigger();
          if (signal.aborted) throw new Error('aborted');
        }
        return 'done';
      },
    });

    const realStatePath = join(projectDir, '.splitbrief', 'sessions', sessionId, STATE_FILE);
    const stagedStatePath = join(stagedDir, '.splitbrief', 'sessions', sessionId, STATE_FILE);
    expect(existsSync(realStatePath)).toBe(true);
    expect(existsSync(stagedStatePath)).toBe(false);
    const saved = JSON.parse(readFileSync(realStatePath, 'utf8')) as {
      awaitingContinue?: boolean;
      interruptedStep?: unknown;
    };
    expect(saved.awaitingContinue).toBe(false);
    expect(saved.interruptedStep).toBeUndefined();
  });

  it('clears the abort handler sink on normal completion and on rethrow', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    await withContinuationLoop<number>({
      ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
      state,
      step: PLANNER_STEP,
      body: async () => 1,
    });
    expect(sinks.hasHandler()).toBe(false);

    callbacks.onContinuationNeeded = undefined;
    await expect(
      withContinuationLoop<number>({
        ctx: { projectDir, sessionId, callbacks, bus: createEventBus(), sinks },
        state,
        step: PLANNER_STEP,
        body: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(sinks.hasHandler()).toBe(false);
  });
});
