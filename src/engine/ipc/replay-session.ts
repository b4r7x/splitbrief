import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';
import { readReplayEvents } from './replay.js';

type ReplaySessionOptions = {
  socket: Socket;
  sessionJsonlPath: string;
  writeMessage: (socket: Socket, msg: ServerMessage) => void;
};

export async function replaySession(opts: ReplaySessionOptions): Promise<void> {
  const { socket, sessionJsonlPath, writeMessage } = opts;
  const replayStart = Date.now();
  const result = await readReplayEvents({ sessionJsonlPath });
  const { events: replayedEvents, firstTs, lastTs } = result;
  const totalEvents = replayedEvents.length;

  if (!socket.destroyed) {
    writeMessage(socket, {
      kind: 'event',
      payload: { type: 'replay_started', ts: Date.now(), phase: 'idle', totalEvents },
    });
  }

  const replayMeta: ServerMessage = { kind: 'replay_meta', totalEvents, firstTs, lastTs };
  if (!socket.destroyed) {
    writeMessage(socket, replayMeta);
  }

  for (const event of replayedEvents) {
    if (socket.destroyed) break;
    writeMessage(socket, { kind: 'event', payload: event });
  }

  const durationMs = Date.now() - replayStart;
  const completeEvent = {
    type: 'replay_complete' as const,
    ts: Date.now(),
    phase: 'idle' as const,
    totalEvents,
    durationMs,
  };
  if (!socket.destroyed) {
    writeMessage(socket, { kind: 'event', payload: completeEvent });
  }
}
