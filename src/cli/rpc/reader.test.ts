import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCommandReader } from './reader.js';
import { RpcCommandSchema, type RpcCommand } from './types.js';

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

describe('RpcCommandSchema', () => {
  it('accepts every supported command shape', () => {
    expect(validCommands.map((command) => RpcCommandSchema.safeParse(command).success)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('rejects unknown commands and empty command payloads', () => {
    expect(RpcCommandSchema.safeParse({ type: 'unknown' }).success).toBe(false);
    expect(RpcCommandSchema.safeParse({ type: 'message', text: '' }).success).toBe(false);
    expect(RpcCommandSchema.safeParse({ type: 'recovery', action: '' }).success).toBe(false);
    expect(RpcCommandSchema.safeParse({ type: 'slash', command: '' }).success).toBe(false);
  });
});

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

  it('reports validation errors for unsupported commands', async () => {
    const commands: RpcCommand[] = [];
    const errors: string[] = [];
    const stream = createReadableInput();

    createCommandReader(
      stream,
      (command) => commands.push(command),
      (error) => errors.push(error),
    );

    stream.end('{"type":"unknown"}\n');
    await waitForReader();

    expect(commands).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid command:');
  });
});
