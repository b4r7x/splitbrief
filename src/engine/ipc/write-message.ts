import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';
import { IPC_MAX_FRAME_BYTES } from './protocol.js';

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

export function writeServerMessage(socket: Socket, msg: ServerMessage): boolean {
  if (socket.destroyed) return false;
  try {
    const buf = JSON.stringify(msg) + '\n';
    if (Buffer.byteLength(buf, 'utf8') > IPC_MAX_FRAME_BYTES) {
      writeOversizeWarning(socket, msg);
      return true;
    }
    const ok = socket.write(buf);
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
