import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { ImplementerPublisher } from './types.js';
import { createCommandImplementer } from './command-invoke.js';
import { makeConfig as makeBaseConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

type AgentConfig = Extract<Config['implementer'], { kind: 'agent' }>;

function makeConfig(extra?: Partial<AgentConfig>): Config {
  return makeBaseConfig({
    implementer: {
      model: 'test',
      contextLength: 8192,
      temperature: 0.3,
      kind: 'agent',
      command: 'echo',
      ...extra,
    },
  });
}

const context = { ...defaultContext };

let testDir: string;

function setupGitRepo(): string {
  const dir = createTempDir('splitbrief-agent-test');
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

  it('agent kind reports changed files without an exact-effect gate', async () => {
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `cat >/dev/null; echo "hello" > ${join(testDir, 'undeclared.txt')}`],
    });

    const implementer = createCommandImplementer(config, 'agent');
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.outcome).toBeUndefined();
  });

  it('fails when agent writes no files', async () => {
    const config = makeConfig({
      command: '/bin/sh',
      args: ['-c', 'cat >/dev/null; echo no files written'],
    });

    const implementer = createCommandImplementer(config, 'agent');
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

  it('returns a timed-out call on timeout', async () => {
    const config = makeConfig({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeout: 50,
    });

    const implementer = createCommandImplementer(config, 'agent');
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result).toMatchObject({ success: false, outcome: 'timeout' });
    expect(result.error).toMatch(/timed out/);
  });

  it('aborts an in-flight spawned process when the signal fires', async () => {
    const config = makeConfig({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });

    const controller = new AbortController();
    const implementer = createCommandImplementer(config, 'agent');
    const pending = implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    const result = await pending;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('Aborted');
  }, 10_000);

  it('throws when command is not found', async () => {
    const config = makeConfig({
      command: 'nonexistent-command-xyz-12345',
    });

    const implementer = createCommandImplementer(config, 'agent');
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

  it('threads a sandbox env through to the spawned subprocess', async () => {
    const envOutFile = join(testDir, 'env-out.txt');
    const writtenFile = join(testDir, 'sandbox-written.txt');
    const config = makeConfig({
      command: 'node',
      args: [
        '-e',
        'require("node:fs").readFileSync(0);const fs=require("node:fs");fs.writeFileSync(process.argv[1],process.env.SPLITBRIEF_SANDBOX_MARKER??"");fs.writeFileSync(process.argv[2],"done")',
        envOutFile,
        writtenFile,
      ],
    });

    const implementer = createCommandImplementer(config, 'agent');
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
      sandboxEnv: { ...process.env, SPLITBRIEF_SANDBOX_MARKER: 'sandbox-value' },
    });

    expect(result.success).toBe(true);
    expect(readFileSync(envOutFile, 'utf-8')).toBe('sandbox-value');
  });

  it('captures stdout as output', async () => {
    const outFile = join(testDir, 'capture-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `cat >/dev/null; echo "agent progress output" && echo "done" > ${outFile}`],
    });

    const chunks: string[] = [];
    const implementer = createCommandImplementer(config, 'agent');
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

  it('threads a configured idleWarnMs override into the spawn', async () => {
    const config = makeConfig({
      command: 'bash',
      args: ['-c', 'sleep 0.15'],
      idleWarnMs: 30,
    });
    const events: RunnerCallEvent[] = [];
    const publisher: ImplementerPublisher = {
      publishRunning: () => {},
      publishCallEvent: ({ event }) => events.push(event),
      publishDone: () => {},
      publishFailed: () => {},
      publishWarning: () => {},
    };

    const implementer = createCommandImplementer(config, 'agent', { publisher });
    await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
      phase: 'implementing',
    });

    expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
  });
});
