export type LineBufferOptions<T = void> = {
  maxLineBytes?: number | undefined;
  onOverflow?: ((overflow: LineBufferOverflow) => T) | undefined;
  onUnterminated?: ((overflow: LineBufferUnterminated) => T) | undefined;
};

export interface LineBufferOverflow {
  readonly lineBytes: number;
  readonly maxLineBytes: number;
  readonly truncated: true;
}

export interface LineBufferUnterminated {
  readonly lineBytes: number;
  readonly maxLineBytes: number;
  readonly unterminated: true;
}

export function createLineBuffer<T = void>(
  onLine: (line: string) => T,
  options: LineBufferOptions<T> = {},
): {
  push(chunk: string): T | undefined;
  flush(): T | undefined;
} {
  let buffer = '';
  let lineBytes = 0;
  let pendingHighSurrogate = false;
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

  const resetLine = () => {
    buffer = '';
    lineBytes = 0;
    pendingHighSurrogate = false;
  };

  const segmentByteLength = (segment: string): number => {
    let bytes = Buffer.byteLength(segment, 'utf8');
    if (
      pendingHighSurrogate &&
      segment.length > 0 &&
      segment.charCodeAt(0) >= 0xdc00 &&
      segment.charCodeAt(0) <= 0xdfff
    ) {
      bytes -= 2;
    }
    const lastCodeUnit = segment.charCodeAt(segment.length - 1);
    pendingHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
    return bytes;
  };

  const processSegment = (segment: string, maxLineBytes: number): void => {
    const segmentBytes = segmentByteLength(segment);
    const nextLineBytes = lineBytes + segmentBytes;
    if (nextLineBytes > maxLineBytes) {
      lineBytes = nextLineBytes;
      emitOverflow(lineBytes, maxLineBytes);
      resetLine();
      skipping = true;
      return;
    }
    buffer += segment;
    lineBytes = nextLineBytes;
  };

  return {
    push(chunk: string) {
      callbackResult = undefined;
      const maxLineBytes = options.maxLineBytes;
      let offset = 0;
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf('\n', offset);
        if (skipping) {
          if (newlineIndex === -1) {
            lineBytes += segmentByteLength(chunk.slice(offset));
            return callbackResult;
          }
          offset = newlineIndex + 1;
          resetLine();
          skipping = false;
          continue;
        }

        const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
        const segment = chunk.slice(offset, segmentEnd);
        if (maxLineBytes === undefined) {
          buffer += segment;
        } else {
          processSegment(segment, maxLineBytes);
          if (skipping) {
            if (callbackResult !== undefined) return callbackResult;
            if (newlineIndex === -1) return callbackResult;
            skipping = false;
            resetLine();
            offset = newlineIndex + 1;
            continue;
          }
        }

        if (newlineIndex === -1) {
          return callbackResult;
        }

        captureResult(onLine(framed(buffer)));
        resetLine();
        offset = newlineIndex + 1;

        // A signaled result is terminal for the stream: the caller tears the producer down, so no
        // later line of this chunk may reach the callback.
        if (callbackResult !== undefined) return callbackResult;
      }
      return callbackResult;
    },
    flush() {
      callbackResult = undefined;
      if (skipping) {
        skipping = false;
        resetLine();
        return callbackResult;
      }

      const maxLineBytes = options.maxLineBytes;
      if (!buffer) return callbackResult;
      if (maxLineBytes !== undefined) {
        if (options.onUnterminated !== undefined) {
          captureResult(
            options.onUnterminated({
              lineBytes,
              maxLineBytes,
              unterminated: true,
            }),
          );
          resetLine();
          return callbackResult;
        }
        // Keep the original bounded-stream contract for callers that only expose an overflow
        // callback: a clean process exit must not turn an oversized unterminated tail into a
        // line callback after the live chunk path already enforces the cap.
        if (lineBytes > maxLineBytes) {
          emitOverflow(lineBytes, maxLineBytes);
          resetLine();
          return callbackResult;
        }
      }

      const line = framed(buffer);
      resetLine();
      captureResult(onLine(line));
      return callbackResult;
    },
  };
}
