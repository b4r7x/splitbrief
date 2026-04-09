import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { Config } from '../../types.js';
import { createAgentImplementer } from './agent.js';
import { makeConfig as makeBaseConfig, makeTask, defaultContext } from '#testing/helpers/fixtures.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return makeBaseConfig({
    implementer: { model: 'test', contextLength: 8192, temperature: 0.3, kind: 'agent', command: 'echo', ...extra },
  });
}

const context = { ...defaultContext, runtime: 'node' };

let testDir: string;

function setupGitRepo(): string {
  const dir = join(tmpdir(), `tiny-spec-agent-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'init.txt'), 'init');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('agent implementer', () => {
  beforeEach(() => {
    testDir = setupGitRepo();
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
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
      onProgress: (text) => output.push(text),
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
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('without changing any files');
  });

  it('fails with descriptive error on timeout', async () => {
    const config = makeConfig({
      command: 'sleep',
      args: ['10'],
      timeout: 100,
    });

    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
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
        onProgress: () => {},
      }),
    ).rejects.toThrow('command not found');
  }, 30_000);

  it('replaces {prompt} placeholder in args', async () => {
    const outFile = join(testDir, 'prompt-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "{prompt}" | head -c 100 > ${outFile}`],
    });

    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask({ description: 'test prompt content' }),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
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
      onProgress: () => {},
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
      onProgress: (text) => chunks.push(text),
    });

    expect(result.success).toBe(true);
    expect(chunks.join('')).toContain('agent progress output');
  });
});
