export type LineBufferOptions = {
  maxLineBytes?: number | undefined;
  onOverflow?: ((overflow: LineBufferOverflow) => void) | undefined;
};

export interface LineBufferOverflow {
  readonly lineBytes: number;
  readonly maxLineBytes: number;
  readonly truncated: true;
}

export function createLineBuffer(
  onLine: (line: string) => void,
  options: LineBufferOptions = {},
): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  let skipping = false;
  const emitOverflow = (lineBytes: number, maxLineBytes: number) => {
    options.onOverflow?.({
      lineBytes,
      maxLineBytes,
      truncated: true,
    });
  };

  const discardOversizedTail = (maxLineBytes: number) => {
    const lineBytes = Buffer.byteLength(buffer, 'utf8');
    if (lineBytes <= maxLineBytes) return false;
    emitOverflow(lineBytes, maxLineBytes);
    buffer = '';
    return true;
  };

  return {
    push(chunk: string) {
      if (skipping) {
        const newlineIndex = chunk.indexOf('\n');
        if (newlineIndex === -1) return;
        skipping = false;
        buffer = chunk.slice(newlineIndex + 1);
      } else {
        buffer += chunk;
      }

      const maxLineBytes = options.maxLineBytes;

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (maxLineBytes === undefined) {
          onLine(line);
          continue;
        }

        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (lineBytes > maxLineBytes) {
          emitOverflow(lineBytes, maxLineBytes);
          continue;
        }

        onLine(line);
      }

      if (maxLineBytes !== undefined && discardOversizedTail(maxLineBytes)) {
        skipping = true;
      }
    },
    flush() {
      if (skipping) {
        skipping = false;
        return;
      }

      const maxLineBytes = options.maxLineBytes;
      if (maxLineBytes !== undefined && discardOversizedTail(maxLineBytes)) {
        return;
      }

      if (!buffer) return;
      onLine(buffer);
      buffer = '';
    },
  };
}
