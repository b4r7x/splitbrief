export function createLineBuffer(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer) { onLine(buffer); buffer = ''; }
    },
  };
}
