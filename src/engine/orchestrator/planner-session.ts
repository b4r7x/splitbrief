import type { z } from 'zod';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { SteeringPort } from '../calls/steering.js';
import type { EventBus } from '../events/types.js';
import type { Planner, PriorMessage } from '../planners/types.js';
import { requestTyped, type RequestTypedResult } from '../runners/typed-output.js';
import { withExpiredSessionReissue } from './resume-context.js';
import { transitionAndSave } from './state-ops.js';

/** What one typed call on the planner's own thread is built from. */
export type PlannerSessionCall<T> = Readonly<{
  schema: z.ZodType<T>;
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
  images?: readonly Attachment[] | undefined;
  /** The conversation so far, for a call that runs on a fresh session. */
  priorMessages?: readonly PriorMessage[] | undefined;
  /**
   * The turn to send: `onSession` says the planner's saved thread continues, so a short turn
   * is enough; a fresh session needs the whole prompt and the conversation it reads back.
   */
  compose: (turn: PlannerSessionTurn) => Promise<string> | string;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
}>;

export type PlannerSessionTurn = Readonly<{
  /** The saved thread continues: the call is a short turn on it. */
  onSession: boolean;
  /** The rebuilt conversation of an expired thread, handed to a fresh session's prompt. */
  priorMessages: PriorMessage[] | undefined;
}>;

export type PlannerSessionContext = Readonly<{
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  planner: Pick<Planner, 'capabilities' | 'typedCall'>;
  /** The state the call starts on: the thread it names is the one a resumed turn continues. */
  state: WorkflowState;
  signal?: AbortSignal | undefined;
  steering?: SteeringPort | undefined;
  /** Receives every state the call saves: a thread reset, or an answer's new native handle. */
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}>;

export type PlannerSessionAnswer<T> = Readonly<{
  result: RequestTypedResult<T>;
  state: WorkflowState;
}>;

/**
 * One typed call on the planner's own session. The call resumes the saved thread when the
 * tool can, and a thread the backend rejects is reissued once on a fresh session with the
 * rebuilt transcript, the state remembering the reset. A returned native handle is saved for
 * the calls after it.
 */
export async function askPlannerSession<T>(
  ctx: PlannerSessionContext,
  call: PlannerSessionCall<T>,
): Promise<PlannerSessionAnswer<T>> {
  const ref = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  let state = ctx.state;
  const apply = (next: WorkflowState): void => {
    state = next;
    ctx.onStateChange?.(next);
  };

  const result = await withExpiredSessionReissue({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    bus: ctx.bus,
    planner: ctx.planner,
    state,
    ...(ctx.signal !== undefined && { signal: ctx.signal }),
    issue: async (rebuilt) => {
      if (rebuilt !== undefined) {
        apply(transitionAndSave(ref, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: null }));
      }
      const onSession =
        rebuilt === undefined &&
        ctx.planner.capabilities.supportsSessionResume &&
        Boolean(state.plannerSessionId);
      const priorMessages: PriorMessage[] | undefined =
        rebuilt ?? (call.priorMessages === undefined ? undefined : [...call.priorMessages]);
      return requestTyped({
        prompt: await call.compose({ onSession, priorMessages }),
        schema: call.schema,
        jsonSchema: call.jsonSchema,
        schemaName: call.schemaName,
        call: ctx.planner.typedCall({
          projectDir: ctx.projectDir,
          seat: 'planner',
          callbacks: {
            onOutput: () => {},
            ...(call.onCallEvent !== undefined && { onCallEvent: call.onCallEvent }),
            ...(ctx.signal !== undefined && { signal: ctx.signal }),
            ...(ctx.steering !== undefined && { steering: ctx.steering }),
          },
          ...(call.images !== undefined && { images: [...call.images] }),
          ...(priorMessages !== undefined && priorMessages.length > 0 && { priorMessages }),
        }),
      });
    },
  });

  if ('value' in result && result.nativeSessionId !== null) {
    apply(
      transitionAndSave(ref, state, {
        type: 'SET_PLANNER_SESSION_ID',
        sessionId: result.nativeSessionId,
      }),
    );
  }
  return { result, state };
}
