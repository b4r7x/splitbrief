import { describe, it, expect } from 'vitest';
import { spawnAndCollect } from './spawn-collect.js';

describe('spawnAndCollect', () => {
  it('collects parsed text from lines', async () => {
    const outputChunks: string[] = [];
    const result = await spawnAndCollect({
      command: 'echo',
      args: ['collected'],
      cwd: '.',
      notFoundMessage: 'echo not found',
      parseLine: (line) => ({ text: line.trim() ? line + '\n' : undefined }),
      onOutput: (text) => outputChunks.push(text),
    });

    expect(result.text).toContain('collected');
    expect(outputChunks.join('')).toContain('collected');
    expect(result.usage).toBeNull();
  });

  it('accumulates usage from parsed lines', async () => {
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', 'console.log("line1"); console.log("line2")'],
      cwd: '.',
      notFoundMessage: 'node not found',
      parseLine: (line) => {
        if (line.includes('line1')) return { text: 'a', usage: { inputTokens: 10, outputTokens: 5 } };
        if (line.includes('line2')) return { text: 'b', usage: { inputTokens: 20, outputTokens: 10 } };
        return {};
      },
      onOutput: () => {},
    });

    expect(result.text).toBe('ab');
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15 });
  });
});
