import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { ImplementerPublisher } from './types.js';
import { createAgentImplementer } from './agent.js';
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

  it('aborts an in-flight spawned process when the signal fires', async () => {
    const config = makeConfig({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });

    const controller = new AbortController();
    const implementer = createAgentImplementer(config);
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
    const task = makeTask({ description: 'test prompt content' });
    const result = await implementer.implement({
      task,
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    const prompt = readFileSync(outFile, 'utf-8');
    expect(prompt).toContain('test prompt content');
    expect(prompt).toContain(
      `Edit ${task.file} directly in the isolation directory. Run the validation commands listed in this Task Brief before finishing. End with a completion report stating which files you wrote and whether the brief's steps were completed.`,
    );
    expect(prompt).not.toContain('{prompt}');
  });

  it('refuses shell-evaluated {prompt} placeholders without repo runner trust', async () => {
    const config = makeConfig({
      command: 'bash',
      args: ['-c', 'printf "%s" "{prompt}"'],
    });

    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask({ description: 'unsafe prompt content' }),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Runner args must not pass {prompt} through bash -c');
  });

  it('allows shell-evaluated {prompt} placeholders with explicit repo runner trust', async () => {
    const outFile = join(testDir, 'trusted-prompt-out.txt');
    const config = makeConfig({
      command: 'bash',
      args: ['-c', `cat > ${outFile} <<'SPLITBRIEF_PROMPT_EOF'\n{prompt}\nSPLITBRIEF_PROMPT_EOF`],
    });

    const implementer = createAgentImplementer(config, { allowRepoRunners: true });
    const result = await implementer.implement({
      task: makeTask({ description: 'trusted prompt content' }),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onOutput: () => {},
    });

    expect(result.success).toBe(true);
    expect(readFileSync(outFile, 'utf-8')).toContain('trusted prompt content');
  });

  it('threads a sandbox env through to the spawned subprocess', async () => {
    const envOutFile = join(testDir, 'env-out.txt');
    const writtenFile = join(testDir, 'sandbox-written.txt');
    const config = makeConfig({
      command: 'node',
      args: [
        '-e',
        'const fs=require("node:fs");fs.writeFileSync(process.argv[1],process.env.SPLITBRIEF_SANDBOX_MARKER??"");fs.writeFileSync(process.argv[2],"done")',
        envOutFile,
        writtenFile,
      ],
    });

    const implementer = createAgentImplementer(config);
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

    const implementer = createAgentImplementer(config, { publisher });
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
