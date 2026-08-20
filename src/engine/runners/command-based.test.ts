import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
} from '../../lib/process/spawn/lifecycle.js';
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

  it('rejects shell-evaluated {prompt} placeholders by default', async () => {
    await expect(
      invokeCommandBasedRunner({
        command: 'sh',
        args: ['-c', 'echo "{prompt}"'],
        supportPromptPlaceholder: true,
        prompt: 'substituted text',
        projectDir: process.cwd(),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-shell-evaluated-prompt',
    });
  });

  it('allows shell-evaluated {prompt} placeholders when runner trust is explicit', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'sh',
      args: ['-c', 'echo "{prompt}"'],
      supportPromptPlaceholder: true,
      allowShellEvaluatedPrompt: true,
      prompt: 'substituted text',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe('substituted text');
  });

  it('rejects {prompt} placeholder in the executable command string', async () => {
    await expect(
      invokeCommandBasedRunner({
        command: 'echo-{prompt}',
        supportPromptPlaceholder: true,
        prompt: 'unsafe',
        projectDir: process.cwd(),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-command-prompt-placeholder',
    });
  });

  it('rejects {prompt} placeholder in the executable command string without placeholder support', async () => {
    await expect(
      invokeCommandBasedRunner({
        command: 'echo-{prompt}',
        prompt: 'unsafe',
        projectDir: process.cwd(),
      }),
    ).rejects.toMatchObject({
      kind: 'runner-command-prompt-placeholder',
    });
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

  it('uses stdin when supportPromptPlaceholder is enabled but args have no marker', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'cat',
      args: [],
      supportPromptPlaceholder: true,
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

  it('treats a stderr line overflow as a fatal truncation with bounded stderr', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: [
        '-e',
        [
          'process.stderr.write("stderr-head\\n");',
          'process.stderr.write("x".repeat(2 * 1024 * 1024));',
          'process.stderr.write("\\nstderr-tail\\n");',
        ].join(''),
      ],
      prompt: '',
      projectDir: process.cwd(),
    });

    expect(result.callResult).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'stderr_line_overflow' },
    });
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_PROCESS_STDERR_MAX_BYTES,
    );
    expect(result.callResult.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stderr_line_overflow',
        message: expect.stringContaining('stderr line exceeded'),
      }),
    );
  });

  it('treats a stdout line overflow as a fatal truncation that stops the collection', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: [
        '-e',
        [
          `process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100}) + "\\n");`,
          'process.stdout.write("after-overflow\\n");',
        ].join(''),
      ],
      prompt: '',
      projectDir: process.cwd(),
    });

    expect(result.callResult).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'stdout_line_overflow' },
    });
    expect(result.stdout).not.toContain('after-overflow');
    expect(result.callResult.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('stdout line exceeded'),
      }),
    );
  });
});
