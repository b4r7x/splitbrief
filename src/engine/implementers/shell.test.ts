import { describe, it, expect } from 'vitest';
import type { Config, TuiEvent } from '../../types.js';
import { makeConfig as makeBaseConfig, makeTask, defaultContext } from '#testing/helpers/fixtures.js';
import { createImplementer } from './factory.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return makeBaseConfig({
    implementer: { model: 'test', contextLength: 8192, temperature: 0.3, kind: 'shell', command: 'my-ai-tool', outputFormat: 'text', ...extra },
  });
}

const context = { ...defaultContext, dir: '/tmp', runtime: 'node' };

async function implementTask(task: ReturnType<typeof makeTask>, opts: { projectDir: string; config: Config; context: typeof defaultContext; onOutput: (text: string) => void; onEvent?: (event: TuiEvent) => void }) {
  const implementer = await createImplementer(opts.config);
  return implementer.implement({ ...opts, task });
}

async function retryTask(task: ReturnType<typeof makeTask>, opts: { projectDir: string; config: Config; context: typeof defaultContext; error: string; attempt: number; onOutput: (text: string) => void; onEvent?: (event: TuiEvent) => void }) {
  const implementer = await createImplementer(opts.config);
  return implementer.retry({ ...opts, task, kind: 'local' });
}

describe('shell implementer', () => {
  it('implementTask dispatches to shell when kind is shell (empty stdout → extraction fails)', async () => {
    const config = makeConfig({ command: '/bin/echo' });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onOutput: () => {} });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/extract|code/i);
    }
  });

  it('retryTask dispatches to shell when kind is shell (empty stdout → extraction fails)', async () => {
    const config = makeConfig({ command: '/bin/echo' });
    const task = makeTask();

    const result = await retryTask(task, { projectDir: '/tmp', config, context, error: 'previous error', attempt: 1, onOutput: () => {} });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/extract|code/i);
    }
  });

  it('returns failure on non-zero exit code with no output', async () => {
    const config = makeConfig({ command: '/usr/bin/false' });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onOutput: () => {} });

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

  it('successful code extraction from stdout with fenced code', async () => {
    const codeOutput = '```typescript\nexport function hello() { return "hi"; }\n```';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', codeOutput] });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onOutput: () => {} });

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('reports progress via onOutput callback', async () => {
    const code = 'export const x = 1;\n';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', code] });
    const task = makeTask();
    const progressCalls: string[] = [];

    await implementTask(task, {
      projectDir: '/tmp', config, context,
      onOutput: (text) => { progressCalls.push(text); },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('retry passes error context to the prompt', async () => {
    const config = makeConfig({ command: '/bin/cat' });
    const task = makeTask();
    const progressCalls: string[] = [];

    await retryTask(task, {
      projectDir: '/tmp', config, context,
      error: 'TypeError: x is not a function', attempt: 1,
      onOutput: (text) => { progressCalls.push(text); },
    });

    const fullOutput = progressCalls.join('');
    expect(fullOutput).toContain('TypeError: x is not a function');
  });

});
