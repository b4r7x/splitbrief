export type LineBufferOptions = {
  maxLineBytes?: number | undefined;
  onOverflow?: ((bytes: number) => void) | undefined;
};

export function createLineBuffer(
  onLine: (line: string) => void,
  options: LineBufferOptions = {},
): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  let overflowed = false;
  return {
    push(chunk: string) {
      if (overflowed) return;
      buffer += chunk;
      const maxLineBytes = options.maxLineBytes;
      if (maxLineBytes !== undefined && Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        overflowed = true;
        options.onOverflow?.(Buffer.byteLength(buffer, 'utf8'));
        buffer = '';
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer) {
        onLine(buffer);
        buffer = '';
      }
    },
  };
}
