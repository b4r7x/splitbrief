import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { runnerCallLineOutputLimit } from '../calls/output-limit.js';
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
      onOverflow: (overflow) => {
        const limit = runnerCallLineOutputLimit({
          code: 'stderr_line_overflow',
          label: 'the tool error output',
          lineBytes: overflow.lineBytes,
          maxLineBytes: STDERR_LINE_MAX_BYTES,
        });
        recorder.warning({
          warning: { code: limit.code, message: limit.message },
        });
      },
    },
  );
}
