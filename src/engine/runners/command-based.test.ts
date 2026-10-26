import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
} from '../../lib/process/spawn/lifecycle.js';
import { invokeCommandBasedRunner } from './command-based.js';
import { inputTooLargeFigures } from './input-limit.js';

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

  it('refuses a {prompt} placeholder larger than the host command line takes, before it starts', async () => {
    const prompt = 'x'.repeat(2 * 1024 * 1024);
    const refusal = invokeCommandBasedRunner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ran")', '{prompt}'],
      supportPromptPlaceholder: true,
      prompt,
      projectDir: process.cwd(),
    });

    await expect(refusal).rejects.toMatchObject({ kind: 'argv-prompt-too-large' });
    const figures = inputTooLargeFigures(
      await refusal.then(
        () => '',
        (cause: Error) => cause.message,
      ),
    );
    expect(figures).toMatchObject({ unit: 'bytes', size: prompt.length });
    expect(figures.limit).toBeLessThan(prompt.length);
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
      command: 'sh',
      args: ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', codeBlock],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stdout.trim()).toBe(codeBlock);
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
      command: 'sh',
      args: ['-c', 'cat >/dev/null; echo hello'],
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
      args: ['-c', 'cat >/dev/null; echo error >&2'],
      prompt: '',
      projectDir: process.cwd(),
    });
    expect(result.stderr).toContain('error');
  });

  it('recovers from a stderr line overflow with a warning and bounded stderr', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: [
        '-e',
        [
          'require("node:fs").readFileSync(0);',
          'process.stderr.write("stderr-head\\n");',
          'process.stderr.write("x".repeat(2 * 1024 * 1024));',
          'process.stderr.write("\\nstderr-tail\\n");',
        ].join(''),
      ],
      prompt: '',
      projectDir: process.cwd(),
    });

    expect(result.callResult).toMatchObject({ status: 'completed' });
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

  it('recovers from a stdout line overflow with a warning instead of failing the call', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: [
        '-e',
        [
          'require("node:fs").readFileSync(0);',
          `process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100}) + "\\n");`,
          'process.stdout.write("after-overflow\\n");',
        ].join(''),
      ],
      prompt: '',
      projectDir: process.cwd(),
    });

    expect(result.callResult).toMatchObject({ status: 'completed' });
    expect(result.stdout).toContain('after-overflow');
    expect(result.callResult.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('stdout line exceeded'),
      }),
    );
  });

  it('spawns a child bound to the shared 64 MiB output ceiling and reaps it on breach', async () => {
    const result = await invokeCommandBasedRunner({
      command: 'node',
      args: [
        '-e',
        'require("node:fs").readFileSync(0);for (let i = 0; i < 1100; i++) process.stdout.write("y".repeat(65_536));setInterval(() => {}, 1_000);',
      ],
      prompt: '',
      projectDir: process.cwd(),
    });

    expect(result.callResult).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_process_output_limit' },
    });
  });
});
