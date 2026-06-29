import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installClipboardExecFixture,
  readClipboardExecCalls,
  restoreClipboardExecFixture,
  setClipboardExitCodes,
} from '#testing/helpers/clipboard-exec-fixture.js';

import { copyNative, tmuxLoadBuffer, _resetLinuxCopyCache } from './native.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  installClipboardExecFixture();
  _resetLinuxCopyCache();
});

afterEach(() => {
  restoreClipboardExecFixture();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  delete process.env['TMUX'];
  delete process.env['LC_TERMINAL'];
});

describe('copyNative', () => {
  it('feeds text to pbcopy via stdin (never argv) on darwin', async () => {
    setPlatform('darwin');
    await expect(copyNative('secret value')).resolves.toBe(true);
    expect(readClipboardExecCalls()).toEqual([{ file: 'pbcopy', args: [], stdin: 'secret value' }]);
  });

  it('feeds text to clip via stdin on win32', async () => {
    setPlatform('win32');
    await expect(copyNative('payload')).resolves.toBe(true);
    expect(readClipboardExecCalls()).toEqual([{ file: 'clip', args: [], stdin: 'payload' }]);
  });

  it('probes wl-copy first on linux and feeds stdin', async () => {
    setPlatform('linux');
    await expect(copyNative('x')).resolves.toBe(true);
    expect(readClipboardExecCalls()[0]).toEqual({ file: 'wl-copy', args: [], stdin: 'x' });
  });
});

describe('tmuxLoadBuffer', () => {
  it('returns false without TMUX and never spawns', async () => {
    delete process.env['TMUX'];
    expect(await tmuxLoadBuffer('x')).toBe(false);
    expect(readClipboardExecCalls()).toHaveLength(0);
  });

  it('runs load-buffer -w - and feeds stdin when TMUX is set', async () => {
    process.env['TMUX'] = '/tmp/tmux-1/default,1,0';
    expect(await tmuxLoadBuffer('buf')).toBe(true);
    expect(readClipboardExecCalls()[0]).toEqual({
      file: 'tmux',
      args: ['load-buffer', '-w', '-'],
      stdin: 'buf',
    });
  });

  it('drops -w for iTerm2 to avoid the empty-param OSC crash', async () => {
    process.env['TMUX'] = '/tmp/tmux-1/default,1,0';
    process.env['LC_TERMINAL'] = 'iTerm2';
    expect(await tmuxLoadBuffer('buf')).toBe(true);
    expect(readClipboardExecCalls()[0]?.args).toEqual(['load-buffer', '-']);
  });

  it('returns false on a non-zero tmux exit', async () => {
    process.env['TMUX'] = '/tmp/tmux-1/default,1,0';
    setClipboardExitCodes({ tmux: 1 });
    expect(await tmuxLoadBuffer('buf')).toBe(false);
  });
});
