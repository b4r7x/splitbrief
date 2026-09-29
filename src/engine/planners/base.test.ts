import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlannerBase } from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Planner, PlannerCapabilities } from './types.js';
import type { RunnerCallEvent } from '../calls/types.js';

let projectDir: string;

const minimalTask = makeTask();

const defaultCapabilities: PlannerCapabilities = {
  supportsConversationalPlanning: false,
  supportsHintEscalation: true,
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

describe('createPlannerBase — hintSuccessMode', () => {
  it('hintSuccessMode: "files" — succeeds when files are written', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => {
        writeFileSync(outFile, '// written by escalation');
        return completedRunnerCall('');
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — fails when no files are written', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "text" (default) — succeeds when text is non-empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall('some hint output'),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "text" (default) — fails when text is empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('capabilities.supportsHintEscalation: false — always returns success: false', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall('lots of output'),
      isAvailable: async () => true,
      capabilities: {
        supportsConversationalPlanning: false,
        supportsHintEscalation: false,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "files" — ignores pre-existing dirty files (before/after snapshot)', async () => {
    const preExisting = join(projectDir, 'pre-existing.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    const newFile = join(projectDir, 'new-from-hint.ts');
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => {
        writeFileSync(newFile, '// written by hint');
        return completedRunnerCall('');
      },
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    // The new file is what triggered success — pre-existing dirty file is baseline, not a signal
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — not success when only pre-existing dirty files remain', async () => {
    const preExisting = join(projectDir, 'pre-existing-only.ts');
    writeFileSync(preExisting, '// dirty before escalation');

    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint({
      task: minimalTask,
      error: 'error',
      projectDir,
      callbacks: { onOutput: () => {} },
    });
    expect(result.success).toBe(false);
  });
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
      invokeEscalate: async () => completedRunnerCall(JSON.stringify(structured)),
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
      invokeEscalate: async (opts) => {
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
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async (opts) => {
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
    });
  });
});

describe('createPlannerBase — regenerate', () => {
  it('leads a revision issued with the conversation so far with that conversation', async () => {
    const prompts: string[] = [];
    const planner = createPlannerBase({
      invokePlan: async ({ prompt }) => {
        prompts.push(prompt);
        return completedRunnerCall('# Spec\n\nRevised.\n');
      },
      invokeEscalate: async () => completedRunnerCall(''),
      isAvailable: async () => true,
      capabilities: defaultCapabilities,
    });

    await planner.regenerate({
      prompt: 'Regenerate the spec.',
      projectDir,
      callbacks: { onOutput: () => {} },
      priorMessages: [{ role: 'user', content: 'The export must be named PERIWINKLE-42.' }],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('<!-- prior conversation -->');
    expect(prompts[0]).toContain('[user] The export must be named PERIWINKLE-42.');
    expect(prompts[0]?.endsWith('Regenerate the spec.')).toBe(true);
  });
});

describe('createPlannerBase — a seat out of quota', () => {
  // Captured live from `agy -p` on 2026-09-21: the first limit hit exits 0 with nothing on stdout.
  const AGY_LIMIT =
    'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)';

  it.each([
    [
      'hint',
      (planner: Planner) =>
        planner.escalateHint({
          task: minimalTask,
          error: 'error',
          projectDir,
          callbacks: { onOutput: () => {} },
        }),
    ],
    [
      'summary',
      (planner: Planner) =>
        planner.summarize([{ role: 'user', text: 'compact this' }], { projectDir }),
    ],
  ])('fails the %s call with the limit instead of reading it as silence', async (_call, run) => {
    const planner = createPlannerBase({
      invokePlan: async () => completedRunnerCall(''),
      invokeEscalate: async () =>
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

    await expect(run(planner)).rejects.toMatchObject({
      kind: 'runner-call-failed',
      data: { status: 'failed', error: { code: 'usage-limit', message: AGY_LIMIT } },
    });
  });
});
