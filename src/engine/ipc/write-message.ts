import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';
import { IPC_MAX_FRAME_BYTES, parseServerMessage } from './protocol.js';
import { protectConsumerPayload } from '../calls/consumer-policy.js';
import { protectEngineEventForConsumer } from '../events/protection.js';

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

export interface WriteServerMessageOptions {
  persistTranscript?: boolean | undefined;
}

interface ResolvedWriteServerMessageOptions {
  persistTranscript: boolean;
}

export function writeServerMessage(
  socket: Socket,
  msg: ServerMessage,
  opts: WriteServerMessageOptions = {},
): boolean {
  if (socket.destroyed) return false;
  const persistTranscript = opts.persistTranscript ?? true;
  try {
    const protectedMsg = protectServerMessage(msg, { persistTranscript });
    if (protectedMsg === null) return true;
    const protectedBuf = JSON.stringify(protectedMsg) + '\n';
    if (Buffer.byteLength(protectedBuf, 'utf8') > IPC_MAX_FRAME_BYTES) {
      writeOversizeWarning(socket, protectedMsg);
      return true;
    }
    const ok = socket.write(protectedBuf);
    if (!ok && socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
      socket.destroy();
      return false;
    }
    return ok;
  } catch {
    // socket may have closed mid-write; ignore
    return false;
  }
}

function protectServerMessage(
  msg: ServerMessage,
  opts: ResolvedWriteServerMessageOptions,
): ServerMessage | null {
  if (msg.kind === 'event') {
    const event = protectEngineEventForConsumer(msg.payload, {
      context: 'ipc',
      persistTranscript: opts.persistTranscript,
    });
    return event === null ? null : { kind: 'event', payload: event };
  }

  const protectedPayload = protectConsumerPayload({ context: 'ipc', payload: msg });
  if (protectedPayload.oversized) {
    return {
      kind: 'event',
      payload: {
        type: 'warning',
        ts: Date.now(),
        phase: 'idle',
        message: `IPC: dropped oversized ${msg.kind} frame exceeding ${protectedPayload.maxBytes} bytes`,
      },
    };
  }

  const parsed = parseServerMessage(protectedPayload.payload);
  if (parsed !== null) return parsed;

  return {
    kind: 'event',
    payload: {
      type: 'warning',
      ts: Date.now(),
      phase: 'idle',
      message: `IPC: dropped invalid ${msg.kind} frame after public payload normalization`,
    },
  };
}

function writeOversizeWarning(socket: Socket, msg: ServerMessage): void {
  const detail = msg.kind === 'event' ? msg.payload.type : msg.kind;
  const warning: ServerMessage = {
    kind: 'event',
    payload: {
      type: 'warning',
      ts: Date.now(),
      phase: 'idle',
      message: `IPC: dropped oversized ${detail} frame exceeding ${IPC_MAX_FRAME_BYTES} bytes`,
    },
  };
  try {
    socket.write(JSON.stringify(warning) + '\n');
  } catch {
    // socket may have closed mid-write; ignore
  }
}
