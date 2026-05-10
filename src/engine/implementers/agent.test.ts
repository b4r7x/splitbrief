import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import { createAgentImplementer } from './agent.js';
import { makeConfig as makeBaseConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return makeBaseConfig({
    implementer: { model: 'test', contextLength: 8192, temperature: 0.3, kind: 'agent', command: 'echo', ...extra },
  });
}

const context = { ...defaultContext, runtime: 'node' };

let testDir: string;

function setupGitRepo(): string {
  const dir = createTempDir('diptych-agent-test');
  createTestGitRepo(dir);
  return dir;
}

describe('agent implementer', () => {
  beforeEach(() => {
    testDir = setupGitRepo();
  });

  afterEach(() => {
    if (testDir) cleanupTempDir(testDir);
  });

  it('succeeds when agent writes a file', async () => {
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "hello" > ${join(testDir, 'output.txt')}`],
    });

    const output: string[] = [];
    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: (text) => output.push(text),
    });

    expect(result.success).toBe(true);
  });

  it('fails when agent writes no files', async () => {
    const config = makeConfig({
      command: 'echo',
      args: ['no files written'],
    });

    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('without changing any files');
  });

  it('throws on timeout', async () => {
    const config = makeConfig({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeout: 50,
    });

    const implementer = createAgentImplementer(config);
    await expect(
      implementer.implement({
        task: makeTask(),
        projectDir: testDir,
        config,
        context: { ...context, dir: testDir },
        onOutput: () => {},
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('throws when command is not found', async () => {
    const config = makeConfig({
      command: 'nonexistent-command-xyz-12345',
    });

    const implementer = createAgentImplementer(config);
    await expect(
      implementer.implement({
        task: makeTask(),
        projectDir: testDir,
        config,
        context: { ...context, dir: testDir },
        onOutput: () => {},
      }),
    ).rejects.toThrow('command not found');
  }, 30_000);

  it('replaces {prompt} placeholder in args', async () => {
    const outFile = join(testDir, 'prompt-out.txt');
    const config = makeConfig({
      command: 'node',
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        outFile,
        '{prompt}',
      ],
    });

    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask({ description: 'test prompt content' }),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    const prompt = readFileSync(outFile, 'utf-8');
    expect(prompt).toContain('test prompt content');
    expect(prompt).toContain('Output the complete file contents');
    expect(prompt).not.toContain('{prompt}');
  });

  it('retryTaskViaAgent works with error context', async () => {
    const outFile = join(testDir, 'retry-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "retry" > ${outFile}`],
    });

    const implementer = createAgentImplementer(config);
    const result = await implementer.retry({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      error: 'tsc error: missing semicolon',
      attempt: 1,
      kind: 'local',
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
  });

  it('captures stdout as output', async () => {
    const outFile = join(testDir, 'capture-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "agent progress output" && echo "done" > ${outFile}`],
    });

    const chunks: string[] = [];
    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: (text) => chunks.push(text),
    });

    expect(result.success).toBe(true);
    expect(chunks.join('')).toContain('agent progress output');
  });
});
