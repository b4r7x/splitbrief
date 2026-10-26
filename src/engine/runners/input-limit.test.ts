import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { CLI_PROMPT_SENTINEL } from './cli-tools/candidate-contract.js';
import type { CliInvocation, CliProcessAdapter } from './cli-tools/contract.js';
import { preparePrompt } from './cli-tools/prompt-transport.js';
import { CLI_IMPLEMENTER_ADAPTERS, CLI_PLANNER_ADAPTERS } from './cli-tools/registry.js';
import { invokeCommandBasedRunner } from './command-based.js';
import { argvPromptMaxBytes, inputTooLargeFigures } from './input-limit.js';

const CODEX_PROMPT_LIMIT = { max: 1_048_576, unit: 'characters' } as const;

function getconf(name: string): number {
  return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim());
}

function argvAdapter(): CliProcessAdapter {
  return {
    ...CLI_PLANNER_ADAPTERS.codex,
    promptTransport: { kind: 'argv', placement: 'positional' },
  };
}

function argvInvocation(adapter: CliProcessAdapter): CliInvocation {
  return {
    executable: {
      path: '/usr/bin/true',
      fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
    },
    args: [CLI_PROMPT_SENTINEL],
    promptTransport: adapter.promptTransport,
    environment: {},
    cwd: '/project',
    signal: undefined,
  };
}

describe('the adapter prompt limit', () => {
  it('declares the Codex input limit on its adapters, in characters', () => {
    expect(CLI_PLANNER_ADAPTERS.codex.promptLimit).toEqual(CODEX_PROMPT_LIMIT);
    expect(CLI_IMPLEMENTER_ADAPTERS.codex.promptLimit).toEqual(CODEX_PROMPT_LIMIT);
  });

  it('declares no limit for a tool that takes the prompt on stdin without one', () => {
    for (const adapter of [
      ...Object.values(CLI_PLANNER_ADAPTERS),
      ...Object.values(CLI_IMPLEMENTER_ADAPTERS),
    ]) {
      if (adapter.descriptor.id === 'codex') continue;
      expect(adapter.promptLimit, adapter.descriptor.id).toBeUndefined();
    }
  });

  it('is the one home of the limit: the tool catalog carries none', () => {
    for (const entry of Object.values(CLI_TOOL_CATALOG)) {
      expect(Object.keys(entry), entry.id).not.toContain('maxInputChars');
    }
  });
});

describe('argvPromptMaxBytes', () => {
  it('derives the command-line limit from the host', () => {
    const limit = argvPromptMaxBytes();

    expect(limit).toBeGreaterThan(64 * 1024);
    if (process.platform === 'linux') {
      // execve(2): MAX_ARG_STRLEN is 32 pages for one argument.
      expect(limit).toBeLessThan(32 * getconf('PAGESIZE'));
    } else {
      // The whole argument and environment area is ARG_MAX; the environment takes its share.
      const environmentBytes = Object.entries(process.env).reduce(
        (total, [key, value]) => total + Buffer.byteLength(`${key}=${value ?? ''}`) + 1,
        0,
      );
      expect(limit).toBeLessThanOrEqual(getconf('ARG_MAX') - environmentBytes);
    }
  });

  it('bounds a command-line prompt in preparePrompt', async () => {
    const adapter = argvAdapter();
    const prompt = 'x'.repeat(argvPromptMaxBytes() + 1);

    const refusal = preparePrompt(adapter, argvInvocation(adapter), [CLI_PROMPT_SENTINEL], prompt);

    await expect(refusal).rejects.toMatchObject({ kind: 'argv-prompt-too-large' });
    const message = await refusal.then(
      () => '',
      (cause: Error) => cause.message,
    );
    expect(inputTooLargeFigures(message)).toEqual({
      unit: 'bytes',
      size: argvPromptMaxBytes() + 1,
      limit: argvPromptMaxBytes(),
    });
  });

  it('accepts a command-line prompt at the limit in preparePrompt', async () => {
    const adapter = argvAdapter();
    const prompt = 'x'.repeat(argvPromptMaxBytes());

    const prepared = await preparePrompt(
      adapter,
      argvInvocation(adapter),
      [CLI_PROMPT_SENTINEL],
      prompt,
    );

    expect(prepared.args).toEqual([prompt]);
  });

  it('bounds a {prompt} placeholder in a command-based runner with the same limit', async () => {
    const prompt = 'x'.repeat(argvPromptMaxBytes() + 1);

    const refusal = invokeCommandBasedRunner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ran")', '{prompt}'],
      supportPromptPlaceholder: true,
      prompt,
      projectDir: process.cwd(),
    });

    await expect(refusal).rejects.toMatchObject({ kind: 'argv-prompt-too-large' });
    const message = await refusal.then(
      () => '',
      (cause: Error) => cause.message,
    );
    expect(inputTooLargeFigures(message).limit).toBe(argvPromptMaxBytes());
  });
});
