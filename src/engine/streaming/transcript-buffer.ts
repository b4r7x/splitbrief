import type { Phase } from '../../core/schemas/enums.js';
import { appendMessage } from '../../core/state/persistence.js';

const MAX_BUFFER_BYTES = 16 * 1024;

export function createTranscriptBuffer(
  projectDir: string,
  sessionId: string,
  phase: Phase | undefined,
  persistTranscript: boolean,
): { append(chunk: string): void; flush(): void; flushInterrupted(): void } {
  let buffer = '';
  return {
    append(text: string): void {
      if (!persistTranscript) return;
      buffer += text;
      if (buffer.length > MAX_BUFFER_BYTES) {
        appendMessage(projectDir, sessionId, { role: 'assistant', ...(phase !== undefined && { phase }), text: buffer }, persistTranscript);
        buffer = '';
      }
    },
    flush(): void {
      if (!persistTranscript || buffer.length === 0) return;
      appendMessage(projectDir, sessionId, { role: 'assistant', ...(phase !== undefined && { phase }), text: buffer }, persistTranscript);
      buffer = '';
    },
    flushInterrupted(): void {
      if (!persistTranscript || buffer.length === 0) return;
      appendMessage(projectDir, sessionId, { role: 'assistant', ...(phase !== undefined && { phase }), text: buffer, interrupted: true }, persistTranscript);
      buffer = '';
    },
  };
}
