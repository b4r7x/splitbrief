import type { Socket } from 'node:net';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { parseClientMessage, type ServerMessage } from './protocol.js';

export function rejectAsAlreadyAttached(
  socket: Socket,
  writeMessage: (socket: Socket, msg: ServerMessage) => void,
): void {
  writeMessage(socket, {
    kind: 'error',
    code: 'already_attached',
    message: 'session already has an attached client; use --force to steal',
  });
  socket.destroy();
}

type ControlDetachOptions = {
  socket: Socket;
  currentSocket: () => Socket | null;
  rejectAsAlreadyAttached: (socket: Socket) => void;
};

export function tryControlDetach(opts: ControlDetachOptions): void {
  const { socket, currentSocket, rejectAsAlreadyAttached } = opts;
  let consumed = false;
  const timer = setTimeout(() => {
    if (consumed) return;
    consumed = true;
    rejectAsAlreadyAttached(socket);
  }, 500);
  const reject = () => {
    consumed = true;
    clearTimeout(timer);
    rejectAsAlreadyAttached(socket);
  };
  const lineBuffer = createLineBuffer((line) => {
    if (consumed) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: ReturnType<typeof parseClientMessage>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      msg = parseClientMessage(parsed);
      if (!msg) {
        reject();
        return;
      }
    } catch {
      reject();
      return;
    }
    consumed = true;
    clearTimeout(timer);
    if (msg.kind === 'detach') {
      const attached = currentSocket();
      if (attached) {
        try {
          attached.destroy();
        } catch {
          /* ignore */
        }
      }
      socket.destroy();
      return;
    }
    rejectAsAlreadyAttached(socket);
  });

  socket.on('data', (chunk: Buffer) => {
    lineBuffer.push(chunk.toString('utf8'));
  });

  socket.on('error', () => {
    consumed = true;
    clearTimeout(timer);
    socket.destroy();
  });

  socket.on('close', () => {
    consumed = true;
    clearTimeout(timer);
  });
}
