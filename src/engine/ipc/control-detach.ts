import type { Socket } from 'node:net';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { IPC_MAX_FRAME_BYTES, parseClientMessage, type ServerMessage } from './protocol.js';

export function rejectAsAlreadyAttached(
  socket: Socket,
  writeMessage: (socket: Socket, msg: ServerMessage) => boolean,
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
  authToken: string;
  currentSocket: () => Socket | null;
  rejectAsAlreadyAttached: (socket: Socket) => void;
  writeMessage: (socket: Socket, msg: ServerMessage) => boolean;
};

export function tryControlDetach(opts: ControlDetachOptions): void {
  const { socket, authToken, currentSocket, rejectAsAlreadyAttached, writeMessage } = opts;
  let consumed = false;
  let authenticated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armRejectTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (consumed) return;
      consumed = true;
      rejectAsAlreadyAttached(socket);
    }, 500);
  };
  armRejectTimer();
  const reject = () => {
    consumed = true;
    if (timer !== undefined) clearTimeout(timer);
    rejectAsAlreadyAttached(socket);
  };
  const lineBuffer = createLineBuffer(
    (line) => {
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
      if (timer !== undefined) clearTimeout(timer);
      if (msg.kind === 'authenticate') {
        if (msg.token !== authToken) {
          writeMessage(socket, {
            kind: 'error',
            code: 'unauthorized',
            message: 'IPC: invalid auth token',
          });
          socket.destroy();
          return;
        }
        authenticated = true;
        consumed = false;
        armRejectTimer();
        return;
      }
      if (!authenticated) {
        writeMessage(socket, {
          kind: 'error',
          code: 'unauthorized',
          message: 'IPC: authenticate before sending commands',
        });
        socket.destroy();
        return;
      }
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
    },
    { maxLineBytes: IPC_MAX_FRAME_BYTES, onOverflow: reject },
  );

  socket.on('data', (chunk: Buffer) => {
    lineBuffer.push(chunk.toString('utf8'));
  });

  socket.on('error', () => {
    consumed = true;
    if (timer !== undefined) clearTimeout(timer);
    socket.destroy();
  });

  socket.on('close', () => {
    consumed = true;
    if (timer !== undefined) clearTimeout(timer);
  });
}
