import { describe, it, expect, afterEach } from 'vitest';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState } from '../../core/state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import {
  buildContinuationPrompt,
  withContinuationLoop,
  type ContinuationLoopCtx,
} from './continuation.js';
import type { WorkflowSinks } from './types.js';

function makeSinks(): WorkflowSinks & { trigger: () => boolean; hasHandler: () => boolean } {
  let abortHandler: (() => void) | null = null;
  return {
    setAbortHandler: (h) => { abortHandler = h; },
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

describe('buildContinuationPrompt', () => {
  it('combines partial output with the user message', () => {
    const prompt = buildContinuationPrompt('half-written spec', 'add auth section');
    expect(prompt).toContain('half-written spec');
    expect(prompt).toContain('add auth section');
    expect(prompt).toContain('interrupted');
  });

  it('falls back to a default instruction when the user message is blank', () => {
    const prompt = buildContinuationPrompt('partial', '   ');
    expect(prompt).toContain('partial');
    expect(prompt).toContain('continue from where you left off');
  });
});

describe('withContinuationLoop', () => {
  it('returns the body value on happy path and leaves awaitingContinue false', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');
    const ctx: ContinuationLoopCtx = { projectDir, sessionId, callbacks, sinks };

    const result = await withContinuationLoop<number>({
      ctx,
      state,
      body: async () => ({ value: 42 }),
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
    const seenContinuationPrompts: (string | undefined)[] = [];

    const result = await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, sinks },
      state,
      body: async ({ signal, continuationPrompt, recordOutput }) => {
        attempt += 1;
        seenContinuationPrompts.push(continuationPrompt);

        if (attempt === 1) {
          recordOutput('partial-output-1');
          // Body is expected to honour abort — simulate by throwing after sink abort trigger.
          sinks.trigger();
          if (signal.aborted) throw new Error('aborted');
        }
        return { value: 'ok' };
      },
    });

    expect(result.value).toBe('ok');
    expect(attempt).toBe(2);
    expect(seenContinuationPrompts[0]).toBeUndefined();
    expect(seenContinuationPrompts[1]).toBeDefined();
    expect(seenContinuationPrompts[1]).toContain('partial-output-1');
    expect(seenContinuationPrompts[1]).toContain('please finish it');
    expect(userReplies).toEqual(['partial-output-1']);
    // CONTINUE_TURN was the last transition — the loop exited with awaitingContinue = false.
    expect(result.state.awaitingContinue).toBe(false);
  });

  it('continues when body returns continueIfAborted=true and the per-call signal aborted', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks({
      onContinuationNeeded: async () => 'keep going',
    });
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    let attempt = 0;
    const result = await withContinuationLoop<string>({
      ctx: { projectDir, sessionId, callbacks, sinks },
      state,
      body: async ({ signal, recordOutput }) => {
        attempt += 1;
        if (attempt === 1) {
          recordOutput('first try');
          sinks.trigger();
          expect(signal.aborted).toBe(true);
          return { value: 'failure-that-should-retry', continueIfAborted: true };
        }
        return { value: 'final-success' };
      },
    });

    expect(attempt).toBe(2);
    expect(result.value).toBe('final-success');
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
        ctx: { projectDir, sessionId, callbacks, sinks },
        state,
        body: async () => { throw err; },
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
        ctx: { projectDir, sessionId, callbacks, sinks, signal: outer.signal },
        state,
        body: async ({ signal }) => {
          sinks.trigger();
          expect(signal.aborted).toBe(true);
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });

  it('clears the abort handler sink on normal completion and on rethrow', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { callbacks } = makeCallbacks();
    const sinks = makeSinks();
    const state: WorkflowState = createInitialState('feat');

    await withContinuationLoop<number>({
      ctx: { projectDir, sessionId, callbacks, sinks },
      state,
      body: async () => ({ value: 1 }),
    });
    expect(sinks.hasHandler()).toBe(false);

    callbacks.onContinuationNeeded = undefined;
    await expect(
      withContinuationLoop<number>({
        ctx: { projectDir, sessionId, callbacks, sinks },
        state,
        body: async () => { throw new Error('boom'); },
      }),
    ).rejects.toThrow('boom');
    expect(sinks.hasHandler()).toBe(false);
  });
});
