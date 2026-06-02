import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';

export function writeServerMessage(socket: Socket, msg: ServerMessage): void {
  if (socket.destroyed) return;
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch {
    // socket may have closed mid-write; ignore
  }
}
