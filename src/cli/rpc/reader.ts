import { parseJsonLine } from '../json-line.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { RPC_MAX_FRAME_BYTES, type RpcCommand } from './types.js';
import { envelopeError, parseRpcCommandEnvelope, type RpcEnvelopeError } from './envelope.js';
import { createRpcOperationDeduper, type RpcOperationDeduper } from './operation-dedupe.js';
import { validateAgainstAuthority } from './state-authority.js';

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
