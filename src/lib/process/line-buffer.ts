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
  let skipping = false;
  return {
    push(chunk: string) {
      buffer += chunk;
      if (skipping) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          buffer = '';
          return;
        }
        skipping = false;
        buffer = buffer.slice(newlineIndex + 1);
      }
      const maxLineBytes = options.maxLineBytes;
      if (maxLineBytes !== undefined) {
        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          const head = newlineIndex === -1 ? buffer : buffer.slice(0, newlineIndex);
          const headBytes = Buffer.byteLength(head, 'utf8');
          if (headBytes <= maxLineBytes) break;
          options.onOverflow?.(headBytes);
          if (newlineIndex === -1) {
            skipping = true;
            buffer = '';
            return;
          }
          buffer = buffer.slice(newlineIndex + 1);
        }
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
