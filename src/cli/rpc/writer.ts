import type { EngineEvent } from '../../engine/events/types.js';
import { protectConsumerPayload } from '../../engine/calls/consumer-policy.js';
import type { RpcResponse } from './types.js';

export function createResponseWriter(deps: {
  stream: NodeJS.WritableStream;
  onClose: (reason: string) => void;
}) {
  let broken = false;

  deps.stream.on('error', (err) => {
    if (broken) return;
    broken = true;
    deps.onClose(`output stream error: ${String(err)}`);
  });

  deps.stream.on('close', () => {
    if (broken) return;
    broken = true;
    deps.onClose('output stream closed');
  });

  function write(response: RpcResponse): void {
    if (broken) return;
    try {
      const protectedResponse = protectConsumerPayload({ context: 'rpc', payload: response });
      const output = protectedResponse.oversized
        ? {
            type: 'error',
            error: `omitted oversized ${response.type} response exceeding ${protectedResponse.maxBytes} bytes`,
          }
        : protectedResponse.payload;
      deps.stream.write(`${JSON.stringify(output)}\n`);
    } catch {
      broken = true;
      deps.onClose('output stream write failed');
    }
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
