import { describe, expect, it } from 'vitest';
import { spawnAndCollect } from '../../../src/engine/streaming/spawn-collect.js';
import { parseJsonlLine } from '../../../src/engine/streaming/output-parsers.js';

describe('CLI implementer JSONL parsing', () => {
  it('parses codex-style JSONL into human-readable text', async () => {
    const jsonlOutput = [
      JSON.stringify({ type: 'thread.started', thread_id: 'sess_123' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          content: [{ type: 'output_text', text: 'Created the file successfully.' }],
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ].join('\n');

    const script = `process.stdout.write(${JSON.stringify(jsonlOutput + '\n')})`;

    const collected: string[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      parseLine: parseJsonlLine,
      onText: (text) => collected.push(text),
    });

    expect(result.text).toContain('Created the file successfully.');
    expect(result.text).not.toContain('"type":"item.completed"');
    expect(result.text).not.toContain('"type":"thread.started"');
    expect(collected.join('')).toContain('Created the file successfully.');
    expect(result.sessionId).toBe('sess_123');
  });

  it('falls back to text parsing for plain-text CLI output', async () => {
    const plainOutput = 'Applied changes to src/main.ts\nDone.\n';
    const script = `process.stdout.write(${JSON.stringify(plainOutput)})`;

    const collected: string[] = [];
    const result = await spawnAndCollect({
      command: 'node',
      args: ['-e', script],
      cwd: process.cwd(),
      onText: (text) => collected.push(text),
    });

    expect(result.text).toContain('Applied changes to src/main.ts');
    expect(result.text).toContain('Done.');
  });
});
