import { describe, it, expect } from 'vitest';
import type { Config } from '../../types.js';
import { makeConfig as makeBaseConfig, makeTask, defaultContext } from '#testing/helpers/fixtures.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return makeBaseConfig({
    implementer: { model: 'test', contextLength: 8192, temperature: 0.3, type: 'shell', command: 'my-ai-tool', outputFormat: 'text', ...extra },
  });
}

const context = { ...defaultContext, dir: '/tmp', runtime: 'node' };

describe('shell implementer', () => {
  it('implementTask dispatches to shell when type is shell', async () => {
    const { implementTask } = await import('../implementer.js');
    const config = makeConfig({ command: '/bin/echo' });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });

    expect(typeof result.success).toBe('boolean');
    expect(typeof result.output).toBe('string');
  });

  it('retryTask dispatches to shell when type is shell', async () => {
    const { retryTask } = await import('../implementer.js');
    const config = makeConfig({ command: '/bin/echo' });
    const task = makeTask();

    const result = await retryTask(task, { projectDir: '/tmp', config, context, error: 'previous error', attempt: 1, onProgress: () => {} });

    expect(typeof result.success).toBe('boolean');
    expect(typeof result.output).toBe('string');
  });

  it('returns failure on non-zero exit code with no output', async () => {
    const { implementTask } = await import('../implementer.js');
    const config = makeConfig({ command: '/usr/bin/false' });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('throws on command not found (ENOENT)', async () => {
    const { implementTask } = await import('../implementer.js');
    const config = makeConfig({ command: 'nonexistent-command-that-does-not-exist-xyz' });
    const task = makeTask();

    await expect(
      implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} }),
    ).rejects.toThrow(/command not found|ENOENT/);
  });

  it('successful code extraction from stdout with fenced code', async () => {
    const { implementTask } = await import('../implementer.js');
    const codeOutput = '```typescript\nexport function hello() { return "hi"; }\n```';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', codeOutput] });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });

    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('handles text output format', async () => {
    const { implementTask } = await import('../implementer.js');
    const code = 'export const x = 1;';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', code], outputFormat: 'text' });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });

    expect(typeof result.success).toBe('boolean');
  });

  it('handles jsonl output format', async () => {
    const { implementTask } = await import('../implementer.js');
    const jsonlLine = JSON.stringify({ text: 'export const x = 1;' });
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s\n', jsonlLine], outputFormat: 'jsonl' });
    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });

    expect(typeof result.success).toBe('boolean');
  });

  it('reports progress via onProgress callback', async () => {
    const { implementTask } = await import('../implementer.js');
    const code = 'export const x = 1;\n';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', code] });
    const task = makeTask();
    const progressCalls: string[] = [];

    await implementTask(task, {
      projectDir: '/tmp', config, context,
      onProgress: (text) => { progressCalls.push(text); },
    });

    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it('retry passes error context to the prompt', async () => {
    const { retryTask } = await import('../implementer.js');
    const config = makeConfig({ command: '/bin/cat' });
    const task = makeTask();
    const progressCalls: string[] = [];

    const result = await retryTask(task, {
      projectDir: '/tmp', config, context,
      error: 'TypeError: x is not a function', attempt: 1,
      onProgress: (text) => { progressCalls.push(text); },
    });

    const fullOutput = progressCalls.join('');
    expect(fullOutput).toContain('TypeError: x is not a function');
  });

  it('does not dispatch to shell when type is api', async () => {
    const { implementTask } = await import('../implementer.js');
    const config = makeConfig({ type: 'api' });
    delete (config.implementer as any).command;

    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does not dispatch to shell when type is undefined', async () => {
    const { implementTask } = await import('../implementer.js');
    const config = makeConfig();
    delete (config.implementer as any).type;
    delete (config.implementer as any).command;

    const task = makeTask();

    const result = await implementTask(task, { projectDir: '/tmp', config, context, onProgress: () => {} });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
