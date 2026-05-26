import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCommandReader } from './reader.js';
import type { RpcCommand } from './types.js';

const validCommands: RpcCommand[] = [
  { type: 'approve' },
  { type: 'reject' },
  { type: 'reject', comment: 'needs changes' },
  { type: 'message', text: 'continue with the task' },
  { type: 'recovery', action: 'retry-same-worker' },
  { type: 'status' },
  { type: 'abort' },
  { type: 'slash', command: '/mode quick' },
];

function createReadableInput(): PassThrough {
  return new PassThrough();
}

async function waitForReader(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('createCommandReader', () => {
  it('parses non-empty JSON lines into commands', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader(
      stream,
      (command) => commands.push(command),
      (error) => errors.push(error),
    );

    stream.end(`\n${validCommands.map((command) => JSON.stringify(command)).join('\n')}\n\n`);
    await waitForReader();

    expect(commands).toEqual(validCommands);
    expect(errors).toEqual([]);
  });

  it('reports invalid JSON without emitting a command', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader(
      stream,
      (command) => commands.push(command),
      (error) => errors.push(error),
    );

    stream.end('not json\n');
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toEqual(['Invalid JSON: not json']);
  });

  it('calls onClose when stdin ends', async () => {
    let closed = false;
    const stream = createReadableInput();

    createCommandReader(
      stream,
      () => {},
      () => {},
      () => { closed = true; },
    );

    stream.end();
    await waitForReader();

    expect(closed).toBe(true);
  });

  it('reports validation errors for unsupported commands and empty payloads', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader(
      stream,
      (command) => commands.push(command),
      (error) => errors.push(error),
    );

    stream.end([
      '{"type":"unknown"}',
      '{"type":"message","text":""}',
      '{"type":"recovery","action":""}',
      '{"type":"slash","command":""}',
    ].join('\n'));
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors.every((error) => error.startsWith('Invalid command:'))).toBe(true);
  });
});
