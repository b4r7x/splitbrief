import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';

const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

export function writeServerMessage(socket: Socket, msg: ServerMessage): boolean {
  if (socket.destroyed) return false;
  try {
    const buf = JSON.stringify(msg) + '\n';
    if (Buffer.byteLength(buf, 'utf8') > MAX_SOCKET_BUFFER_BYTES) {
      socket.destroy();
      return false;
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
