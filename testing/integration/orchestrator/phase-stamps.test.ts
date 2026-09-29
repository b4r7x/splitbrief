import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createRunnerCallRecorder } from '../../../src/engine/calls/recorder.js';
import { createStdoutTextSink } from '../../../src/engine/events/sinks/stdout-text.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type {
  EscalateOptions,
  PlannerOutputCallbacks,
  RunPhaseInput,
} from '../../../src/engine/planners/types.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

/** A planner call as a CLI planner makes it: its own event stream, then its text. */
function plannerCall(callbacks: PlannerOutputCallbacks, callId: string, text: string): void {
  const call = createRunnerCallRecorder({
    context: { callId, role: 'planner', backendKind: 'cli', runnerName: 'claude-code' },
    onEvent: callbacks.onCallEvent,
  });
  call.text({ channel: 'assistant', text });
  callbacks.onOutput(text);
  call.finishCompleted();
}

/**
 * The canary's escalated brief: validation fails, the local retry fails, the planner's hint call
 * answers, and the hinted retry lands. Every event it publishes names the phase the run is in.
 */
async function runEscalatedBrief(): Promise<EngineEvent[]> {
  const projectDir = createTempDir('orch-int-phase-stamps');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir);
  const targetFile = 'src/loop.ts';
  const task = makeTask({
    id: 'T001',
    action: 'create',
    file: targetFile,
    title: 'Create the retry-validated module',
    description: 'Create a module that needs planner hint escalation before validation passes.',
    implementationSteps: ['Create src/loop.ts with the retry marker export.'],
    tests: ['node validate.mjs passes after hint escalation'],
    scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
    evidence: ['tier-1 escalation event appears before workflow_complete'],
    typeDefs: 'export const loop: string',
  });
  const writeLoop = (dir: string, marker: string): void => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, targetFile), `export const loop = "${marker}";\n`, 'utf-8');
  };
  const events: EngineEvent[] = [];

  await runWorkflow({
    prepared: makePreparedExecution({
      projectDir,
      sessionId: 'sess-phase-stamps',
      feature: 'escalate one brief',
      config: makeConfig({
        implementer: { kind: 'agent', command: 'node', model: 'cheap-direct-agent' },
        validation: { typecheck: false, lint: false, test: true, testCommand: 'node validate.mjs' },
        workflow: { mode: 'quick', approve: 'none', maxRetries: 1 },
      }),
    }),
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    _planner: makePlanner({
      runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
        makePhaseCallResult({ call, ...(call === 'tasks' ? { tasks: [task] } : {}) }),
      ),
      escalateHint: vi.fn(async (opts: EscalateOptions) => {
        const hint = 'VERDICT: answer\nUse the from-retry marker validate.mjs expects.';
        plannerCall(opts.callbacks, 'escalation-1', hint);
        return { success: true, output: hint, code: null, usage: null };
      }),
      review: vi.fn(async (_prompt: string, _dir: string, callbacks: PlannerOutputCallbacks) => {
        const review = '### Verdict\npass\n\n### Findings\n- **Critical**: None.';
        plannerCall(callbacks, 'review-1', review);
        return { text: review, usage: null };
      }),
    }),
    _implementer: makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn(async (opts: ImplementerOptions) => {
        writeLoop(opts.projectDir, 'from-initial');
        return { success: true, output: 'created' };
      }),
      retry: vi.fn(async (opts: RetryOptions) => {
        opts.onOutput(`${opts.kind} retry`);
        if (opts.kind === 'local') {
          return { success: false, output: '', error: 'still the initial marker' };
        }
        writeLoop(opts.projectDir, 'from-retry');
        return { success: true, output: 'fixed' };
      }),
    }),
    _eventSink: (event) => events.push(event),
  });
  return events;
}

// The state machine's own path for this brief: the local retry runs in implementing, the hint
// call, the hinted retry and its validation in escalating, and the brief passes into implementing.
const PHASES = [
  'planning',
  'implementing',
  'validating-task',
  'implementing',
  'escalating',
  'implementing',
  'final-review',
  'complete',
];

describe('the phase an escalated brief publishes', { timeout: 90_000 }, () => {
  it('prints one plain phase line per transition', async () => {
    const events = await runEscalatedBrief();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const sink = createStdoutTextSink({ output });
    for (const event of events) sink(event);

    const phaseLines = chunks
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('phase: '));

    expect(phaseLines).toEqual(PHASES.map((phase) => `phase: ${phase}`));
  });

  it('moves the TUI lifecycle phase once per transition', async () => {
    const events = await runEscalatedBrief();
    const trace: string[] = [];
    for (const event of events) {
      addEvent(event);
      const { phase } = lifecycleStore.get();
      if (phase !== trace.at(-1)) trace.push(phase);
    }

    expect(trace).toEqual(PHASES);
  });
});
