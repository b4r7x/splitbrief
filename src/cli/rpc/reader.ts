import { createInterface } from 'node:readline';
import { RpcCommandSchema, type RpcCommand } from './types.js';

export function createCommandReader(
  stream: NodeJS.ReadableStream,
  onCommand: (cmd: RpcCommand) => void,
  onError: (err: string) => void,
): { close: () => void } {
  const rl = createInterface({ input: stream, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onError(`Invalid JSON: ${trimmed}`);
      return;
    }

    const result = RpcCommandSchema.safeParse(parsed);
    if (result.success) {
      onCommand(result.data);
      return;
    }

    onError(`Invalid command: ${result.error.message}`);
  });

  return { close: () => rl.close() };
}
