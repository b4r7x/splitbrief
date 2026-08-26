import { describe, it, expect } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { ImplementerPublisher } from './types.js';
import type { RunnerGate } from '../runners/prepared-execution.js';
import { makeConfig as makeBaseConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createImplementer } from '../runners/factory.js';

type ShellConfig = Extract<Config['implementer'], { kind: 'shell' }>;

function makeConfig(extra?: Partial<ShellConfig>): Config {
  return makeBaseConfig({
    implementer: {
      model: 'test',
      contextLength: 8192,
      temperature: 0.3,
      kind: 'shell',
      command: 'my-ai-tool',
      outputFormat: 'text',
      ...extra,
    },
  });
}

const context = { ...defaultContext, dir: '/tmp' };

function implementerAuthority(config: Config) {
  const preparationId = 'shell-implementer-test';
  const slot = { role: 'implementer', profile: 'default' } as const;
  const gates: readonly RunnerGate[] = [
    {
      kind: 'shell',
      slot,
      preparationId,
      command: { kind: 'validated-config' },
    },
  ];
  return { preparedConfig: config, preparationId, gates, slot };
}

async function implementTask(
  task: ReturnType<typeof makeTask>,
  opts: {
    projectDir: string;
    config: Config;
    context: typeof defaultContext;
    onOutput: (text: string) => void;
  },
) {
  const implementer = await createImplementer(opts.config, implementerAuthority(opts.config));
  return implementer.implement({ ...opts, task });
}

async function retryTask(
  task: ReturnType<typeof makeTask>,
  opts: {
    projectDir: string;
    config: Config;
    context: typeof defaultContext;
    error: string;
    attempt: number;
    onOutput: (text: string) => void;
  },
) {
  const implementer = await createImplementer(opts.config, implementerAuthority(opts.config));
  return implementer.retry({ ...opts, task, kind: 'local' });
}

describe('shell implementer', () => {
  it('implementTask dispatches to shell when kind is shell (empty stdout → extraction fails)', async () => {
    const config = makeConfig({ command: '/bin/sh', args: ['-c', 'cat >/dev/null'] });
    const task = makeTask();

    const result = await implementTask(task, {
      projectDir: '/tmp',
      config,
      context,
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/extract|code/i);
    }
  });

  it('returns failure on non-zero exit code with no output', async () => {
    const config = makeConfig({ command: '/usr/bin/false' });
    const task = makeTask();

    const result = await implementTask(task, {
      projectDir: '/tmp',
      config,
      context,
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('throws on command not found (ENOENT)', async () => {
    const config = makeConfig({ command: 'nonexistent-command-that-does-not-exist-xyz' });
    const task = makeTask();

    await expect(
      implementTask(task, { projectDir: '/tmp', config, context, onOutput: () => {} }),
    ).rejects.toThrow(/command not found|ENOENT/);
  });

  it('throws a timeout error when the shell command outlives the configured timeout', async () => {
    const config = makeConfig({ command: '/bin/sleep', args: ['10'], timeout: 200 });
    const task = makeTask();

    await expect(
      implementTask(task, { projectDir: '/tmp', config, context, onOutput: () => {} }),
    ).rejects.toThrow(/timed out/);
  });

  it('successful code extraction from stdout with fenced code', async () => {
    const codeOutput = '```typescript\nexport function hello() { return "hi"; }\n```';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', codeOutput] });
    const task = makeTask();

    const result = await implementTask(task, {
      projectDir: '/tmp',
      config,
      context,
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('reports progress via onOutput callback', async () => {
    const code = 'export const x = 1;\n';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', code] });
    const task = makeTask();
    const progressCalls: string[] = [];

    await implementTask(task, {
      projectDir: '/tmp',
      config,
      context,
      onOutput: (text) => {
        progressCalls.push(text);
      },
    });

    expect(progressCalls.join('')).toContain('export const x = 1;');
  });

  it('retry passes error context to the prompt', async () => {
    const config = makeConfig({ command: '/bin/cat' });
    const task = makeTask();
    const progressCalls: string[] = [];

    await retryTask(task, {
      projectDir: '/tmp',
      config,
      context,
      error: 'TypeError: x is not a function',
      attempt: 1,
      onOutput: (text) => {
        progressCalls.push(text);
      },
    });

    const fullOutput = progressCalls.join('');
    expect(fullOutput).toContain('TypeError: x is not a function');
  });

  it('threads a configured idleWarnMs override into the spawn', async () => {
    const config = makeConfig({ command: 'bash', args: ['-c', 'sleep 0.15'], idleWarnMs: 30 });
    const task = makeTask();
    const events: RunnerCallEvent[] = [];
    const publisher: ImplementerPublisher = {
      publishRunning: () => {},
      publishCallEvent: ({ event }) => events.push(event),
      publishDone: () => {},
      publishFailed: () => {},
      publishWarning: () => {},
    };

    const implementer = await createImplementer(config, {
      ...implementerAuthority(config),
      publisher,
    });
    await implementer.implement({
      task,
      projectDir: '/tmp',
      config,
      context,
      onOutput: () => {},
      phase: 'implementing',
    });

    expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
  });
});
