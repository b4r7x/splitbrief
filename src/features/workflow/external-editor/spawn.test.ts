import { afterEach, expect, it, vi } from 'vitest';
import { setActiveTerminalHandover } from '../../../lib/terminal/editor-handover.js';
import { runEditor, spawnEditorProcess } from './spawn.js';
import { ChildProcess, spawn } from 'node:child_process';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  setActiveTerminalHandover(undefined);
  vi.restoreAllMocks();
});

it.each([
  ['/usr/bin/open', ['-W', '-t']],
  ['code', ['--wait']],
] as const)(
  'opens a file in %s while the terminal stays under TUI control',
  async (command, args) => {
    const sourceStdin = { pause: vi.fn(), resume: vi.fn() };
    setActiveTerminalHandover({ fullscreen: true, mouse: false, sourceStdin });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const proc = new ChildProcess();
    vi.mocked(spawn).mockReturnValueOnce(proc);
    const exited = runEditor({
      command,
      args: [...args],
      kind: 'editor',
      filePath: '/tmp/plan.md',
      spawnEditor: spawnEditorProcess,
    });
    proc.emit('close', 0, null);
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    expect(sourceStdin.pause).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      command,
      [...args, '/tmp/plan.md'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  },
);
