import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_EXEC_WAIT_MS,
  installClipboardExecFixture,
  readClipboardExecCalls,
  restoreClipboardExecFixture,
  setClipboardExitCodes,
} from '#testing/helpers/clipboard-exec-fixture.js';

import { copyToClipboard } from './clipboard.js';
import { _resetLinuxCopyCache } from './native.js';

const ESC = String.fromCharCode(0x1b);
const originalPlatform = process.platform;
const savedEnv = { ...process.env };

let originalWrite: typeof process.stdout.write;
const terminalWrites: string[] = [];
let stdoutBroken = false;

function captureStdout(): void {
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (stdoutBroken) {
      const err: NodeJS.ErrnoException = new Error('write EPIPE');
      err.code = 'EPIPE';
      throw err;
    }
    terminalWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function clearEnv(): void {
  for (const key of ['SSH_CONNECTION', 'TMUX', 'STY', 'TERM', 'TERM_PROGRAM', 'LC_TERMINAL']) {
    delete process.env[key];
  }
}

async function expectClipboardExec(
  assert: (calls: ReturnType<typeof readClipboardExecCalls>) => void,
): Promise<void> {
  await vi.waitFor(() => {
    assert(readClipboardExecCalls());
  }, CLIPBOARD_EXEC_WAIT_MS);
}

beforeEach(() => {
  installClipboardExecFixture();
  terminalWrites.length = 0;
  stdoutBroken = false;
  _resetLinuxCopyCache();
  clearEnv();
  originalWrite = process.stdout.write.bind(process);
  captureStdout();
});

afterEach(() => {
  restoreClipboardExecFixture();
  process.stdout.write = originalWrite;
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  process.env = { ...savedEnv };
});

describe('copyToClipboard', () => {
  it('reports native on darwin and writes no terminal sequence', async () => {
    setPlatform('darwin');
    const result = await copyToClipboard('hi');
    expect(result).toBe('native');
    await expectClipboardExec((calls) => {
      expect(calls[0]).toEqual({ file: 'pbcopy', args: [], stdin: 'hi' });
    });
    expect(terminalWrites).toEqual([]);
  });

  it('reports native on local linux and writes no terminal sequence', async () => {
    setPlatform('linux');
    const result = await copyToClipboard('hi');
    expect(result).toBe('native');
    await expectClipboardExec((calls) => {
      expect(calls[0]?.file).toBe('wl-copy');
    });
    expect(terminalWrites).toEqual([]);
  });

  it('reports tmux-buffer when native fails but the tmux buffer loads, writing no escape', async () => {
    setPlatform('darwin');
    process.env['TMUX'] = '/tmp/tmux/default,1,0';
    setClipboardExitCodes({ pbcopy: 1 });
    const result = await copyToClipboard('hi');
    expect(result).toBe('tmux-buffer');
    await expectClipboardExec((calls) => {
      expect(calls.map((c) => c.file)).toEqual(['pbcopy', 'tmux']);
    });
    expect(terminalWrites).toEqual([]);
  });

  it('reports tmux-buffer over SSH without invoking native, writing no escape', async () => {
    setPlatform('linux');
    process.env['SSH_CONNECTION'] = '10.0.0.1 22 10.0.0.2 22';
    process.env['TMUX'] = '/tmp/tmux/default,1,0';
    const huge = 'a'.repeat(80_000);
    const result = await copyToClipboard(huge);
    expect(result).toBe('tmux-buffer');
    await expectClipboardExec((calls) => {
      expect(calls.map((c) => c.file)).toEqual(['tmux']);
    });
    expect(terminalWrites).toEqual([]);
  });

  it('emits OSC 52 only when native fails and no tmux buffer is available', async () => {
    setPlatform('darwin');
    setClipboardExitCodes({ pbcopy: 1 });
    const result = await copyToClipboard('hi');
    expect(result).toBe('osc52');
    expect(terminalWrites).toHaveLength(1);
    expect(terminalWrites[0]?.startsWith(`${ESC}]52;c;`)).toBe(true);
  });

  it('skips native over SSH and falls back to the OSC 52 escape', async () => {
    setPlatform('darwin');
    process.env['SSH_CONNECTION'] = '10.0.0.1 22 10.0.0.2 22';
    const result = await copyToClipboard('hi');
    await expectClipboardExec((calls) => {
      expect(calls.some((c) => c.file === 'pbcopy')).toBe(false);
    });
    expect(result).toBe('osc52');
    expect(terminalWrites).toHaveLength(1);
  });

  it('DCS-wraps the OSC 52 escape when inside tmux but the buffer load fails', async () => {
    setPlatform('linux');
    process.env['SSH_CONNECTION'] = '10.0.0.1 22 10.0.0.2 22';
    process.env['TMUX'] = '/tmp/tmux/default,1,0';
    setClipboardExitCodes({ tmux: 1 });
    const result = await copyToClipboard('hi');
    expect(result).toBe('osc52');
    expect(terminalWrites).toHaveLength(1);
    expect(terminalWrites[0]?.startsWith(`${ESC}Ptmux;`)).toBe(true);
  });

  it('downgrades to unavailable when the OSC 52 terminal write breaks', async () => {
    setPlatform('darwin');
    setClipboardExitCodes({ pbcopy: 1 });
    stdoutBroken = true;
    const result = await copyToClipboard('hi');
    expect(result).toBe('unavailable');
  });

  it('signals non-delivery over SSH without tmux when the payload exceeds the cap', async () => {
    setPlatform('linux');
    process.env['SSH_CONNECTION'] = '10.0.0.1 22 10.0.0.2 22';
    const huge = 'a'.repeat(80_000);
    const result = await copyToClipboard(huge);
    await expectClipboardExec((calls) => {
      expect(calls).toHaveLength(0);
    });
    expect(terminalWrites).toEqual([]);
    expect(result).toBe('unavailable');
  });

  it('signals non-delivery when local native fails and the payload exceeds the cap', async () => {
    setPlatform('darwin');
    setClipboardExitCodes({ pbcopy: 1 });
    const huge = 'a'.repeat(80_000);
    const result = await copyToClipboard(huge);
    expect(terminalWrites).toEqual([]);
    expect(result).toBe('unavailable');
  });
});
