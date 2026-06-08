import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type { RpcCommand } from './types.js';

export type ApprovalGateResult = {
  approved: boolean;
  comment?: string | undefined;
  confirmationPhrase?: string | undefined;
  confirmationReason?: string | undefined;
};

export function validateConfirmApprovalFields(fields: {
  confirmationPhrase?: string | undefined;
  confirmationReason?: string | undefined;
  comment?: string | undefined;
}): { ok: true; reason: string } | { ok: false } {
  const reason = fields.confirmationReason?.trim() || fields.comment?.trim();
  if (fields.confirmationPhrase === CONFIRM_PHRASE && reason) {
    return { ok: true, reason };
  }
  return { ok: false };
}

export function createGate<T>() {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((reason: Error) => void) | null = null;

  return {
    wait(): Promise<T> {
      return new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
    resolve(value: T): boolean {
      if (!resolveFn) return false;
      resolveFn(value);
      resolveFn = null;
      rejectFn = null;
      return true;
    },
    reject(reason: Error): boolean {
      if (!rejectFn) return false;
      rejectFn(reason);
      resolveFn = null;
      rejectFn = null;
      return true;
    },
    isPending(): boolean {
      return resolveFn !== null;
    },
  };
}

export function createApprovalGate() {
  const gate = createGate<ApprovalGateResult>();

  return {
    wait: gate.wait,
    reject: gate.reject,
    handle(cmd: RpcCommand): boolean {
      if (!gate.isPending()) return false;
      if (cmd.type === 'approve') {
        return gate.resolve({
          approved: true,
          confirmationPhrase: cmd.confirmationPhrase,
          confirmationReason: cmd.confirmationReason,
        });
      }
      if (cmd.type === 'reject') {
        return gate.resolve({ approved: false });
      }
      if (cmd.type === 'regenerate') {
        return gate.resolve({ approved: false, comment: cmd.comment });
      }
      return false;
    },
    isPending: gate.isPending,
  };
}
