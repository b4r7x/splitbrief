import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import { loadState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { Reviewer } from '../reviewers/types.js';
import type { TypedCallContext } from '../planners/types.js';
import type { RunnerCallResult } from '../calls/types.js';
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

  it('streams the review body to the bus instead of publishing an artifact card', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const { bus, events } = makeBusRecorder();
    const reviewer = typedReviewer(async ({ onOutput }) => {
      onOutput?.('partial review text');
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

    expect(
      events.filter(
        (event) => event.type === 'planner_text' && event.text === 'partial review text',
      ),
    ).toHaveLength(1);
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
