import { RpcCommandSchema, type RpcCommand } from './types.js';
import { isRecord } from '../../utils/type-guards.js';

export type RpcEnvelopeErrorCode =
  | 'invalid-json'
  | 'invalid-command'
  | 'frame-too-large'
  | 'unterminated-frame'
  | 'authority-unavailable'
  | 'malformed-state'
  | 'legacy-state'
  | 'future-state'
  | 'stale-session'
  | 'stale-epoch'
  | 'stale-revision'
  | 'brief-contract-blocked'
  | 'operation-conflict'
  | 'operation-envelope-conflict';

export type RpcEnvelopeError = Readonly<{
  code: RpcEnvelopeErrorCode;
  message: string;
  details?: Readonly<Record<string, string | number>> | undefined;
}>;

export type RpcEnvelopeParseResult =
  | { ok: true; command: RpcCommand }
  | { ok: false; error: RpcEnvelopeError };

const RPC_COMMAND_KEYS: Readonly<Record<RpcCommand['type'], readonly string[]>> = {
  approve: ['type', 'confirmationPhrase', 'confirmationReason'],
  reject: ['type'],
  regenerate: ['type', 'comment'],
  message: ['type', 'text'],
  recovery: ['type', 'action'],
  status: ['type'],
  abort: ['type'],
  slash: ['type', 'command'],
  brief_review: ['type', 'id', 'operationId', 'promptId', 'command'],
};

export function envelopeError(
  code: RpcEnvelopeErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number>>,
): RpcEnvelopeError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function allowedKeysForType(type: string): readonly string[] | null {
  switch (type) {
    case 'approve':
      return RPC_COMMAND_KEYS.approve;
    case 'reject':
      return RPC_COMMAND_KEYS.reject;
    case 'regenerate':
      return RPC_COMMAND_KEYS.regenerate;
    case 'message':
      return RPC_COMMAND_KEYS.message;
    case 'recovery':
      return RPC_COMMAND_KEYS.recovery;
    case 'status':
      return RPC_COMMAND_KEYS.status;
    case 'abort':
      return RPC_COMMAND_KEYS.abort;
    case 'slash':
      return RPC_COMMAND_KEYS.slash;
    case 'brief_review':
      return RPC_COMMAND_KEYS.brief_review;
    default:
      return null;
  }
}

function commandShapeError(value: unknown): RpcEnvelopeError | null {
  if (!isRecord(value)) {
    return envelopeError('invalid-command', 'Invalid command: expected an object.');
  }
  const type = value.type;
  if (typeof type !== 'string') {
    return envelopeError('invalid-command', 'Invalid command: unknown command type.');
  }
  const allowed = allowedKeysForType(type);
  if (allowed === null || !hasOnlyKeys(value, allowed)) {
    return envelopeError('invalid-command', 'Invalid command: unknown fields.');
  }
  return null;
}

function hasConflictingOperationEnvelope(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'brief_review' || !isRecord(value.command)) return false;
  if (value.command.action === 'status') return false;
  const outerOperationId = value.operationId;
  const commandOperationId = value.command.operationId;
  return (
    typeof outerOperationId === 'string' &&
    typeof commandOperationId === 'string' &&
    outerOperationId !== commandOperationId
  );
}

function nestedVersion(value: unknown): number | null {
  if (!isRecord(value) || value.type !== 'brief_review' || !isRecord(value.command)) {
    return null;
  }
  return typeof value.command.version === 'number' ? value.command.version : null;
}

export function parseRpcCommandEnvelope(value: unknown): RpcEnvelopeParseResult {
  const shapeError = commandShapeError(value);
  if (shapeError !== null) return { ok: false, error: shapeError };

  if (hasConflictingOperationEnvelope(value)) {
    return {
      ok: false,
      error: envelopeError(
        'operation-envelope-conflict',
        'Invalid command envelope: operation IDs disagree.',
      ),
    };
  }

  const result = RpcCommandSchema.safeParse(value);
  if (!result.success) {
    const futureVersion = nestedVersion(value);
    return {
      ok: false,
      error:
        futureVersion !== null && futureVersion > 1
          ? envelopeError(
              'invalid-command',
              `Invalid command envelope: unsupported version ${futureVersion}.`,
              { version: futureVersion },
            )
          : envelopeError('invalid-command', `Invalid command: ${result.error.message}`),
    };
  }

  if (result.data.type === 'brief_review') {
    const outerOperationId = result.data.operationId;
    if (
      result.data.command.action !== 'status' &&
      outerOperationId !== undefined &&
      outerOperationId !== result.data.command.operationId
    ) {
      return {
        ok: false,
        error: envelopeError(
          'operation-envelope-conflict',
          'Invalid command envelope: operation IDs disagree.',
        ),
      };
    }
  }

  return { ok: true, command: result.data };
}
