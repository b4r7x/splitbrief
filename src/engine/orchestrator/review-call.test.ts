import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../../core/schemas/attachment.js';
import { createInitialState } from '../../core/state/machine.js';
import { loadState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { Reviewer } from '../reviewers/types.js';
import type { TypedCallContext } from '../planners/types.js';
import type { RunnerCallResult } from '../calls/types.js';
import { createSteeringPort } from '../calls/steering.js';
import {
  REVIEW_ANSWER_JSON_SCHEMA,
  ReviewAnswerSchema,
  type ReviewAnswer,
} from '../../core/schemas/review.js';
import { taskId } from '../../core/schemas/task.js';
import { runReviewerCall } from './review-call.js';

let dirs: string[] = [];

function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('review-call');
  dirs.push(projectDir);
  const sessionId = 'sess-review-call';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const VERDICT: ReviewAnswer = {
  tasks: [{ id: taskId('T001'), plan: 'met', note: '' }],
  criteria: [],
  findings: [],
  fixTasks: [],
  rejected: [],
  verify: [],
  ask: null,
};

/** A stateless review seat whose typed call is what the test scripts. */
function typedReviewer(
  invoke: (opts: {
    prompt: string;
    signal?: AbortSignal | undefined;
    onOutput?: ((text: string) => void) | undefined;
  }) => Promise<RunnerCallResult>,
): Reviewer {
  return {
    review: vi.fn(),
    typedCall: (ctx: TypedCallContext) => ({
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: false,
      invoke: ({ prompt }) =>
        invoke({
          prompt,
          signal: ctx.callbacks.signal,
          onOutput: ctx.callbacks.onOutput,
        }),
    }),
  };
}

describe('runReviewerCall', () => {
  describe.each(['direct', 'prepared'])('with %s input', (inputKind) => {
    it.each([
      { label: 'omitted', images: undefined },
      { label: 'empty', images: [] },
      {
        label: 'non-empty',
        images: [
          {
            id: 'render',
            kind: 'image',
            path: '/renders/frame.png',
            mimeType: 'image/png',
            sizeBytes: 1,
          },
        ],
      },
    ] satisfies { label: string; images: readonly Attachment[] | undefined }[])(
      'preserves the attachment contract for $label images through a verdict repair',
      async ({ images }) => {
        const ref = setupProjectDir();
        const { bus } = makeBusRecorder();
        const contexts: TypedCallContext[] = [];
        const base = typedReviewer(async () =>
          makeRunnerCallResult({
            status: 'completed',
            text: contexts.length === 1 ? 'invalid verdict' : JSON.stringify(VERDICT),
          }),
        );
        const reviewer: Reviewer = {
          ...base,
          typedCall: (ctx) => {
            contexts.push(ctx);
            return base.typedCall(ctx);
          },
        };
        const input = { prompt: 'review the diff', images };

        const result = await runReviewerCall({
          ...ref,
          reviewer,
          workspaceDir: ref.projectDir,
          ...(inputKind === 'direct' ? input : { prepareCall: async () => input }),
          schema: ReviewAnswerSchema,
          jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
          schemaName: 'review_answer',
          bus,
          state: createInitialState('feature'),
        });

        expect('value' in result.result && result.result.value).toEqual(VERDICT);
        expect(contexts).toHaveLength(2);
        for (const context of contexts) {
          if (images === undefined || images.length === 0) {
            expect(context).not.toHaveProperty('images');
          } else {
            expect(context.images).toEqual(images);
          }
        }
      },
    );
  });

  it('passes an explicit port to verdict callbacks and leaves helper callbacks without it', async () => {
    const ref = setupProjectDir();
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const contexts: TypedCallContext[] = [];
    const base = typedReviewer(async () =>
      makeRunnerCallResult({ status: 'completed', text: JSON.stringify(VERDICT) }),
    );
    const reviewer: Reviewer = {
      ...base,
      typedCall: (ctx) => {
        contexts.push(ctx);
        return base.typedCall(ctx);
      },
    };
    const opts = {
      ...ref,
      reviewer,
      workspaceDir: ref.projectDir,
      prompt: 'review the diff',
      schema: ReviewAnswerSchema,
      jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
      schemaName: 'review_answer',
      bus,
      state: createInitialState('feature'),
    };
    const verdict = await runReviewerCall({ ...opts, steering });
    await runReviewerCall({ ...opts, state: verdict.state });

    expect(contexts[0]?.callbacks.steering).toBe(steering);
    expect(contexts[1]?.callbacks).not.toHaveProperty('steering');
  });

  it('returns the typed verdict and attributes the usage to the reviewer bucket', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();
    const reviewer = typedReviewer(async () =>
      makeRunnerCallResult({
        status: 'completed',
        text: JSON.stringify(VERDICT),
        usage: { inputTokens: 41, outputTokens: 17 },
      }),
    );

    const result = await runReviewerCall({
      reviewer,
      prompt: 'review the diff',
      schema: ReviewAnswerSchema,
      jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
      schemaName: 'review_answer',
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
    });

    expect('value' in result.result && result.result.value).toEqual(VERDICT);
    expect(result.state.tokenUsage).toMatchObject({
      reviewerInput: 41,
      reviewerOutput: 17,
      plannerInput: 0,
      plannerOutput: 0,
    });
    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.tokenUsage).toMatchObject({ reviewerInput: 41, reviewerOutput: 17 });
  });

  it('streams no seat text and publishes no artifact card for the typed answer', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const reviewer = typedReviewer(async ({ onOutput }) => {
      onOutput?.(JSON.stringify(VERDICT));
      return makeRunnerCallResult({ status: 'completed', text: JSON.stringify(VERDICT) });
    });

    await runReviewerCall({
      reviewer,
      prompt: 'review the diff',
      schema: ReviewAnswerSchema,
      jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
      schemaName: 'review_answer',
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
    });

    expect(events.filter((event) => event.type === 'planner_text')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
  });

  it('forwards the caller signal so an abort cancels the in-flight reviewer call', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus } = makeBusRecorder();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const reviewer = typedReviewer(({ signal }) => {
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('runReviewerCall did not forward the caller signal'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The user aborted a request.', 'AbortError'));
        });
      });
    });

    const call = runReviewerCall({
      reviewer,
      prompt: 'review the diff',
      schema: ReviewAnswerSchema,
      jsonSchema: REVIEW_ANSWER_JSON_SCHEMA,
      schemaName: 'review_answer',
      projectDir,
      workspaceDir: projectDir,
      sessionId,
      bus,
      state: createInitialState('feature'),
      signal: controller.signal,
    });

    await started.promise;
    controller.abort(new DOMException('The user aborted a request.', 'AbortError'));

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  });
});
