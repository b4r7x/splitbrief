import type { RpcCommand } from './types.js';

export type ApprovalGateResult = { approved: boolean; comment?: string | undefined };

export function createGate<T>() {
  let pending: ((value: T) => void) | null = null;

  return {
    wait(): Promise<T> {
      return new Promise((r) => {
        pending = r;
      });
    },
    resolve(value: T): boolean {
      if (!pending) return false;
      pending(value);
      pending = null;
      return true;
    },
    isPending(): boolean {
      return pending !== null;
    },
  };
}

export function createApprovalGate() {
  const gate = createGate<ApprovalGateResult>();

  return {
    wait: gate.wait,
    handle(cmd: RpcCommand): boolean {
      if (!gate.isPending()) return false;
      if (cmd.type === 'approve') {
        return gate.resolve({ approved: true });
      }
      if (cmd.type === 'reject') {
        return gate.resolve({ approved: false, comment: cmd.comment });
      }
      return false;
    },
    isPending: gate.isPending,
  };
}
