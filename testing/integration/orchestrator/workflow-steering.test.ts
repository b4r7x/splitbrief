import { plainUserMessage } from '../../../src/core/types/user-input.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';
import {
  guidanceConsult,
  passingReviewVerdict,
  planFromTasks,
  NO_REVIEW_CHECKS,
} from '#testing/helpers/typed-planner.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import {
  createInitialState,
  transition,
  briefCorrections,
} from '../../../src/core/state/machine.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import { appendMessage } from '../../../src/core/sessions/log-writer.js';
import type { Phase } from '../../../src/core/schemas/enums.js';
import type {
  RunningCall,
  SteeringPort,
  SteerOutcome,
} from '../../../src/engine/calls/steering.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import type {
  PlannerSummaryOptions,
  TypedCallContext,
} from '../../../src/engine/planners/types.js';
import type { WorkflowSinks } from '../../../src/engine/orchestrator/types.js';
import { settleMidCallDeliveries } from '../../../src/engine/orchestrator/queue/mid-call.js';

const dirs: string[] = [];
afterEach(async () => {
  await settleTrackedWorkflows();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function runSteeredWorkflow(opts: { outcome: SteerOutcome; retryToConsult?: boolean }) {
  const projectDir = createTempDir('workflow-steering');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const ref = { projectDir, sessionId: 'steering-run' };
  ensureSessionDir(projectDir, ref.sessionId);
  const active = reactivateExistingSession(ref);
  const feature = 'Keep the greeting API';
  const task = makeTask({ id: 'T003', tests: [] });
  const plan = planFromTasks([task]);
  const config = makeNoValidationConfig({
    workflow: {
      approve: 'none',
      isolation: 'none',
      compactionThreshold: 10,
      compactionFormat: 'freeform',
    },
    codebase: { enabled: false, tokenBudget: 4000 },
  });
  const savedState = opts.retryToConsult
    ? transition(createInitialState(feature), { type: 'START' })
    : undefined;
  if (savedState !== undefined) {
    saveState(ref, savedState);
    for (let index = 0; index < 12; index += 1) {
      appendMessage(ref, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        phase: savedState.phase,
        text: `Earlier turn ${index}`,
      });
    }
  }

  const events: EngineEvent[] = [];
  const ports: SteeringPort[] = [];
  const sent: Array<{ callId: string; id: string; text: string }> = [];
  const helperContexts: TypedCallContext[] = [];
  const summaryContexts: Array<PlannerSummaryOptions | undefined> = [];
  const buildCalls: ImplementerOptions[] = [];
  const plannerPrompts: string[] = [];
  let installedHandler: Parameters<WorkflowSinks['setQueueHandler']>[0] = null;
  let planTurn = 0;
  let buildAttempt = 0;

  async function foreground(input: {
    steering: SteeringPort | undefined;
    role: RunningCall['role'];
    callId: string;
    phase: Phase;
    outcome?: SteerOutcome;
    queue?: boolean;
  }): Promise<void> {
    if (input.steering === undefined) throw new Error(`No steering port on ${input.callId}`);
    const port = input.steering;
    ports.push(port);
    const detach = port.attach({
      callId: input.callId,
      role: input.role,
      taskId: input.role === 'implementer' ? task.id : null,
      send: async (message) => {
        sent.push({ callId: input.callId, ...message });
        return input.outcome ?? 'delivered';
      },
    });
    try {
      if (input.queue !== false) {
        const submitted = await installedHandler?.(
          plainUserMessage(`Correction for ${input.callId}`),
          input.phase,
        );
        if (submitted?.status !== 'accepted') throw new Error(`Queue rejected ${input.callId}`);
        await settleMidCallDeliveries(ref);
      }
    } finally {
      detach();
    }
  }

  const planner = makePlanner();
  planner.capabilities.supportsSelfSummarisation = true;
  planner.summarize = async (_messages, context) => {
    summaryContexts.push(context);
    return { text: 'Earlier planning context', usage: null };
  };
  planner.typedCall = (ctx) => ({
    seat: ctx.seat,
    typedOutput: 'strict-native',
    canResume: false,
    invoke: async ({ prompt, schema }) => {
      if (schema?.name === 'consult_answer') {
        helperContexts.push(ctx);
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify(guidanceConsult('Write the greeting module.')),
        });
      }
      plannerPrompts.push(prompt);
      planTurn += 1;
      await foreground({
        steering: ctx.callbacks.steering,
        role: 'planner',
        callId: `plan-${planTurn}`,
        phase: 'researching',
      });
      const result =
        planTurn === 1
          ? {
              kind: 'questions',
              questions: [
                { id: 'q1', text: 'Which module?', choices: null, default: 'src/hello.ts' },
              ],
            }
          : planTurn === 2
            ? {
                ...plan,
                criteria: [
                  ...plan.criteria,
                  { id: 'C2', text: 'Keep the API', checkIds: ['T003-K1'] },
                ],
              }
            : plan;
      return makeRunnerCallResult({ status: 'completed', text: JSON.stringify({ result }) });
    },
  });

  const reviewer = {
    review: planner.review,
    typedCall: (ctx: TypedCallContext) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native' as const,
      canResume: false,
      invoke: async ({
        prompt,
        schema,
      }: Parameters<ReturnType<typeof planner.typedCall>['invoke']>[0]) => {
        if (schema?.name === 'review_checks') {
          helperContexts.push(ctx);
          return makeRunnerCallResult({
            status: 'completed',
            text: JSON.stringify(NO_REVIEW_CHECKS),
          });
        }
        await foreground({
          steering: ctx.callbacks.steering,
          role: 'review',
          callId: 'review-verdict',
          phase: 'final-review',
        });
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify(passingReviewVerdict(prompt)),
        });
      },
    }),
  };

  async function build(options: ImplementerOptions) {
    buildCalls.push(options);
    buildAttempt += 1;
    const correctionPass = !opts.retryToConsult && buildAttempt > 1;
    await foreground({
      steering: options.steering,
      role: 'implementer',
      callId: `build-${buildAttempt}`,
      phase: options.phase ?? 'implementing',
      outcome: opts.retryToConsult ? 'delivered' : opts.outcome,
      queue: !correctionPass,
    });
    if (opts.retryToConsult && buildAttempt < 3)
      return { success: false, output: 'The greeting module is missing.' };
    mkdirSync(join(options.projectDir, 'src'), { recursive: true });
    writeFileSync(
      join(options.projectDir, 'src/hello.ts'),
      'export const hello = () => "hello";\n',
    );
    return { success: true, output: 'Wrote the greeting module.' };
  }

  const summary = await runTrackedWorkflow({
    prepared: makePreparedExecution({
      ...ref,
      active,
      config,
      feature,
      ...(savedState !== undefined && { resumeState: savedState }),
    }),
    callbacks: makeCallbacks({ onPlannerReply: async () => plainUserMessage('') }).callbacks,
    sinks: {
      setAbortHandler: () => {},
      setQueueHandler: (handler) => {
        installedHandler = handler;
      },
    },
    _eventSink: (event) => {
      events.push(event);
    },
    _planner: planner,
    _reviewer: reviewer,
    _implementer: makeImplementer({
      implement: build,
      retry: build,
      capabilities: { writesFiles: 'direct' },
    }),
  });
  return {
    ref,
    task,
    summary,
    events,
    ports,
    sent,
    helperContexts,
    summaryContexts,
    buildCalls,
    plannerPrompts,
  };
}

