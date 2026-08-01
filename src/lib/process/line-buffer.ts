export type LineBufferOptions<T = void> = {
  maxLineBytes?: number | undefined;
  onOverflow?: ((overflow: LineBufferOverflow) => T) | undefined;
};

export interface LineBufferOverflow {
  readonly lineBytes: number;
  readonly maxLineBytes: number;
  readonly truncated: true;
}

export function createLineBuffer<T = void>(
  onLine: (line: string) => T,
  options: LineBufferOptions<T> = {},
): {
  push(chunk: string): T | undefined;
  flush(): T | undefined;
} {
  let buffer = '';
  let skipping = false;
  // CRLF-terminated output frames to the same lines as LF output; every runner
  // parses the framed line, never the carriage return.
  const framed = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  let callbackResult: T | undefined;
  const captureResult = (result: T | undefined) => {
    if (callbackResult === undefined && result !== undefined) callbackResult = result;
  };
  const emitOverflow = (lineBytes: number, maxLineBytes: number) => {
    captureResult(
      options.onOverflow?.({
        lineBytes,
        maxLineBytes,
        truncated: true,
      }),
    );
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
      callbackResult = undefined;
      if (skipping) {
        const newlineIndex = chunk.indexOf('\n');
        if (newlineIndex === -1) return callbackResult;
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
          captureResult(onLine(framed(line)));
        } else {
          const lineBytes = Buffer.byteLength(line, 'utf8');
          if (lineBytes > maxLineBytes) emitOverflow(lineBytes, maxLineBytes);
          else captureResult(onLine(framed(line)));
        }

        // A signaled result is terminal for the stream: the caller tears the producer down, so no
        // later line of this chunk may reach the callback.
        if (callbackResult !== undefined) return callbackResult;
      }

      if (maxLineBytes !== undefined && discardOversizedTail(maxLineBytes)) {
        skipping = true;
      }
      return callbackResult;
    },
    flush() {
      callbackResult = undefined;
      if (skipping) {
        skipping = false;
        return callbackResult;
      }

      const maxLineBytes = options.maxLineBytes;
      if (maxLineBytes !== undefined && discardOversizedTail(maxLineBytes)) {
        return callbackResult;
      }

      if (!buffer) return callbackResult;
      const line = framed(buffer);
      buffer = '';
      captureResult(onLine(line));
      return callbackResult;
    },
  };
}
