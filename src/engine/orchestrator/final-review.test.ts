import { plainUserMessage } from '../../core/types/user-input.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeMessage, setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { createEvidenceLedger } from '../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { hashTaskBrief } from '../../core/evidence/brief-hash.js';
import { loadState } from '../../core/state/persistence.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { isQueuedMessagePendingReviewer } from '../../core/queue-state.js';
import { createQueueHandler, enqueueUserMessage } from './queue/submit.js';
import { createWriteSequencer } from './serial-executor.js';
import { runFinalReviewPhase } from './final-review.js';
import { createContinuationHolder } from './continuation.js';
import { createSteeringPort } from '../calls/steering.js';
import type { TypedCallContext } from '../planners/types.js';
import { settleMidCallDeliveries, trackMidCallDelivery } from './queue/mid-call.js';
import { transitionAndSave } from './state-ops.js';

const git = vi.hoisted(() => ({ beforeStatus: undefined as (() => void) | undefined }));

vi.mock('simple-git', () => ({
  simpleGit: () => ({
    raw: async () => '',
    diff: async () => '',
    status: async () => {
      const beforeStatus = git.beforeStatus;
      git.beforeStatus = undefined;
      beforeStatus?.();
      return { files: [], not_added: [] };
    },
  }),
}));

const dirs: string[] = [];

afterEach(() => {
  git.beforeStatus = undefined;
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

function setupReview(kind: 'cli' | 'api') {
  const ref = setupProject(dirs);
  mkdirSync(join(ref.projectDir, '.git'));
  const state = makeImplState([makeTask({ id: 'T001', status: 'done' })], {
    phase: 'final-review',
    changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
  });
  writeEvidenceLedger(
    ref,
    createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: state.feature,
      tasks: state.tasks,
      briefHash: hashTaskBrief(state.tasks),
    }),
  );
  const { bus, events } = makeBusRecorder();
  const config = makeNoValidationConfig({
    reviewer:
      kind === 'cli'
        ? { kind: 'cli', tool: 'claude-code' }
        : {
            kind: 'api',
            provider: 'custom-endpoint',
            apiBase: 'https://api.example.com/v1',
            model: 'reviewer',
          },
  });
  const enqueue = (text: string) =>
    enqueueUserMessage({
      ...ref,
      state: loadState(ref) ?? state,
      message: plainUserMessage(text),
      phase: 'final-review',
      bus,
    });
  return {
    ...ref,
    workspaceDir: ref.projectDir,
    state,
    config,
    callbacks: makeCallbacks().callbacks,
    bus,
    events,
    enqueue,
  };
}

