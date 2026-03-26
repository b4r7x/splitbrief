import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { Config, Task, ProjectContext } from '../src/types.js';
import { implementTaskViaAgent, retryTaskViaAgent } from '../src/orchestrator/implementers/agent.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return {
    planner: { tool: 'claude-code' },
    implementer: {
      provider: 'ollama',
      model: 'test',
      apiBase: '',
      contextLength: 8192,
      temperature: 0.3,
      type: 'agent',
      command: 'echo',
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
  dir: '/tmp/test-project',
  runtime: 'node',
  testCommand: 'npm test',
};

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
    const result = await implementTaskViaAgent(
      makeTask(),
      testDir,
      config,
      { ...context, dir: testDir },
      (text) => output.push(text),
    );

    assert.equal(result.success, true);
  });

  it('fails when agent writes no files', async () => {
    const config = makeConfig({
      command: 'echo',
      args: ['no files written'],
    });

    const result = await implementTaskViaAgent(
      makeTask(),
      testDir,
      config,
      { ...context, dir: testDir },
      () => {},
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('without changing any files'));
  });

  it('fails with descriptive error on timeout', async () => {
    const config = makeConfig({
      command: 'sleep',
      args: ['10'],
      timeout: 100, // 100ms timeout
    });

    const result = await implementTaskViaAgent(
      makeTask(),
      testDir,
      config,
      { ...context, dir: testDir },
      () => {},
    );

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timed out'));
  });

  it('throws when command is not found', async () => {
    const config = makeConfig({
      command: 'nonexistent-command-xyz-12345',
    });

    await assert.rejects(
      () => implementTaskViaAgent(
        makeTask(),
        testDir,
        config,
        { ...context, dir: testDir },
        () => {},
      ),
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

    const result = await implementTaskViaAgent(
      makeTask({ description: 'test prompt content' }),
      testDir,
      config,
      { ...context, dir: testDir },
      () => {},
    );

    assert.equal(result.success, true);
  });

  it('retryTaskViaAgent works with error context', async () => {
    const outFile = join(testDir, 'retry-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "retry" > ${outFile}`],
    });

    const result = await retryTaskViaAgent(
      makeTask(),
      testDir,
      config,
      { ...context, dir: testDir },
      'tsc error: missing semicolon',
      1,
      () => {},
    );

    assert.equal(result.success, true);
  });

  it('captures stdout as output', async () => {
    const outFile = join(testDir, 'capture-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `echo "agent progress output" && echo "done" > ${outFile}`],
    });

    const chunks: string[] = [];
    const result = await implementTaskViaAgent(
      makeTask(),
      testDir,
      config,
      { ...context, dir: testDir },
      (text) => chunks.push(text),
    );

    assert.equal(result.success, true);
    assert.ok(chunks.join('').includes('agent progress output'));
  });
});
