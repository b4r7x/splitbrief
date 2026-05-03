import type { EngineEvent } from '../../engine/events/types.js';
import type { RpcResponse } from './types.js';

export function createResponseWriter(stream: NodeJS.WritableStream) {
  function write(response: RpcResponse): void {
    stream.write(`${JSON.stringify(response)}\n`);
  }

  return {
    ack(command: string, data?: unknown): void {
      write({ type: 'ack', command, data });
    },
    error(message: string): void {
      write({ type: 'error', error: message });
    },
    status(data: unknown): void {
      write({ type: 'status', data });
    },
    event(engineEvent: EngineEvent): void {
      write({ type: 'event', data: engineEvent });
    },
  };
}
