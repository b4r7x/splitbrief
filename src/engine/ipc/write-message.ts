import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';
import { IPC_MAX_FRAME_BYTES } from './protocol.js';
import { protectServerMessage } from './message-protection.js';

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

export interface WriteServerMessageOptions {
  persistTranscript?: boolean | undefined;
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
    return false;
  }
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
