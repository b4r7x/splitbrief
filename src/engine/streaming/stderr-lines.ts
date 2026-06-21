import { createLineBuffer } from '../../lib/process/line-buffer.js';
import type { RunnerCallRecorder } from '../calls/recorder.js';

const STDERR_LINE_MAX_BYTES = 8 * 1024;

export function createRunnerCallStderrBuffer(recorder: RunnerCallRecorder): {
  push(chunk: string): void;
  flush(): void;
} {
  return createLineBuffer(
    (line) => {
      if (line.length > 0) recorder.stderr({ text: line });
    },
    {
      maxLineBytes: STDERR_LINE_MAX_BYTES,
      onOverflow: () => {
        recorder.warning({
          warning: {
            code: 'stderr_line_overflow',
            message: `stderr line exceeded ${STDERR_LINE_MAX_BYTES} bytes and was skipped`,
          },
        });
      },
    },
  );
}
