import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureHooksTrusted } from './hook-trust-prompt.js';
import { isHooksConfigTrusted, markHooksConfigTrusted } from '../core/hooks/trust.js';
import { isCliError } from './errors.js';
import type { HooksConfig } from '../core/schemas/hooks.js';

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

let tmp: string;
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

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
}

beforeEach(() => {
  tmp = createTempDir('hooks-trust-test');
  mkdirSync(join(tmp, '.diptych'), { recursive: true });
  originalIsTTY = process.stdin.isTTY;
  vi.restoreAllMocks();
});

afterEach(() => {
  setStdinIsTTY(originalIsTTY);
  cleanupTempDir(tmp);
});

describe('ensureHooksTrusted', () => {
  it('allows runs with no hooks configured', async () => {
    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks: undefined, allowHooks: false }),
    ).resolves.toBeUndefined();
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
  });

  it('allows already trusted hooks config without prompting again', async () => {
    markHooksConfigTrusted(tmp, hooks);
    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }),
    ).resolves.toBeUndefined();
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(true);
  });

  it('marks trusted and proceeds when --allow-hooks flag is set', async () => {
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: true }),
    ).resolves.toBeUndefined();
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(true);
  });

  it('throws cliError in non-TTY environment without --allow-hooks', async () => {
    setStdinIsTTY(false);

    let caught: unknown;
    try {
      await ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false });
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/--allow-hooks/);
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
  });

  it('throws cliError when user answers N on TTY', async () => {
    setStdinIsTTY(true);

    const rl = { question: vi.fn().mockResolvedValue('N'), close: vi.fn() };
    const { createInterface } = await import('node:readline/promises');
    vi.mocked(createInterface).mockReturnValue(rl as never);

    let caught: unknown;
    try {
      await ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false });
    } catch (err) {
      caught = err;
    }

    expect(isCliError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/untrusted hooks/);
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(false);
  });

  it.each([
    'y',
    'yes',
  ])('marks trusted and proceeds when user answers %s on TTY', async (answer) => {
    setStdinIsTTY(true);

    const rl = { question: vi.fn().mockResolvedValue(answer), close: vi.fn() };
    const { createInterface } = await import('node:readline/promises');
    vi.mocked(createInterface).mockReturnValue(rl as never);

    await expect(
      ensureHooksTrusted({ projectDir: tmp, hooks, allowHooks: false }),
    ).resolves.toBeUndefined();
    expect(isHooksConfigTrusted(tmp, hooks)).toBe(true);
  });
});
