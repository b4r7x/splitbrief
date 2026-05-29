import { createInterface } from 'node:readline';
import { parseJsonLine } from '../json-line.js';
import { RpcCommandSchema, type RpcCommand } from './types.js';

export interface CommandReaderOptions {
  stream: NodeJS.ReadableStream;
  onCommand: (cmd: RpcCommand) => void;
  onError: (err: string) => void;
  onClose?: (() => void) | undefined;
}

export function createCommandReader(options: CommandReaderOptions): { close: () => void } {
  const { stream, onCommand, onError, onClose } = options;
  const rl = createInterface({ input: stream, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsed = parseJsonLine(trimmed);
    if (parsed === undefined) {
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

  if (onClose) {
    rl.on('close', onClose);
  }

  return { close: () => rl.close() };
}