describe('final review queue delivery', () => {
  it.each([
    { kind: 'cli', withSinks: false },
    { kind: 'cli', withSinks: true },
    { kind: 'api', withSinks: false },
    { kind: 'api', withSinks: true },
  ] as const)(
    'refreshes text and images for the $kind verdict repair with sinks=$withSinks',
    async ({ kind, withSinks }) => {
      const opts = setupReview(kind);
      const message = {
        ...plainUserMessage('Inspect the queued repair image [image:repair-shot]'),
        images: [
          {
            id: 'repair-shot',
            kind: 'image' as const,
            path: '/outside/repair.png',
            mimeType: 'image/png',
            sizeBytes: 5,
          },
        ],
      };
      const contexts: TypedCallContext[] = [];
      const prompts: string[] = [];
      const typedCall = typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt, call) => {
          prompts.push(prompt);
          if (call === 1) {
            enqueueUserMessage({
              ...opts,
              state: loadState(opts) ?? opts.state,
              message,
              phase: 'final-review',
            });
            return 'invalid verdict';
          }
          return passingReviewVerdict(prompt);
        },
      );
      const reviewer = makePlanner({
        typedCall: (ctx) => {
          contexts.push(ctx);
          return typedCall(ctx);
        },
      });

      const result = await runFinalReviewPhase({
        ...opts,
        reviewer,
        ...(withSinks && { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } }),
      });

      expect(result.reviewStatus).toBe('written');
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).not.toContain(message.text);
      expect(prompts[1]).toContain(message.text);
      expect(prompts[1]).toContain('It failed validation:');
      expect(contexts[0]?.images ?? []).toHaveLength(0);
      expect(contexts[1]?.images).toEqual(message.images);
      expect(result.state.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(0);
      expect(loadState(opts)?.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
      expect(opts.events.filter((event) => event.type === 'queue_drained')).toEqual([
        expect.objectContaining({ seat: 'review', count: 1 }),
      ]);
    },
  );

  it.each([false, true])(
    'delivers queued images to the verdict with sinks=%s',
    async (withSinks) => {
      const opts = setupReview('cli');
      const message = {
        ...plainUserMessage('Inspect [image:queue-shot]\n\nPELICAN-42'),
        images: [
          {
            id: 'queue-shot',
            kind: 'image' as const,
            path: '/outside/shot.png',
            mimeType: 'image/png',
            sizeBytes: 5,
          },
        ],
        attachedInputs: [{ kind: 'image' as const, path: '/outside/shot.png' }],
      };
      enqueueUserMessage({ ...opts, message, phase: 'final-review' });
      const contexts: TypedCallContext[] = [];
      const prompts: string[] = [];
      const typedCall = typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt) => {
          prompts.push(prompt);
          return passingReviewVerdict(prompt);
        },
      );
      const reviewer = makePlanner({
        typedCall: (ctx) => {
          contexts.push(ctx);
          return typedCall(ctx);
        },
      });

      const result = await runFinalReviewPhase({
        ...opts,
        reviewer,
        ...(withSinks && { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } }),
      });

      expect(result.reviewStatus).toBe('written');
      expect(prompts[0]).toContain(message.text);
      expect(contexts[0]?.images).toEqual(message.images);
      expect(loadState(opts)?.messageQueue[0]?.images).toEqual(message.images);
    },
  );

  it('uses one task verdict when BUILD owns an arrival during the call', async () => {
    const opts = setupReview('cli');
    const prompts: string[] = [];
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt, call) => {
          prompts.push(prompt);
          if (call === 1)
            enqueueUserMessage({
              ...opts,
              state: loadState(opts) ?? { ...opts.state, phase: 'implementing' },
              message: plainUserMessage('correct the running brief'),
              phase: 'implementing',
            });
          return passingReviewVerdict(prompt);
        },
      ),
    });

    const result = await runFinalReviewPhase({
      ...opts,
      state: { ...opts.state, phase: 'implementing' },
      scope: 'task',
      reviewer,
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(1);
    expect(result.state.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(1);
    expect(opts.events).toContainEqual(
      expect.objectContaining({ type: 'message_queued', seat: 'build' }),
    );
  });

  it('keeps mid-call REVIEW messages in a later verdict prompt with a second arrival', async () => {
    const opts = setupReview('cli');
    const steering = createSteeringPort();
    const prompts: string[] = [];
    let state: WorkflowState = {
      ...opts.state,
      messageQueue: [
        {
          ...makeMessage('old review history'),
          deliveredTo: { reviewer: new Date().toISOString() },
        },
      ],
    };
    const handler = createQueueHandler({
      ...opts,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      planner: makePlanner(),
      steering,
      serialize: createWriteSequencer(),
    });
    const typedCall = typedCallPlanAndReview(
      () => planFromTasks([]),
      (prompt) => {
        prompts.push(prompt);
        return passingReviewVerdict(prompt);
      },
    );
    let calls = 0;
    const reviewer = makePlanner({
      typedCall: (ctx) => {
        const call = typedCall(ctx);
        return {
          ...call,
          invoke: async (input) => {
            if (input.schema?.name === 'review_answer' && ++calls === 1) {
              const detach = steering.attach({
                callId: 'review-live',
                role: 'review',
                taskId: null,
                send: async () => 'delivered',
              });
              expect(
                await handler(plainUserMessage('message received mid-call'), 'final-review'),
              ).toMatchObject({
                status: 'accepted',
              });
              await settleMidCallDeliveries(opts);
              detach();
              expect(
                await handler(plainUserMessage('second pending message'), 'final-review'),
              ).toMatchObject({
                status: 'accepted',
              });
            }
            return call.invoke(input);
          },
        };
      },
    });

    const result = await runFinalReviewPhase({
      ...opts,
      state,
      reviewer,
      steering,
      setTrackedState: (next) => {
        state = next;
      },
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('message received mid-call');
    expect(prompts[1]).toContain('message received mid-call');
    expect(prompts[1]).toContain('second pending message');
    expect(prompts[1]).not.toContain('old review history');
    expect(prompts[1]?.split('message received mid-call')).toHaveLength(2);
  });

  it.each(['before-verdict', 'during-verdict'] as const)(
    'waits for mid-call persistence %s without repeating the delivered message',
    async (when) => {
      const opts = setupReview('cli');
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const prompts: string[] = [];
      const track = () => {
        const queued = opts.enqueue('already read in the live call');
        if (queued.result.status !== 'accepted') throw new Error('Expected an accepted message');
        const id = queued.result.messageId;
        trackMidCallDelivery(
          opts,
          id,
          pending.promise.then(() => {
            transitionAndSave(opts, loadState(opts) ?? opts.state, {
              type: 'DRAIN_QUEUE',
              ids: [id],
              destination: 'reviewer',
            });
          }),
        );
      };
      if (when === 'before-verdict') {
        track();
        opts.bus.subscribe((event) => {
          if (event.type === 'drift_report') started.resolve();
        });
      }
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => {
            prompts.push(prompt);
            if (when === 'during-verdict' && prompts.length === 1) {
              track();
              started.resolve();
            }
            return passingReviewVerdict(prompt);
          },
        ),
      });
      const run = runFinalReviewPhase({ ...opts, reviewer });
      await started.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(prompts).toHaveLength(when === 'before-verdict' ? 0 : 1);
      pending.resolve();
      const result = await run;

      expect(result.reviewStatus).toBe('written');
      expect(prompts).toHaveLength(1);
      if (when === 'before-verdict') expect(prompts[0]).toContain('already read in the live call');
      else expect(prompts[0]).not.toContain('already read in the live call');
      expect(result.state.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
    },
  );

  it.each([false, true])(
    'passes the port only to verdict calls with sinks=%s',
    async (withSinks) => {
      const opts = setupReview('cli');
      const steering = createSteeringPort();
      const contexts: TypedCallContext[] = [];
      const typedCall = typedCallPlanAndReview(() => planFromTasks([]), passingReviewVerdict);
      const reviewer = makePlanner({
        typedCall: (ctx) => {
          contexts.push(ctx);
          return typedCall(ctx);
        },
      });

      const result = await runFinalReviewPhase({
        ...opts,
        steering,
        reviewer,
        ...(withSinks && { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } }),
      });

      expect(result.reviewStatus).toBe('written');
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.callbacks.steering).toBe(steering);
    },
  );

  it.each(['cli', 'api'] as const)(
    'includes pending messages in the %s verdict prompt',
    async (kind) => {
      const opts = setupReview(kind);
      const prompts: string[] = [];
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => {
            prompts.push(prompt);
            return passingReviewVerdict(prompt);
          },
        ),
      });

      const result = await runFinalReviewPhase({
        ...opts,
        state: { ...opts.state, messageQueue: [makeMessage('check timezone handling')] },
        reviewer,
      });

      expect(result.reviewStatus).toBe('written');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('check timezone handling');
      expect(result.state.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
      expect(opts.events).toContainEqual(
        expect.objectContaining({ type: 'queue_drained', seat: 'review' }),
      );
    },
  );

  it.each(['cli', 'api'] as const)(
    'reads arrivals during prompt preparation before the %s verdict',
    async (kind) => {
      const opts = setupReview(kind);
      const prompts: string[] = [];
      opts.bus.subscribe((event) => {
        if (event.type === 'drift_report')
          git.beforeStatus = () => {
            opts.enqueue('check the latest requirement');
          };
      });
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => {
            prompts.push(prompt);
            return passingReviewVerdict(prompt);
          },
        ),
      });

      const result = await runFinalReviewPhase({ ...opts, reviewer });

      expect(result.reviewStatus).toBe('written');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('check the latest requirement');
      expect(result.state.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
    },
  );

  it.each([
    { kind: 'cli', withSinks: false },
    { kind: 'cli', withSinks: true },
    { kind: 'api', withSinks: false },
    { kind: 'api', withSinks: true },
  ] as const)(
    'replaces the $kind verdict after an arrival with sinks=$withSinks',
    async ({ kind, withSinks }) => {
      const opts = setupReview(kind);
      const prompts: string[] = [];
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt, call) => {
            prompts.push(prompt);
            if (call === 1) {
              opts.enqueue('check the missing guard');
              return passingReviewVerdict(prompt);
            }
            return failedReviewVerdict(prompt, 'The guard is missing.');
          },
          { review: { inputTokens: 10, outputTokens: 5 } },
        ),
      });

      const result = await runFinalReviewPhase({
        ...opts,
        reviewer,
        ...(withSinks ? { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } } : {}),
      });

      expect(result.reviewStatus).toBe('written');
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).not.toContain('check the missing guard');
      expect(prompts[1]).toContain('check the missing guard');
      expect(result.verdict?.verdict.findings[0]?.text).toBe('The guard is missing.');
      expect(result.fixWork?.fixTasks).toHaveLength(1);
      expect(result.state.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
      expect(loadState(opts)?.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
      expect(opts.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
      expect(result.state.tokenUsage.reviewerInput).toBe(20);
    },
  );

  it.each(['cli', 'api'] as const)(
    'keeps reviewing %s arrivals until the queue is delivered',
    async (kind) => {
      const opts = setupReview(kind);
      const prompts: string[] = [];
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt, call) => {
            prompts.push(prompt);
            if (call < 3) {
              opts.enqueue(`requirement ${call}`);
              return failedReviewVerdict(prompt, `superseded verdict ${call}`);
            }
            return passingReviewVerdict(prompt);
          },
        ),
      });

      const result = await runFinalReviewPhase({ ...opts, reviewer });

      expect(result.reviewStatus).toBe('written');
      expect(prompts).toHaveLength(3);
      expect(prompts[2]).toContain('requirement 1');
      expect(prompts[2]).toContain('requirement 2');
      expect(result.verdict?.outcome.kind).toBe('pass');
      expect(result.state.messageQueue).toHaveLength(2);
      expect(
        result.state.messageQueue.every((message) => message.deliveredTo?.reviewer !== undefined),
      ).toBe(true);
    },
  );

  it.each([
    { kind: 'cli', withSinks: false, successfulCalls: 0 },
    { kind: 'cli', withSinks: true, successfulCalls: 0 },
    { kind: 'api', withSinks: false, successfulCalls: 0 },
    { kind: 'api', withSinks: true, successfulCalls: 0 },
    { kind: 'cli', withSinks: false, successfulCalls: 1 },
    { kind: 'cli', withSinks: true, successfulCalls: 1 },
    { kind: 'api', withSinks: false, successfulCalls: 1 },
    { kind: 'api', withSinks: true, successfulCalls: 1 },
  ] as const)(
    'halts after exhausted $kind protocol attempts with sinks=$withSinks and $successfulCalls prior verdicts',
    async ({ kind, withSinks, successfulCalls }) => {
      const opts = setupReview(kind);
      const prompts: string[] = [];
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt, call) => {
            prompts.push(prompt);
            if (call <= successfulCalls) {
              opts.enqueue('request another verdict');
              return passingReviewVerdict(prompt);
            }
            if (call === successfulCalls + 1) opts.enqueue('check the pending requirement');
            return call <= successfulCalls + 2 ? 'invalid verdict' : passingReviewVerdict(prompt);
          },
        ),
      });

      const result = await runFinalReviewPhase({
        ...opts,
        reviewer,
        ...(withSinks ? { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } } : {}),
      });

      expect(result.reviewStatus).toBe('failed');
      expect(result.verdict).toBeNull();
      expect(result.fixWork).toBeNull();
      expect(result.failure).toMatchObject({
        kind: 'seat-protocol-error',
        error: { data: { attempts: 2 } },
      });
      expect(prompts).toHaveLength(successfulCalls + 2);
      expect(prompts[successfulCalls + 1]).toContain('check the pending requirement');
      expect(result.state.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(0);
      expect(loadState(opts)?.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(0);
      expect(opts.events.filter((event) => event.type === 'queue_drained')).toHaveLength(
        successfulCalls + 1,
      );
    },
  );

  it.each([
    { kind: 'cli', withSinks: false },
    { kind: 'cli', withSinks: true },
    { kind: 'api', withSinks: false },
    { kind: 'api', withSinks: true },
  ] as const)(
    'keeps arrivals pending when cancellation races with a $kind verdict with sinks=$withSinks',
    async ({ kind, withSinks }) => {
      const opts = setupReview(kind);
      const controller = new AbortController();
      const prompts: string[] = [];
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt, call) => {
            prompts.push(prompt);
            if (call === 1) {
              opts.enqueue('check after resume');
              controller.abort();
            }
            return passingReviewVerdict(prompt);
          },
        ),
      });

      const result = await runFinalReviewPhase({
        ...opts,
        reviewer,
        signal: controller.signal,
        ...(withSinks ? { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } } : {}),
      });

      expect(result.reviewStatus).toBe('failed');
      expect(result.verdict).toBeNull();
      expect(prompts).toHaveLength(1);
      expect(result.state.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(1);
      expect(loadState(opts)?.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(1);
      expect(opts.events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
    },
  );

  it.each([
    { kind: 'cli', withSinks: false },
    { kind: 'cli', withSinks: true },
    { kind: 'api', withSinks: false },
    { kind: 'api', withSinks: true },
  ] as const)(
    'keeps messages pending when cancelled before the $kind verdict dispatch with sinks=$withSinks',
    async ({ kind, withSinks }) => {
      const opts = setupReview(kind);
      const controller = new AbortController();
      const prompts: string[] = [];
      opts.bus.subscribe((event) => {
        if (event.type === 'drift_report')
          git.beforeStatus = () => {
            opts.enqueue('check after resume');
            controller.abort();
          };
      });
      const reviewer = makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => {
            prompts.push(prompt);
            return passingReviewVerdict(prompt);
          },
        ),
      });

      const result = await runFinalReviewPhase({
        ...opts,
        reviewer,
        signal: controller.signal,
        ...(withSinks ? { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } } : {}),
      });

      expect(result.reviewStatus).toBe('failed');
      expect(result.verdict).toBeNull();
      expect(prompts).toHaveLength(0);
      expect(loadState(opts)?.messageQueue.filter(isQueuedMessagePendingReviewer)).toHaveLength(1);
      expect(opts.events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
    },
  );

  it('retains the continuation note when a queued message requires another verdict', async () => {
    const opts = setupReview('cli');
    const prompts: string[] = [];
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt, call) => {
          prompts.push(prompt);
          if (call === 1) opts.enqueue('check the missing guard');
          return passingReviewVerdict(prompt);
        },
      ),
    });

    const result = await runFinalReviewPhase({
      ...opts,
      reviewer,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      continuation: createContinuationHolder({
        step: { kind: 'review', cycle: 0 },
        steer: plainUserMessage('focus on validation'),
        partial: 'stale interrupted review output',
      }),
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('focus on validation');
    expect(prompts[0]).toContain('stale interrupted review output');
    expect(prompts[1]).toContain('focus on validation');
    expect(prompts[1]).not.toContain('stale interrupted review output');
    expect(prompts[1]).not.toContain('The previous attempt of this step was interrupted.');
    expect(prompts[1]).toContain('check the missing guard');
  });

  it('reads the queue inside a verdict continuation after an interrupt', async () => {
    const opts = setupReview('cli');
    const prompts: string[] = [];
    let abort: (() => void) | null = null;
    const reviewer = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt, call) => {
          prompts.push(prompt);
          if (call === 1) abort?.();
          return passingReviewVerdict(prompt);
        },
      ),
    });

    const result = await runFinalReviewPhase({
      ...opts,
      reviewer,
      callbacks: {
        ...opts.callbacks,
        onContinuationNeeded: async () => {
          opts.enqueue('check the pending correction');
          return plainUserMessage('focus on validation');
        },
      },
      sinks: {
        setAbortHandler: (handler) => {
          abort = handler;
        },
        setQueueHandler: () => {},
      },
    });

    expect(result.reviewStatus).toBe('written');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('check the pending correction');
    expect(prompts[1]).toContain('focus on validation');
    expect(result.state.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
  });
});
