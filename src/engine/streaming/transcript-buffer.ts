import type { Phase } from '../../core/schemas/enums.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { appendMessage } from '../../core/sessions/log-writer.js';

const MAX_BUFFER_BYTES = 16 * 1024;

export function createTranscriptBuffer(opts: {
  projectDir: string;
  sessionId: string;
  phase: Phase | undefined;
}): { append(chunk: string): void; flush(): void; flushInterrupted(): void } {
  const { projectDir, sessionId, phase } = opts;
  const ref: SessionRef = { projectDir, sessionId };
  let buffer = '';
  const shouldPersist = sessionId !== '';
  return {
    append(text: string): void {
      if (!shouldPersist) return;
      buffer += text;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) {
        appendMessage(ref, {
          role: 'assistant',
          ...(phase !== undefined && { phase }),
          text: buffer,
        });
        buffer = '';
      }
    },
    flush(): void {
      if (!shouldPersist || buffer.length === 0) return;
      appendMessage(ref, {
        role: 'assistant',
        ...(phase !== undefined && { phase }),
        text: buffer,
      });
      buffer = '';
    },
    flushInterrupted(): void {
      if (!shouldPersist || buffer.length === 0) return;
      appendMessage(ref, {
        role: 'assistant',
        ...(phase !== undefined && { phase }),
        text: buffer,
        interrupted: true,
      });
      buffer = '';
    },
  };
}
