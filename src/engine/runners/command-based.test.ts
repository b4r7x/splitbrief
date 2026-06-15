import { describe, expect, it } from 'vitest';
import { invokeCommandBasedRunner } from './command-based.js';

describe('invokeCommandBasedRunner', () => {
  it('writes prompt to stdin when no placeholder present', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'cat',
      prompt: 'test prompt',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('test prompt');
  });

  it('substitutes {prompt} placeholder in args', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'echo',
      args: ['{prompt}'],
      supportPromptPlaceholder: true,
      prompt: 'hello world',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('substitutes {prompt} placeholder in command', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', 'echo "{prompt}"'],
      supportPromptPlaceholder: true,
      prompt: 'substituted text',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('substituted text');
  });

  it('keeps $-replacement patterns in the prompt inert', async () => {
    const prompt = 'a $& b $$ c $` d';
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s', '{prompt}'],
      supportPromptPlaceholder: true,
      prompt,
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe(prompt);
  });

  it('substitutes every {prompt} occurrence in an arg', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s', '{prompt}-{prompt}'],
      supportPromptPlaceholder: true,
      prompt: 'x',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('x-x');
  });

  it('uses stdin when supportPromptPlaceholder is false', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'cat',
      args: [],
      supportPromptPlaceholder: false,
      prompt: 'stdin content',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('stdin content');
  });

  it('returns stdout without extracting code', async () => {
    const codeBlock = '```js\nconsole.log("hi")\n```';
    const result = await invokeCommandBasedRunner({
      command: 'echo',
      args: [codeBlock],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('console.log');
  });

  it('propagates command-not-found error', async () => {
    await expect(
      invokeCommandBasedRunner({
        command: 'nonexistent-command-xyz',
        prompt: 'prompt',
        projectDir: process.cwd(),
      }),
    ).rejects.toThrow(/Command not found/);
  });

  it('streams stdout chunks to the output subscriber', async () => {
    const chunks: string[] = [];
    await invokeCommandBasedRunner({
      command: 'echo',
      args: ['hello'],
      prompt: '',
      projectDir: process.cwd(),
      onOutput: (text: string) => {
        chunks.push(text);
      },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('hello');
  });

  it('captures stderr', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', 'echo error >&2'],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stderr).toContain('error');
  });

  it('returns stdout and stderr', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'echo',
      args: ['output'],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toContain('output');
  });

  it('parses stream-json through the format pipeline on the timeout branch', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'parsed body' }] },
    });
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', line],
      outputFormat: 'stream-json',
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toBe('parsed body');
    expect(result.stdout).not.toContain('assistant');
  });

  it('accumulates usage from stream-json on the timeout branch', async () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const result = await invokeCommandBasedRunner({
      command: 'printf',
      args: ['%s\\n', line],
      outputFormat: 'stream-json',
      timeout: 30_000,
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout).toBe('done');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });
});
