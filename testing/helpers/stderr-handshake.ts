import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerCallEvent } from '../../src/engine/calls/types.js';
import { shellQuoteArg } from '../../src/utils/shell-quote.js';

export function makeFifo(path: string): string {
  execFileSync('mkfifo', [path]);
  return path;
}

export function writeStderr(text: string): string {
  return `printf '%s' ${shellQuoteArg(text)} >&2`;
}

export function stderrHandshake(dir: string, chunks: readonly string[]) {
  const fifo = makeFifo(join(dir, 'ack'));
  const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  const boundaries: number[] = [];
  let written = 0;
  const body = chunks
    .flatMap((chunk, index) => {
      written += chunk.length;
      if (index === chunks.length - 1) return [writeStderr(chunk)];
      boundaries.push(written);
      return [writeStderr(chunk), `IFS= read -r ack < ${shellQuoteArg(fifo)} || exit 2`];
    })
    .join('\n');
  let observed = 0;
  return {
    body,
    onEvent(event: RunnerCallEvent): void {
      if (event.type !== 'call_stderr_delta') return;
      observed += event.text.length;
      while (boundaries[0] !== undefined && observed >= boundaries[0]) {
        boundaries.shift();
        writeSync(fd, 'ack\n');
      }
    },
    close: () => closeSync(fd),
  };
}
