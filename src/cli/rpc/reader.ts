import { z } from 'zod';
import { BriefRecoveryProjectionV1Schema } from '../../core/schemas/brief-recovery/document.js';
import { isBriefReviewCommandCurrent } from '../../core/schemas/brief-review-command.js';
import { parseJsonLine } from '../json-line.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { RPC_MAX_FRAME_BYTES, RpcCommandSchema, type RpcCommand } from './types.js';
import { isRecord } from '../../utils/type-guards.js';

const CURRENT_STATE_VERSION = 4;
const DEFAULT_OPERATION_CACHE_SIZE = 1_024;

const CurrentV4StateSchema = z
  .object({
    stateVersion: z.literal(CURRENT_STATE_VERSION),
    projection: BriefRecoveryProjectionV1Schema,
  })
  .strict();

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

function envelopeError(
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

export interface CommandReaderOptions {
  stream: NodeJS.ReadableStream;
  onCommand: (cmd: RpcCommand) => void;
  onError: (err: string) => void;
  onTypedError?: ((error: RpcEnvelopeError) => void) | undefined;
  onReplay?: ((cmd: RpcCommand) => void) | undefined;
  onClose?: (() => void) | undefined;
  getAuthoritativeState?: (() => unknown) | undefined;
  requireCurrentV4?: boolean | undefined;
  operationDedupe?: RpcOperationDeduper | undefined;
}

const defaultOperationDedupe = createRpcOperationDeduper();

function nestedVersion(value: unknown): number | null {
  if (!isRecord(value) || value.type !== 'brief_review' || !isRecord(value.command)) {
    return null;
  }
  return typeof value.command.version === 'number' ? value.command.version : null;
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

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? '';
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function validateAgainstAuthority(
  command: RpcCommand,
  getAuthoritativeState: (() => unknown) | undefined,
  requireCurrentV4: boolean,
): RpcEnvelopeError | null {
  if (command.type !== 'brief_review') return null;
  let rawState: unknown | null;
  try {
    rawState = getAuthoritativeState?.() ?? null;
  } catch {
    return envelopeError(
      'malformed-state',
      'RPC command state could not be read from the authoritative host.',
    );
  }
  if (rawState === null) {
    return requireCurrentV4
      ? envelopeError(
          'authority-unavailable',
          'Brief review command requires the authoritative current-v4 projection.',
        )
      : null;
  }

  const parsed = CurrentV4StateSchema.safeParse(rawState);
  if (!parsed.success) {
    const stateVersion = isRecord(rawState) ? rawState.stateVersion : undefined;
    if (stateVersion === 3) {
      return envelopeError(
        'legacy-state',
        'RPC command state is v3 and requires current-v4 authority.',
      );
    }
    if (typeof stateVersion === 'number' && stateVersion > CURRENT_STATE_VERSION) {
      return envelopeError(
        'future-state',
        'RPC command state is newer than the current v4 reader.',
        { stateVersion },
      );
    }
    return envelopeError(
      'malformed-state',
      'RPC command state is not a valid current-v4 projection.',
    );
  }

  const projection = parsed.data.projection;
  const reviewCommand = command.command;
  if (reviewCommand.sessionId !== projection.sessionId) {
    return envelopeError(
      'stale-session',
      'RPC command session does not match the current projection.',
    );
  }
  if (!isBriefReviewCommandCurrent(reviewCommand, projection)) {
    if (reviewCommand.epochId !== projection.epochId) {
      return envelopeError(
        'stale-epoch',
        'RPC command epoch does not match the current projection.',
      );
    }
    if (reviewCommand.action !== 'status') {
      return envelopeError(
        'stale-revision',
        'RPC command revisions do not match the current projection.',
      );
    }
  }
  if (reviewCommand.action === 'approve' && !projection.allowedActions.includes('approve')) {
    return envelopeError(
      'brief-contract-blocked',
      'Task Brief approval is blocked by the current recovery projection.',
    );
  }
  return null;
}

function reportError(
  options: Pick<CommandReaderOptions, 'onError' | 'onTypedError'>,
  error: RpcEnvelopeError,
): void {
  options.onTypedError?.(error);
  options.onError(error.message);
}

export function createCommandReader(options: CommandReaderOptions): { close: () => void } {
  const {
    stream,
    onCommand,
    onError,
    onTypedError,
    onReplay,
    onClose,
    getAuthoritativeState,
    requireCurrentV4 = true,
    operationDedupe = defaultOperationDedupe,
  } = options;
  type ReaderSignal = Readonly<{ kind: 'close' }>;
  const closeSignal: ReaderSignal = { kind: 'close' };
  let closed = false;
  let closeNotified = false;

  const removeListeners = () => {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
    stream.removeListener('close', onStreamClose);
    stream.removeListener('error', onStreamError);
  };

  const notifyClose = () => {
    if (closeNotified) return;
    closeNotified = true;
    onClose?.();
  };

  const finishClose = () => {
    if (closed) return;
    closed = true;
    removeListeners();
    notifyClose();
  };

  const destroyInput = () => {
    try {
      if ('destroy' in stream && typeof stream.destroy === 'function') {
        stream.destroy();
        return;
      }
      if ('pause' in stream && typeof stream.pause === 'function') stream.pause();
    } catch {
      // The input is already being torn down; close notification remains deterministic.
    }
  };

  const failReader = (error: RpcEnvelopeError): ReaderSignal => {
    if (closed) return closeSignal;
    reportError({ onError, onTypedError }, error);
    destroyInput();
    finishClose();
    return closeSignal;
  };

  const lineBuffer = createLineBuffer<ReaderSignal | undefined>(
    (line) => {
      if (closed) return closeSignal;
      const trimmed = line.trim();
      if (!trimmed) return undefined;

      const parsed = parseJsonLine(trimmed);
      if (parsed === undefined) {
        reportError(
          { onError, onTypedError },
          envelopeError('invalid-json', `Invalid JSON: ${trimmed}`),
        );
        return undefined;
      }

      const envelope = parseRpcCommandEnvelope(parsed);
      if (!envelope.ok) {
        reportError({ onError, onTypedError }, envelope.error);
        return undefined;
      }

      const authorityError = validateAgainstAuthority(
        envelope.command,
        getAuthoritativeState,
        requireCurrentV4,
      );
      if (authorityError !== null) {
        reportError({ onError, onTypedError }, authorityError);
        return undefined;
      }

      const observation = operationDedupe.observe(envelope.command);
      if (observation.kind === 'conflict') {
        reportError(
          { onError, onTypedError },
          envelopeError(
            'operation-conflict',
            `RPC operation ID ${observation.operationId} was reused with a different command.`,
            { operationId: observation.operationId },
          ),
        );
        return undefined;
      }
      if (observation.kind === 'replay') {
        onReplay?.(envelope.command);
        return undefined;
      }

      onCommand(envelope.command);
      return undefined;
    },
    {
      maxLineBytes: RPC_MAX_FRAME_BYTES - 1,
      onOverflow: (overflow) => {
        return failReader(
          envelopeError('frame-too-large', `RPC frame too large: ${overflow.lineBytes} bytes`, {
            lineBytes: overflow.lineBytes,
          }),
        );
      },
      onUnterminated: (overflow) =>
        failReader(
          envelopeError(
            'unterminated-frame',
            `RPC frame is unterminated: ${overflow.lineBytes} bytes`,
            { lineBytes: overflow.lineBytes },
          ),
        ),
    },
  );

  function onData(chunk: unknown): void {
    if (closed) return;
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf8')
            : null;
    if (text === null) return;
    const result = lineBuffer.push(text);
    if (result === closeSignal) finishClose();
  }

  function finalizeInput(): void {
    if (closed) return;
    const result = lineBuffer.flush();
    if (result === closeSignal) {
      finishClose();
      return;
    }
    finishClose();
  }

  function onEnd(): void {
    finalizeInput();
  }

  function onStreamClose(): void {
    finalizeInput();
  }

  function onStreamError(): void {
    finalizeInput();
  }

  if ('setEncoding' in stream && typeof stream.setEncoding === 'function') {
    stream.setEncoding('utf8');
  }
  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onStreamClose);
  stream.on('error', onStreamError);

  return {
    close: () => {
      if (closed) return;
      if ('pause' in stream && typeof stream.pause === 'function') stream.pause();
      finishClose();
    },
  };
}