describe('workflow steering through real phases', () => {
  it.each(['delivered', 'deferred', 'uncertain'] as const)(
    'routes messages to PLAN, BUILD and REVIEW, BUILD outcome = %s',
    async (outcome) => {
      const run = await runSteeredWorkflow({ outcome });
      expect(run.summary).toMatchObject({ totalTasks: 1, failed: 0 });
      const state = loadState(run.ref);
      expect(state?.reviewStatus).toBe('passed');
      expect(readFileSync(join(run.ref.projectDir, 'src/hello.ts'), 'utf8')).toContain(
        'export const hello',
      );
      expect(run.ports.length).toBe(outcome === 'delivered' ? 5 : 6);
      expect(new Set(run.ports).size).toBe(1);
      expect(run.ports[0]?.current()).toBeNull();
      expect(run.sent.map(({ callId }) => callId)).toEqual([
        'plan-1',
        'plan-2',
        'plan-3',
        'build-1',
        'review-verdict',
      ]);
      const attached = run.events.filter((event) => event.type === 'steerable_call');
      expect(attached.map(({ seat, taskId }) => ({ seat, taskId }))).toEqual([
        { seat: 'plan', taskId: undefined },
        { seat: undefined, taskId: undefined },
        { seat: 'plan', taskId: undefined },
        { seat: undefined, taskId: undefined },
        { seat: 'plan', taskId: undefined },
        { seat: undefined, taskId: undefined },
        { seat: 'build', taskId: 'T003' },
        { seat: undefined, taskId: undefined },
        ...(outcome === 'delivered'
          ? []
          : [
              { seat: 'build', taskId: 'T003' },
              { seat: undefined, taskId: undefined },
            ]),
        { seat: 'review', taskId: undefined },
        { seat: undefined, taskId: undefined },
      ]);
      const drains = run.events.filter((event) => event.type === 'queue_drained');
      expect(drains.map(({ seat, taskId, via, count }) => ({ seat, taskId, via, count }))).toEqual([
        { seat: 'plan', taskId: undefined, via: 'mid-call', count: 1 },
        { seat: 'plan', taskId: undefined, via: 'mid-call', count: 1 },
        { seat: 'plan', taskId: undefined, via: 'mid-call', count: 1 },
        {
          seat: 'build',
          taskId: 'T003',
          via: outcome === 'delivered' ? 'mid-call' : undefined,
          count: 1,
        },
        { seat: 'review', taskId: undefined, via: 'mid-call', count: 1 },
      ]);
      expect(run.buildCalls).toHaveLength(outcome === 'delivered' ? 1 : 2);
      expect(
        state?.messageQueue.find((message) => message.text === 'Correction for build-1'),
      ).toMatchObject({
        ...(outcome === 'delivered' && { deliveredMidCall: true }),
        ...(outcome === 'uncertain' && { possibleDuplicate: true }),
      });
      if (state === null) throw new Error('Missing saved state');
      const corrections = briefCorrections(state, run.task.id);
      expect(corrections).toHaveLength(1);
      expect(corrections[0]).toContain('Correction for build-1');
      if (outcome !== 'delivered') {
        expect(run.buildCalls[1]?.continuation?.steer).toContain('Correction for build-1');
        if (outcome === 'uncertain')
          expect(run.buildCalls[1]?.continuation?.steer).toContain(
            'You may have seen this message already during your last call:',
          );
      }
      expect(run.plannerPrompts[1]).not.toContain('Correction for plan-1');
      expect(run.plannerPrompts[2]).not.toContain('Correction for plan-2');
    },
  );

  it('keeps retries steerable and leaves consult and summarize without the port', async () => {
    const run = await runSteeredWorkflow({ outcome: 'delivered', retryToConsult: true });
    expect(run.summary).toMatchObject({ totalTasks: 1, failed: 0 });
    expect(loadState(run.ref)?.reviewStatus).toBe('passed');
    expect(run.buildCalls).toHaveLength(3);
    expect(run.sent.map(({ callId }) => callId)).toEqual([
      'plan-1',
      'plan-2',
      'plan-3',
      'build-1',
      'build-2',
      'build-3',
      'review-verdict',
    ]);
    expect(new Set(run.ports).size).toBe(1);
    expect(run.summaryContexts).toHaveLength(1);
    expect(run.summaryContexts[0]).not.toHaveProperty('steering');
    expect(run.summaryContexts[0]?.callbacks).not.toHaveProperty('steering');
    expect(run.helperContexts).toHaveLength(1);
    expect(run.helperContexts[0]?.callbacks).not.toHaveProperty('steering');
    expect(run.buildCalls[1]?.continuation?.steer).toContain('Correction for build-1');
    expect(run.buildCalls[2]?.continuation?.steer).toContain('Correction for build-2');
  });
});
