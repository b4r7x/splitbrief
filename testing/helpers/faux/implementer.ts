import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import type {
  Implementer,
} from '../../../src/engine/implementers/types.js';

export type FauxImplementStep = {
  success: boolean;
  output?: string;
  error?: string;
  usage?: TokenDelta;
  delayMs?: number;
  throws?: Error;
};

export type FauxRetryStep = {
  success: boolean;
  output?: string;
  error?: string;
  usage?: TokenDelta;
  throws?: Error;
};

export type FauxImplementerState = {
  implementCallCount: number;
  retryCallCount: number;
  receivedTasks: Task[];
  receivedErrors: string[];
};

export function fauxImplementer(opts?: {
  steps?: FauxImplementStep[];
  retries?: FauxRetryStep[];
}): { implementer: Implementer; state: FauxImplementerState } {
  const steps = opts?.steps ?? [];
  const retries = opts?.retries ?? [];

  const state: FauxImplementerState = {
    implementCallCount: 0,
    retryCallCount: 0,
    receivedTasks: [],
    receivedErrors: [],
  };

  const implementer: Implementer = {
    async implement(opts) {
      state.implementCallCount++;
      state.receivedTasks.push(opts.task);
      const script = steps[(state.implementCallCount - 1) % steps.length];
      if (script?.delayMs) {
        await new Promise((r) => setTimeout(r, script.delayMs));
      }
      if (script?.throws) throw script.throws;
      return {
        success: script?.success ?? false,
        output: script?.output ?? '',
        error: script?.error,
        usage: script?.usage,
      };
    },

    async retry(opts) {
      state.retryCallCount++;
      state.receivedErrors.push(opts.error);
      const script = retries[(state.retryCallCount - 1) % retries.length];
      if (script?.throws) throw script.throws;
      return {
        success: script?.success ?? false,
        output: script?.output ?? '',
        error: script?.error,
        usage: script?.usage,
      };
    },

    async isAvailable() {
      return true;
    },

    async getVersion() {
      return '1.0';
    },
  };

  return { implementer, state };
}
