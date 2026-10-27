import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESS_LINE_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
} from '../../lib/process/spawn/lifecycle.js';
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

  it('recovers from a stdout line overflow with a warning instead of failing the call', async () => {
    const result = await run(
      'node',
      [
        '-e',
        [
          'require("node:fs").readFileSync(0);',
          `process.stdout.write("x".repeat(${DEFAULT_PROCESS_LINE_MAX_BYTES + 100}) + "\\n");`,
          'process.stdout.write("after-overflow\\n");',
        ].join(''),
      ],
      '',
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(result.text).toContain('after-overflow');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stdout_line_overflow',
        message: expect.stringContaining('A line of the tool output longer than'),
      }),
    );
  });

  it('spawns a child bound to the shared 64 MiB output ceiling and reaps it on breach', async () => {
    const result = await run(
      'node',
      [
        '-e',
        'require("node:fs").readFileSync(0);for (let i = 0; i < 1100; i++) process.stdout.write("y".repeat(65_536));setInterval(() => {}, 1_000);',
      ],
      '',
    );

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_process_output_limit' },
    });
  });
});
