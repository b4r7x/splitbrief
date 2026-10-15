import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPlannerBase } from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { PlannerCapabilities } from './types.js';
import type { RunnerCallEvent } from '../calls/types.js';

let projectDir: string;

const defaultCapabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsSessionResume: false,
  supportsEffort: false,
  supportsImages: false,
  supportsSelfSummarisation: false,
};

function completedRunnerCall(text: string) {
  return makeRunnerCallResult({ status: 'completed', text });
}

beforeEach(() => {
  projectDir = createTempDir('planner-base-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createPlannerBase — structured summarization', () => {
  it('validates structured summary JSON from the planner', async () => {
    const structured = {
      goal: 'add compaction',
      stepsCompleted: ['wrote schema'],
      currentStep: 'testing',
      filesModified: ['src/core/schemas/compaction.ts'],
      constraintsDiscovered: ['return JSON only'],
      remainingWork: ['run tests'],
    };
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot: async () => completedRunnerCall(JSON.stringify(structured)),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.summarizeStructured?.([{ role: 'user', text: 'compact this' }], {
      projectDir,
    });

    expect(result).toEqual({ text: JSON.stringify(structured), structured, usage: null });
  });

  it('uses the merge prompt when a previous structured summary is provided', async () => {
    const previous = {
      goal: 'add compaction',
      stepsCompleted: ['old step'],
      currentStep: 'old current',
      filesModified: ['old.ts'],
      constraintsDiscovered: ['old constraint'],
      remainingWork: ['old work'],
    };
    let prompt = '';
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot: async (opts) => {
        prompt = opts.prompt;
        return completedRunnerCall(JSON.stringify(previous));
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.([{ role: 'assistant', text: 'new work' }], {
      previousSummary: previous,
      projectDir,
    });

    expect(prompt).toContain('Previous summary:');
    expect(prompt).toContain(JSON.stringify(previous));
    expect(prompt).toContain('New messages:');
  });

  it('passes signal and runner-call callbacks to structured summary invocations', async () => {
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const structured = {
      goal: 'add compaction',
      stepsCompleted: ['old step'],
      currentStep: 'testing',
      filesModified: ['src/core/schemas/compaction.ts'],
      constraintsDiscovered: ['return JSON only'],
      remainingWork: ['run tests'],
    };
    let capturedSignal: AbortSignal | undefined;
    const planner = createPlannerBase({
      runnerName: 'codex',
      model: 'gpt-5',
      axes: ['high'],
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot: async (opts) => {
        capturedSignal = opts.signal;
        opts.callbacks.onCallEvent?.({ type: 'call_started', ts: Date.now(), ...opts.callContext });
        return completedRunnerCall(JSON.stringify(structured));
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.summarizeStructured?.([{ role: 'user', text: 'compact this' }], {
      projectDir,
      signal: controller.signal,
      callbacks: { onCallEvent: (event) => events.push(event) },
      role: 'compaction',
    });

    expect(capturedSignal).toBe(controller.signal);
    expect(events[0]).toMatchObject({
      type: 'call_started',
      role: 'compaction',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5',
      axes: ['high'],
    });
  });
});

describe('createPlannerBase — typedCall', () => {
  it('defaults typedOutput to fallback and canResume to the resume capability', () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: { ...defaultCapabilities, supportsSessionResume: true },
    });

    const call = planner.typedCall({
      projectDir: '/p',
      callbacks: { onOutput: () => {} },
      seat: 'reviewer',
    });

    expect(call.seat).toBe('reviewer');
    expect(call.typedOutput).toBe('fallback');
    expect(call.canResume).toBe(true);
  });

  it('reports the configured typedOutput capability', () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      typedOutput: 'native',
    });

    const call = planner.typedCall({
      projectDir: '/p',
      callbacks: { onOutput: () => {} },
      seat: 'planner',
    });

    expect(call.typedOutput).toBe('native');
  });

  it('routes a review schema call to the stateless backend', async () => {
    const invokePlan = vi.fn(async () => completedRunnerCall(''));
    const invokeOneShot = vi.fn(async () => completedRunnerCall(''));
    const planner = createPlannerBase({
      invokePlan,
      invokeOneShot,
      runnerName: 'codex',
      model: 'gpt-5',
      axes: ['high'],
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });
    const schema = { json: { type: 'object' }, name: 'probe' };

    await planner
      .typedCall({ projectDir: '/p', callbacks: { onOutput: () => {} }, seat: 'reviewer' })
      .invoke({ prompt: 'q', schema });

    expect(invokeOneShot).toHaveBeenCalledTimes(1);
    expect(invokeOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'q',
        schema,
        callContext: expect.objectContaining({
          role: 'review',
          runnerName: 'codex',
          model: 'gpt-5',
          axes: ['high'],
        }),
      }),
    );
    expect(invokePlan).not.toHaveBeenCalled();
  });

  it('routes a first planner schema call to the planner thread', async () => {
    const invokePlan = vi.fn(async () => completedRunnerCall(''));
    const invokeOneShot = vi.fn(async () => completedRunnerCall(''));
    const planner = createPlannerBase({
      invokePlan,
      invokeOneShot,
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });
    const schema = { json: { type: 'object' }, name: 'probe' };

    await planner
      .typedCall({ projectDir: '/p', callbacks: { onOutput: () => {} }, seat: 'planner' })
      .invoke({ prompt: 'q', schema });

    expect(invokePlan).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'q', schema }));
    expect(invokeOneShot).not.toHaveBeenCalled();
  });

  it('hands a planning session its attachments on the planner thread', async () => {
    const invokePlan = vi.fn(async () => completedRunnerCall(''));
    const planner = createPlannerBase({
      invokePlan,
      invokeOneShot: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: { ...defaultCapabilities, supportsImages: true },
    });
    const images = [
      { id: 'a', kind: 'image' as const, path: '/tmp/a.png', mimeType: 'image/png', sizeBytes: 1 },
    ];

    await planner
      .typedCall({ projectDir: '/p', callbacks: { onOutput: () => {} }, seat: 'planner', images })
      .invoke({ prompt: 'q' });

    expect(invokePlan).toHaveBeenCalledWith(expect.objectContaining({ images }));
  });

  it('leads a planning call on a fresh session with the conversation so far', async () => {
    const invokePlan = vi.fn(async () => completedRunnerCall(''));
    const planner = createPlannerBase({
      invokePlan,
      invokeOneShot: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner
      .typedCall({
        projectDir: '/p',
        callbacks: { onOutput: () => {} },
        seat: 'planner',
        priorMessages: [{ role: 'user', content: 'Name the export PERIWINKLE-42.' }],
      })
      .invoke({ prompt: 'q' });

    expect(invokePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(/PERIWINKLE-42[\s\S]*q$/),
      }),
    );
  });

  it('carries the typed call role into the stateless call context', async () => {
    const invokeOneShot = vi.fn(async () => completedRunnerCall(''));
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot,
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner
      .typedCall({ projectDir: '/p', callbacks: { onOutput: () => {} }, seat: 'reviewer' })
      .invoke({ prompt: 'q' });

    expect(invokeOneShot).toHaveBeenCalledWith(
      expect.objectContaining({ callContext: expect.objectContaining({ role: 'review' }) }),
    );
  });
});

describe('createPlannerBase — a seat out of quota', () => {
  // Captured live from `agy -p` on 2026-09-21: the first limit hit exits 0 with nothing on stdout.
  const AGY_LIMIT =
    'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)';

  it('fails the summary call with the limit instead of reading it as silence', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeOneShot: async () =>
        makeRunnerCallResult({
          status: 'completed',
          text: '',
          warnings: [
            {
              code: 'stderr_diagnostic',
              severity: 'warning',
              source: 'stderr',
              surface: 'status',
              channel: 'stderr',
              fingerprint: 'stderr-diagnostic',
              message: AGY_LIMIT,
            },
          ],
        }),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await expect(
      planner.summarize([{ role: 'user', text: 'compact this' }], { projectDir }),
    ).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: { status: 'failed', error: { code: 'usage-limit', message: AGY_LIMIT } },
    });
  });
});
