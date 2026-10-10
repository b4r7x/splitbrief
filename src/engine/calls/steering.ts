import type { RunnerCallContext } from './types.js';
import type { AttachedInput, Attachment } from '../../core/schemas/attachment.js';

export type SteerOutcome = 'delivered' | 'deferred' | 'uncertain';
export type SteerMessage = Readonly<{
  id: string;
  text: string;
  images?: readonly Attachment[] | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
}>;

export type RunningCall = Readonly<{
  callId: string;
  role: RunnerCallContext['role'];
  taskId: string | null;
  send: (message: SteerMessage) => Promise<SteerOutcome>;
}>;

export type SteeringPort = Readonly<{
  current: () => RunningCall | null;
  attach: (call: RunningCall) => () => void;
}>;

export function createSteeringPort(opts?: {
  onChange?: (call: RunningCall | null) => void;
}): SteeringPort {
  let attached: { call: RunningCall } | null = null;
  return {
    current: () => attached?.call ?? null,
    attach: (call) => {
      const attachment = { call };
      attached = attachment;
      try {
        opts?.onChange?.(call);
      } catch (cause) {
        if (attached === attachment) attached = null;
        throw cause;
      }
      return () => {
        if (attached !== attachment) return;
        attached = null;
        opts?.onChange?.(null);
      };
    },
  };
}

export function deliverToRunningCall(
  call: RunningCall | null,
  message: SteerMessage,
): Promise<SteerOutcome> {
  return call === null ? Promise.resolve('deferred') : call.send(message);
}
