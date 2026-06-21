import { createInterface } from 'node:readline';
import { parseJsonLine } from '../json-line.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { RPC_MAX_FRAME_BYTES, RpcCommandSchema, type RpcCommand } from './types.js';

export interface CommandReaderOptions {
  stream: NodeJS.ReadableStream;
  onCommand: (cmd: RpcCommand) => void;
  onError: (err: string) => void;
  onClose?: (() => void) | undefined;
}

export function createCommandReader(options: CommandReaderOptions): { close: () => void } {
  const { stream, onCommand, onError, onClose } = options;
  const rl = createInterface({ input: stream, terminal: false });
  const lineBuffer = createLineBuffer(
    (line) => {
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
    },
    {
      maxLineBytes: RPC_MAX_FRAME_BYTES,
      onOverflow: (overflow) => onError(`RPC frame too large: ${overflow.lineBytes} bytes`),
    },
  );

  rl.on('line', (line) => {
    lineBuffer.push(`${line}\n`);
  });

  if (onClose) {
    rl.on('close', onClose);
  }

  return { close: () => rl.close() };
}
