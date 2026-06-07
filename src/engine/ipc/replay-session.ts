import type { Socket } from 'node:net';
import type { ServerMessage } from './protocol.js';
import { streamReplayEvents, summarizeReplayEvents } from './replay.js';

type ReplaySessionOptions = {
  socket: Socket;
  sessionJsonlPath: string;
  writeMessage: (socket: Socket, msg: ServerMessage) => boolean;
};

export async function replaySession(opts: ReplaySessionOptions): Promise<number | null> {
  const { socket, sessionJsonlPath, writeMessage } = opts;
  const replayStart = Date.now();
  const { totalEvents, firstTs, lastTs } = await summarizeReplayEvents({ sessionJsonlPath });

  if (!socket.destroyed) {
    if (
      !writeMessage(socket, {
        kind: 'event',
        payload: { type: 'replay_started', ts: Date.now(), phase: 'idle', totalEvents },
      })
    )
      return lastTs;
  }

  const replayMeta: ServerMessage = { kind: 'replay_meta', totalEvents, firstTs, lastTs };
  if (!socket.destroyed) {
    if (!writeMessage(socket, replayMeta)) return lastTs;
  }

  for await (const event of streamReplayEvents({ sessionJsonlPath })) {
    if (socket.destroyed) break;
    if (!writeMessage(socket, { kind: 'event', payload: event })) break;
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

  return lastTs;
}
