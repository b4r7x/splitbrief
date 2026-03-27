import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Config, Task, ProjectContext } from '../src/types.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return {
    planner: { tool: 'claude-code' },
    implementer: {
      provider: 'ollama',
      model: 'test',
      apiBase: '',
      contextLength: 8192,
      temperature: 0.3,
      type: 'shell',
      command: 'my-ai-tool',
      outputFormat: 'text',
      ...extra,
    },
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      maxRetries: 3,
      commitPerTask: true,
    },
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'T001',
    title: 'Create hello module',
    action: 'create',
    file: 'src/hello.ts',
    dependsOn: [],
    description: 'Create a hello world module',
    tests: [],
    constraints: [],
    typeDefs: '',
    implSteps: [],
    status: 'pending',
    ...overrides,
  };
}

const context: ProjectContext = {
  name: 'test-project',
  dir: '/tmp',
  runtime: 'node',
  testCommand: 'npm test',
};

describe('shell implementer', () => {
  it('implementTask dispatches to shell when type is shell', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig({ command: '/bin/echo' });
    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});

    assert.equal(typeof result.success, 'boolean');
    assert.equal(typeof result.output, 'string');
  });

  it('retryTask dispatches to shell when type is shell', async () => {
    const { retryTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig({ command: '/bin/echo' });
    const task = makeTask();

    const result = await retryTask(task, '/tmp', config, context, 'previous error', 1, () => {});

    assert.equal(typeof result.success, 'boolean');
    assert.equal(typeof result.output, 'string');
  });

  it('returns failure on non-zero exit code with no output', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig({ command: '/usr/bin/false' });
    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});

    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('throws on command not found (ENOENT)', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig({ command: 'nonexistent-command-that-does-not-exist-xyz' });
    const task = makeTask();

    await assert.rejects(
      () => implementTask(task, '/tmp', config, context, () => {}),
      (err: Error) => {
        assert.ok(err.message.includes('command not found') || err.message.includes('ENOENT'));
        return true;
      },
    );
  });

  it('successful code extraction from stdout with fenced code', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const codeOutput = '```typescript\nexport function hello() { return "hi"; }\n```';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', codeOutput] });
    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});

    assert.equal(result.success, true);
    assert.ok(result.output.includes('hello'));
  });

  it('handles text output format', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const code = 'export const x = 1;';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', code], outputFormat: 'text' });
    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});

    assert.equal(typeof result.success, 'boolean');
  });

  it('handles jsonl output format', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const jsonlLine = JSON.stringify({ text: 'export const x = 1;' });
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s\n', jsonlLine], outputFormat: 'jsonl' });
    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});

    assert.equal(typeof result.success, 'boolean');
  });

  it('reports progress via onProgress callback', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const code = 'export const x = 1;\n';
    const config = makeConfig({ command: '/usr/bin/printf', args: ['%s', code] });
    const task = makeTask();
    const progressCalls: string[] = [];

    await implementTask(task, '/tmp', config, context, (text) => {
      progressCalls.push(text);
    });

    assert.ok(progressCalls.length > 0);
  });

  it('retry passes error context to the prompt', async () => {
    const { retryTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig({ command: '/bin/cat' });
    const task = makeTask();
    const progressCalls: string[] = [];

    const result = await retryTask(task, '/tmp', config, context, 'TypeError: x is not a function', 1, (text) => {
      progressCalls.push(text);
    });

    const fullOutput = progressCalls.join('');
    assert.ok(fullOutput.includes('TypeError: x is not a function'));
  });

  it('does not dispatch to shell when type is api', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig({ type: 'api' });
    delete (config.implementer as any).command;

    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('does not dispatch to shell when type is undefined', async () => {
    const { implementTask } = await import('../src/orchestrator/implementer.js');
    const config = makeConfig();
    delete (config.implementer as any).type;
    delete (config.implementer as any).command;

    const task = makeTask();

    const result = await implementTask(task, '/tmp', config, context, () => {});
    assert.equal(result.success, false);
    assert.ok(result.error);
  });
});
