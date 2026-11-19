import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeFifo } from '#testing/helpers/stderr-handshake.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { spawnAndCollect } from './collect.js';

it('publishes a parsed error before the command finishes reading the prompt', async () => {
  await withTempDir('prompt-delivery-ack', async (cwd) => {
    const fifo = makeFifo(join(cwd, 'ack'));
    const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    const stdin = 'x'.repeat(1024 * 1024);
    const order: string[] = [];

    let releasedBy: string | undefined;
    function acknowledge(marker: string): void {
      if (releasedBy !== undefined) return;
      releasedBy = marker;
      writeSync(fd, 'ok\n');
    }

    try {
      const result = await spawnAndCollect({
        command: '/bin/sh',
        args: [
          '-c',
          `printf '%s\\n' '{"type":"result","is_error":true,"result":"Startup failed"}'
           IFS= read -r ack < "$1" || exit 2
           size=$(wc -c | tr -d ' ')
           printf 'Consumed %s bytes\\n' "$size" >&2`,
          'fixture',
          fifo,
        ],
        stdin,
        format: 'stream-json',
        cwd,
        callContext: { callId: 'prompt-delivery', role: 'implementer', backendKind: 'shell' },
        onCallEvent(event) {
          if (event.type === 'call_error') {
            order.push(event.error.code);
            acknowledge('call_error');
          }
        },
        onText(text) {
          if (text === 'Startup failed') queueMicrotask(() => acknowledge('onText'));
        },
        onStderr(text) {
          order.push(text.trim());
        },
      });

      expect(result.error?.code).toBe('runner_result_error');
      expect(releasedBy).toBe('call_error');
      expect(order).toEqual(['runner_result_error', `Consumed ${stdin.length} bytes`]);
    } finally {
      closeSync(fd);
    }
  });
});
