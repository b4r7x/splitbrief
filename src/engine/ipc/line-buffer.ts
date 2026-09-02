export type SocketLineBufferOptions = {
  maxLineBytes: number;
  onLine: (line: string) => void;
  onOverflow: (lineBytes: number) => void;
};

export type SocketLineBuffer = {
  push(chunk: Buffer): void;
  bufferedBytes(): number;
};

export function createSocketLineBuffer(opts: SocketLineBufferOptions): SocketLineBuffer {
  const lineParts: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;
  let overflowReported = false;

  function append(segment: Buffer): void {
    if (oversized || segment.length === 0) return;
    const remaining = opts.maxLineBytes - lineBytes;
    if (segment.length > remaining) {
      if (remaining > 0) lineParts.push(segment.subarray(0, remaining));
      lineBytes = opts.maxLineBytes;
      oversized = true;
      if (!overflowReported) {
        overflowReported = true;
        opts.onOverflow(opts.maxLineBytes + 1);
      }
      return;
    }
    lineParts.push(segment);
    lineBytes += segment.length;
  }

  function finish(): void {
    if (oversized) {
      if (!overflowReported) opts.onOverflow(opts.maxLineBytes + 1);
    } else {
      const line = Buffer.concat(lineParts, lineBytes).toString('utf8');
      opts.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    lineParts.length = 0;
    lineBytes = 0;
    oversized = false;
    overflowReported = false;
  }

  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, offset);
        const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
        append(chunk.subarray(offset, segmentEnd));
        if (newlineIndex === -1) return;
        finish();
        offset = newlineIndex + 1;
      }
    },
    bufferedBytes() {
      return lineBytes;
    },
  };
}
