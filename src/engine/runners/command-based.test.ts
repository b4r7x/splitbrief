import { describe, expect, it } from 'vitest';
import { DEFAULT_PROCESS_STDERR_MAX_BYTES } from '../../lib/process/spawn/types.js';
import { invokeCommandRunner } from './command-based.js';

function run(
  command: string,
  args: readonly string[],
  prompt: string,
  extra: Partial<Parameters<typeof invokeCommandRunner>[0]> = {},
) {
  return invokeCommandRunner({
    source: {
      kind: 'config',
      runner: { command, args },
      env: process.env,
      notFoundMessage: `Shell planner command not found: ${command}`,
    },
    prompt,
    cwd: process.cwd(),
    callContext: { callId: 'call-test', role: 'planner', backendKind: 'shell' },
    ...extra,
  });
}

describe('invokeCommandRunner', () => {
  it('writes the prompt to stdin', async () => {
    const result = await run('cat', [], 'test prompt');
    expect(result.text).toContain('test prompt');
  });

  it('passes {prompt} in an argument through as plain text', async () => {
    const result = await run('printf', ['%s', '{prompt}'], 'ignored');
    expect(result.text.trim()).toBe('{prompt}');
  });

  it('returns stdout without extracting code', async () => {
    const codeBlock = '```js\nconsole.log("hi")\n```';
    const result = await run(
      'sh',
      ['-c', 'cat >/dev/null; printf "%s\n" "$1"', 'sh', codeBlock],
      '',
    );
    expect(result.text.trim()).toBe(codeBlock);
  });

  it('names the seat when the command is not found', async () => {
    await expect(run('nonexistent-command-xyz', [], 'prompt')).rejects.toThrow(
      'Shell planner command not found: nonexistent-command-xyz',
    );
  });

  it('streams stdout chunks to the output subscriber', async () => {
    const chunks: string[] = [];
    await run('sh', ['-c', 'cat >/dev/null; echo hello'], '', {
      onOutput: (text: string) => {
        chunks.push(text);
      },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('hello');
  });

  it('streams stderr to the stderr subscriber', async () => {
    const stderr: string[] = [];
    await run('sh', ['-c', 'cat >/dev/null; echo error >&2'], '', {
      onStderr: (chunk) => {
        stderr.push(chunk);
      },
    });
    expect(stderr.join('')).toContain('error');
  });

  it('recovers from a stderr line overflow with a warning and bounded stderr', async () => {
    const recorded: string[] = [];
    const result = await run(
      'node',
      [
        '-e',
        [
          'require("node:fs").readFileSync(0);',
          'process.stderr.write("stderr-head\\n");',
          'process.stderr.write("x".repeat(2 * 1024 * 1024));',
          'process.stderr.write("\\nstderr-tail\\n");',
        ].join(''),
      ],
      '',
      {
        onCallEvent: (event) => {
          if (event.type === 'call_stderr_delta') recorded.push(event.text);
        },
      },
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(recorded).toEqual(['stderr-head', 'stderr-tail']);
    expect(Buffer.byteLength(recorded.join(''), 'utf8')).toBeLessThanOrEqual(
      DEFAULT_PROCESS_STDERR_MAX_BYTES,
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stderr_line_overflow',
        message: expect.stringContaining('A line of the tool error output longer than'),
      }),
    );
  });

  it('returns a single stdout answer line above 1 MiB whole, with no warning on screen', async () => {
    const lineBytes = 1024 * 1024 + 100;
    const result = await run(
      'node',
      [
        '-e',
        `require("node:fs").readFileSync(0);process.stdout.write("x".repeat(${lineBytes}) + "\\n");`,
      ],
      '',
    );

    expect(result).toMatchObject({ status: 'completed', error: null });
    expect(result.text.length).toBe(lineBytes + 1);
    expect(result.text.replaceAll('x', '')).toBe('\n');
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'runner_call_text_limit', surface: 'debug' }),
    ]);
  });

  it('returns the whole stdout of a shell seat when it is larger than 1 MB', async () => {
    const lineCount = 2_048;
    const result = await run(
      'node',
      [
        '-e',
        `require("node:fs").readFileSync(0);for (let i = 0; i < ${lineCount}; i++) process.stdout.write("a".repeat(1_023) + "\\n");`,
      ],
      '',
    );

    expect(result).toMatchObject({ status: 'completed', error: null });
    expect(result.text.replaceAll('\n', '').length).toBe(lineCount * 1_023);
  });

  it('keeps a shell seat running past the 64 MiB output bound and keeps its final answer', async () => {
    const result = await run(
      'node',
      [
        '-e',
        'require("node:fs").readFileSync(0);for (let i = 0; i < 1100; i++) process.stdout.write("y".repeat(65_535) + "\\n");process.stdout.write("final answer\\n");',
      ],
      '',
    );

    expect(result).toMatchObject({ status: 'completed', error: null });
    expect(result.text.trimEnd().endsWith('final answer')).toBe(true);
  }, 60_000);
});
