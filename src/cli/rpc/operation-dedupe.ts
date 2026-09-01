import type { RpcCommand } from './types.js';
import { isRecord } from '../../utils/type-guards.js';

const DEFAULT_OPERATION_CACHE_SIZE = 1_024;

export type RpcOperationObservation =
  | { kind: 'new'; operationId: string }
  | { kind: 'replay'; operationId: string }
  | { kind: 'conflict'; operationId: string }
  | { kind: 'not-applicable' };

export type RpcOperationDeduper = {
  observe: (command: RpcCommand) => RpcOperationObservation;
  clear: () => void;
};

type OperationEntry = Readonly<{ fingerprint: string }>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? '';
}

function operationIdentity(command: RpcCommand): {
  key: string;
  operationId: string;
  fingerprint: string;
} | null {
  if (command.type !== 'brief_review' || command.command.action === 'status') return null;
  const { sessionId, epochId, operationId } = command.command;
  return {
    key: JSON.stringify([sessionId, epochId, operationId]),
    operationId,
    // Transport correlation fields belong to the client, not the operation. Two clients
    // retrying the same command must converge on one operation even when their envelope IDs differ.
    fingerprint: stableStringify(command.command),
  };
}

export function createRpcOperationDeduper(
  maxEntries = DEFAULT_OPERATION_CACHE_SIZE,
): RpcOperationDeduper {
  const entries = new Map<string, OperationEntry>();
  const capacity = Number.isFinite(maxEntries)
    ? Math.max(1, Math.floor(maxEntries))
    : DEFAULT_OPERATION_CACHE_SIZE;

  return {
    observe(command) {
      const identity = operationIdentity(command);
      if (identity === null) return { kind: 'not-applicable' };

      const previous = entries.get(identity.key);
      if (previous !== undefined) {
        return previous.fingerprint === identity.fingerprint
          ? { kind: 'replay', operationId: identity.operationId }
          : { kind: 'conflict', operationId: identity.operationId };
      }

      if (entries.size >= capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(identity.key, { fingerprint: identity.fingerprint });
      return { kind: 'new', operationId: identity.operationId };
    },
    clear() {
      entries.clear();
    },
  };
}
