import type { Socket } from 'node:net';
import type { EngineEvent } from '../events/types.js';
import type { ServerMessage } from './protocol.js';
import type { ReplayDiagnostics } from './replay.js';
import { streamReplayEvents, summarizeReplayEvents } from './replay.js';

type ReplaySessionOptions = {
  socket: Socket;
  sessionJsonlPath: string;
  writeMessage: (socket: Socket, msg: ServerMessage) => boolean;
};

async function writeAndAwaitDrain(
  socket: Socket,
  msg: ServerMessage,
  writeMessage: (socket: Socket, msg: ServerMessage) => boolean,
): Promise<boolean> {
  if (socket.destroyed) return false;
  if (writeMessage(socket, msg)) return true;
  if (socket.destroyed) return false;
  await waitForDrain(socket);
  return !socket.destroyed;
}

function waitForDrain(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      socket.off('drain', settle);
      socket.off('close', settle);
      resolve();
    };
    socket.once('drain', settle);
    socket.once('close', settle);
  });
}

function replayUnknownEventsWarning(diagnostics: ReplayDiagnostics): EngineEvent | null {
  if (diagnostics.skippedUnknown === 0) return null;
  return {
    type: 'warning',
    ts: Date.now(),
    phase: 'idle',
    category: 'ipc',
    code: 'replay_unknown_events_skipped',
    transcriptSafe: true,
    message: `IPC replay skipped ${diagnostics.skippedUnknown} unknown future event(s). Upgrade diptych to display them.`,
  };
}

export async function replaySession(opts: ReplaySessionOptions): Promise<EngineEvent[]> {
  const { socket, sessionJsonlPath, writeMessage } = opts;
  const replayStart = Date.now();
  const { totalEvents, diagnostics } = await summarizeReplayEvents({ sessionJsonlPath });

  const replayed: EngineEvent[] = [];
  if (
    !(await writeAndAwaitDrain(
      socket,
      {
        kind: 'event',
        payload: {
          type: 'replay_started',
          ts: Date.now(),
          phase: 'idle',
          totalEvents,
          diagnostics,
        },
      },
      writeMessage,
    ))
  )
    return replayed;

  const warning = replayUnknownEventsWarning(diagnostics);
  if (
    warning !== null &&
    !(await writeAndAwaitDrain(socket, { kind: 'event', payload: warning }, writeMessage))
  ) {
    return replayed;
  }

  for await (const event of streamReplayEvents({ sessionJsonlPath })) {
    replayed.push(event);
    if (!(await writeAndAwaitDrain(socket, { kind: 'event', payload: event }, writeMessage))) break;
  }

  const durationMs = Date.now() - replayStart;
  const completeEvent = {
    type: 'replay_complete' as const,
    ts: Date.now(),
    phase: 'idle' as const,
    totalEvents,
    durationMs,
    diagnostics,
  };
  if (!socket.destroyed) {
    writeMessage(socket, { kind: 'event', payload: completeEvent });
  }

  return replayed;
}
