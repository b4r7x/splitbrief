const DEFAULT_CAPACITY = 5;

export interface RingBuffer {
  push(line: string): void;
  lines(): string[];
  clear(): void;
}

export function createRingBuffer(capacity: number = DEFAULT_CAPACITY): RingBuffer {
  const buffer: string[] = [];
  let writeIndex = 0;

  return {
    push(line: string): void {
      if (buffer.length < capacity) {
        buffer.push(line);
      } else {
        buffer[writeIndex] = line;
      }
      writeIndex = (writeIndex + 1) % capacity;
    },
    lines(): string[] {
      if (buffer.length < capacity) return buffer.slice();
      return [...buffer.slice(writeIndex), ...buffer.slice(0, writeIndex)];
    },
    clear(): void {
      buffer.length = 0;
      writeIndex = 0;
    },
  };
}
