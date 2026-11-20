import { isDeepStrictEqual } from 'node:util';
import { error } from '../../../utils/error.js';
import type { RunnerCallEvent, RunnerCallContext } from '../types.js';

export function eventContext(event: RunnerCallEvent): RunnerCallContext {
  return {
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
    ...(event.model !== undefined && { model: event.model }),
    ...(event.axes !== undefined && { axes: event.axes }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    ...(event.attemptId !== undefined && { attemptId: event.attemptId }),
    ...(event.transport !== undefined && { transport: event.transport }),
    ...(event.sessionScope !== undefined && { sessionScope: event.sessionScope }),
    ...(event.invocationIdentity !== undefined && {
      invocationIdentity: event.invocationIdentity,
    }),
    ...(event.taskId !== undefined && { taskId: event.taskId }),
  };
}

export function assertSameCall(context: RunnerCallContext, event: RunnerCallEvent): void {
  if (
    context.callId === event.callId &&
    context.role === event.role &&
    context.backendKind === event.backendKind
  ) {
    assertSameInvocationIdentity(context, event);
    return;
  }

  throw error(
    'runner-call-mixed-events',
    'Runner call collector received events from another call',
    {
      expectedCallId: context.callId,
      actualCallId: event.callId,
    },
  );
}

// An event without an identity (a legacy line, a buffered overflow warning)
// neither conflicts with nor erases the one the call was recorded with.
function assertSameInvocationIdentity(context: RunnerCallContext, event: RunnerCallEvent): void {
  if (event.invocationIdentity === undefined) return;
  if (context.invocationIdentity === undefined) {
    context.invocationIdentity = event.invocationIdentity;
    return;
  }
  if (isDeepStrictEqual(context.invocationIdentity, event.invocationIdentity)) return;
  throw error(
    'runner-call-identity-conflict',
    'Runner call collector received two invocation identities for one call',
    { callId: context.callId },
  );
}
