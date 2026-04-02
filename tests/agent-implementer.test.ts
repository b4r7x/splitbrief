import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { Config } from '../src/types.js';
import { implementTaskViaAgent, retryTaskViaAgent } from '../src/engine/implementers/agent.js';
import { makeConfig as makeBaseConfig, makeTask, defaultContext } from './helpers/fixtures.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return makeBaseConfig({
    implementer: { model: 'test', contextLength: 8192, temperature: 0.3, type: 'agent', command: 'echo', ...extra },
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
    // Use bash -c to write a file, simulating an agent
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "hello" > ${join(testDir, 'output.txt')}`],
    });

    const output: string[] = [];
    const result = await implementTaskViaAgent({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: (text) => output.push(text),
    });

    assert.equal(result.success, true);
  });

  it('fails when agent writes no files', async () => {
    const config = makeConfig({
      command: 'echo',
      args: ['no files written'],
    });

    const result = await implementTaskViaAgent({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: () => {},
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('without changing any files'));
  });

  it('fails with descriptive error on timeout', async () => {
    const config = makeConfig({
      command: 'sleep',
      args: ['10'],
      timeout: 100, // 100ms timeout
    });

    const result = await implementTaskViaAgent({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: () => {},
    });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timed out'));
  });

  it('throws when command is not found', async () => {
    const config = makeConfig({
      command: 'nonexistent-command-xyz-12345',
    });

    await assert.rejects(
      () => implementTaskViaAgent({
        task: makeTask(),
        projectDir: testDir,
        config,
        context: { ...context, dir: testDir },
        onProgress: () => {},
      }),
      (err: Error) => {
        assert.ok(err.message.includes('command not found'));
        return true;
      },
    );
  });

  it('replaces {prompt} placeholder in args', async () => {
    // Use a command that writes the prompt arg to a file
    const outFile = join(testDir, 'prompt-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "{prompt}" | head -c 100 > ${outFile}`],
    });

    const result = await implementTaskViaAgent({
      task: makeTask({ description: 'test prompt content' }),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: () => {},
    });

    assert.equal(result.success, true);
  });

  it('retryTaskViaAgent works with error context', async () => {
    const outFile = join(testDir, 'retry-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "retry" > ${outFile}`],
    });

    const result = await retryTaskViaAgent({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      error: 'tsc error: missing semicolon',
      attempt: 1,
      onProgress: () => {},
    });

    assert.equal(result.success, true);
  });

  it('captures stdout as output', async () => {
    const outFile = join(testDir, 'capture-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "agent progress output" && echo "done" > ${outFile}`],
    });

    const chunks: string[] = [];
    const result = await implementTaskViaAgent({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: (text) => chunks.push(text),
    });

    assert.equal(result.success, true);
    assert.ok(chunks.join('').includes('agent progress output'));
  });
});
