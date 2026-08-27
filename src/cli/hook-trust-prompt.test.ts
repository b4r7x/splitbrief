import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import {
  ensureHooksTrusted,
  formatHookTrustDisclosure,
  promptHookTrust,
} from './hook-trust-prompt.js';
import { isHooksConfigTrusted, markHooksConfigTrusted } from '../core/hooks/trust.js';
import { isCliError } from './errors.js';
import type { HooksConfig } from '../core/schemas/hooks.js';

let tmp: string;
let trustHome: ReturnType<typeof useTrustHome>;
let originalIsTTY: boolean | undefined;

const hooks: HooksConfig = {
  pre_task: [
    {
      kind: 'command',
      command: 'prettier',
      args: ['--check'],
      timeout_ms: 5000,
      on_failure: 'warn',
    },
  ],
};

const namedHooks: HooksConfig = {
  pre_task: [
    {
      kind: 'command',
      name: 'format check',
      command: '/usr/bin/touch',
      args: ['PWNED'],
      timeout_ms: 5000,
      on_failure: 'warn',
    },
  ],
};

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
}

function answeringPrompt(answer: string): {
  fn: (question: string) => Promise<string>;
  questions: string[];
} {
  const questions: string[] = [];
  return {
    fn: (question: string) => {
      questions.push(question);
      return Promise.resolve(answer);
    },
    questions,
  };
}

beforeEach(() => {
  trustHome = useTrustHome('hooks-trust-home');
  tmp = createTempDir('hooks-trust-test');
  mkdirSync(join(tmp, '.splitbrief'), { recursive: true });
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  setStdinIsTTY(originalIsTTY);
  cleanupTempDir(tmp);
  trustHome.restore();
});

describe('ensureHooksTrusted', () => {
  it('allows runs with no hooks configured', async () => {
    const prompt = answeringPrompt('y');
    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks: undefined, allowHooks: false }, prompt.fn),
    ).resolves.toBeUndefined();
    expect(prompt.questions).toEqual([]);
  });

  it('allows already trusted hooks config without prompting again', async () => {
    markHooksConfigTrusted(tmp, hooks);
    const prompt = answeringPrompt('y');
    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }, prompt.fn),
    ).resolves.toBeUndefined();
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(true);
    expect(prompt.questions).toEqual([]);
  });

  it('marks trusted and proceeds when --allow-hooks flag is set', async () => {
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
    const prompt = answeringPrompt('y');
    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: true }, prompt.fn),
    ).resolves.toBeUndefined();
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(true);
    expect(prompt.questions).toEqual([]);
  });

  it('throws cliError in non-TTY environment without --allow-hooks', async () => {
    setStdinIsTTY(false);
    const prompt = answeringPrompt('y');

    let caught: unknown;
    try {
      await ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }, prompt.fn);
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/--allow-hooks/);
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
    expect(prompt.questions).toEqual([]);
  });

  it('throws cliError when user answers N on TTY', async () => {
    setStdinIsTTY(true);
    const prompt = answeringPrompt('N');

    let caught: unknown;
    try {
      await ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }, prompt.fn);
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/untrusted hooks/);
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
    expect(prompt.questions).toHaveLength(1);
  });

  it.each(['y', 'yes'])(
    'marks trusted and proceeds when user answers %s on TTY',
    async (answer) => {
      setStdinIsTTY(true);
      const prompt = answeringPrompt(answer);

      await expect(
        ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }, prompt.fn),
      ).resolves.toBeUndefined();
      expect(isHooksConfigTrusted(tmp, hooks)).toBe(true);
      expect(prompt.questions).toHaveLength(1);
    },
  );

  it('throws cliError when the prompt returns no answer (EOF / Ctrl+D)', async () => {
    setStdinIsTTY(true);
    const prompt = answeringPrompt('');

    let caught: unknown;
    try {
      await ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }, prompt.fn);
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/untrusted hooks/);
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
  });
});

describe('the hook trust prompt authorizes a command, not a label', () => {
  it('puts the executable, its resolved path, and its argv in the question itself', async () => {
    setStdinIsTTY(true);
    const prompt = answeringPrompt('y');

    await ensureHooksTrusted({ projectDir: tmp, hooks: namedHooks, allowHooks: false }, prompt.fn);

    const question = prompt.questions[0] ?? '';
    expect(question).toContain('Executable: "/usr/bin/touch"');
    expect(question).toContain('Resolved: "/usr/bin/touch"');
    expect(question).toContain('Arguments: "PWNED"');
    expect(question).toContain('Inherits the full SPLITBRIEF process environment');
    expect(question).toContain('Trust these hooks for this project? [y/N]');
    expect(question).not.toContain('format check');
  });

  it('resolves a bare command against the PATH the hook will be spawned with', () => {
    const disclosure = formatHookTrustDisclosure(tmp, hooks);
    expect(disclosure).toContain('Executable: "prettier"');
    expect(disclosure).toMatch(/Resolved: "(\/.*prettier|\(not found on PATH\))"/);
  });

  it('names the module file a module hook loads', () => {
    const moduleHooks: HooksConfig = {
      post_task: [{ kind: 'module', path: 'hooks/pwn.mjs', timeout_ms: 5000, on_failure: 'warn' }],
    };
    const disclosure = formatHookTrustDisclosure(tmp, moduleHooks);
    expect(disclosure).toContain('Module: "hooks/pwn.mjs"');
    expect(disclosure).toContain(`Resolved: "${join(tmp, 'hooks', 'pwn.mjs')}"`);
  });

  it('cannot be redressed by control characters in the declared command', () => {
    const spoofed: HooksConfig = {
      pre_task: [
        {
          kind: 'command',
          command: 'safe\u202e/hcnual',
          args: ['--x\u0007'],
          timeout_ms: 5000,
          on_failure: 'warn',
        },
      ],
    };
    const disclosure = formatHookTrustDisclosure(tmp, spoofed);

    expect(disclosure).toContain('Executable: "safe\\u202e/hcnual"');
    expect(disclosure).toContain('Arguments: "--x\\u0007"');
    expect(disclosure).not.toContain('\u202e');
  });
});

describe('promptHookTrust', () => {
  it('resolves with the typed line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = promptHookTrust('Trust? [y/N] ', { input, output });
    input.write('y\n');
    await expect(answer).resolves.toBe('y');
  });

  it('resolves with an empty string when the input closes (EOF / Ctrl+D)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = promptHookTrust('Trust? [y/N] ', { input, output });
    input.end();
    await expect(answer).resolves.toBe('');
  });
});
