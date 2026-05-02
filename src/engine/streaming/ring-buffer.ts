const DEFAULT_CAPACITY = 5;

export interface RingBuffer {
  push(line: string): void;
  lines(): string[];
  clear(): void;
}

export function createRingBuffer(capacity: number = DEFAULT_CAPACITY): RingBuffer {
  const buffer: string[] = [];
  let writeIndex = 0;
  let count = 0;

  return {
    push(line: string): void {
      if (buffer.length < capacity) {
        buffer.push(line);
      } else {
        buffer[writeIndex] = line;
      }
      writeIndex = (writeIndex + 1) % capacity;
      count = Math.min(count + 1, capacity);
    },
    lines(): string[] {
      if (buffer.length < capacity) return buffer.slice();
      const start = writeIndex;
      const result: string[] = [];
      for (let i = 0; i < count; i++) {
        result.push(buffer[(start + i) % capacity]!);
      }
      return result;
    },
    clear(): void {
      buffer.length = 0;
      writeIndex = 0;
      count = 0;
    },
  };
}

export { DEFAULT_CAPACITY };