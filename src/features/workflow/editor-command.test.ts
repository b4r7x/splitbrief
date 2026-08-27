import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { editorDisplayLabel, resolveEditorArgv } from './editor-command.js';

function withBinDir<T>(executables: readonly string[], run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'editor-command-test-'));
  try {
    for (const name of executables) {
      const file = join(dir, name);
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o755);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveEditorArgv', () => {
  it('splits non-terminal EDITOR values with arguments', () => {
    withBinDir([], (dir) => {
      expect(
        resolveEditorArgv({
          env: { EDITOR: 'code --wait', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: 'code', args: ['--wait'] });
    });
  });

  it('selects VISUAL over EDITOR when both are plain non-terminal commands', () => {
    withBinDir([], (dir) => {
      expect(
        resolveEditorArgv({
          env: { VISUAL: 'a', EDITOR: 'b', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: 'a', args: [] });
    });
  });

  it('prefers VISUAL exactly over EDITOR and detected GUI editors', () => {
    withBinDir(['cursor'], (dir) => {
      expect(
        resolveEditorArgv({
          env: { VISUAL: 'nvim --clean', EDITOR: 'code --wait', PATH: dir },
          platform: 'darwin',
        }),
      ).toEqual({ command: 'nvim', args: ['--clean'] });
    });
  });

  it('prefers a detected GUI editor over terminal EDITOR fallback', () => {
    withBinDir(['code'], (dir) => {
      expect(
        resolveEditorArgv({
          env: { VISUAL: '', EDITOR: 'vim', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: join(dir, 'code'), args: ['--wait'] });
    });
  });

  it('uses macOS open text-editor fallback before terminal EDITOR fallback', () => {
    withBinDir(['open'], (dir) => {
      expect(
        resolveEditorArgv({
          env: { VISUAL: '', EDITOR: 'vim', PATH: dir },
          platform: 'darwin',
        }),
      ).toEqual({ command: join(dir, 'open'), args: ['-W', '-t'] });
    });
  });

  it('falls back to terminal EDITOR when no GUI editor is detected', () => {
    withBinDir([], (dir) => {
      expect(
        resolveEditorArgv({
          env: { VISUAL: '   ', EDITOR: 'emacs -nw', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: 'emacs', args: ['-nw'] });
    });
  });

  it('defaults to vi when no editor is configured or detected', () => {
    withBinDir([], (dir) => {
      expect(
        resolveEditorArgv({
          env: { VISUAL: '   ', EDITOR: '   ', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: 'vi', args: [] });
    });
  });

  it('skips empty, dot, and relative PATH segments during implicit GUI editor discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editor-command-test-'));
    const previousCwd = cwd();
    try {
      const fakeCode = join(dir, 'code');
      writeFileSync(fakeCode, '#!/bin/sh\n');
      chmodSync(fakeCode, 0o755);
      chdir(dir);

      expect(
        resolveEditorArgv({
          env: { VISUAL: '', EDITOR: 'vim', PATH: '.' },
          platform: 'linux',
        }),
      ).toEqual({ command: 'vim', args: [] });

      expect(
        resolveEditorArgv({
          env: { VISUAL: '', EDITOR: 'vim', PATH: ':./nested' },
          platform: 'linux',
        }),
      ).toEqual({ command: 'vim', args: [] });
    } finally {
      chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors non-terminal EDITOR over implicit PATH GUI discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editor-command-test-'));
    try {
      const fakeCode = join(dir, 'code');
      writeFileSync(fakeCode, '#!/bin/sh\n');
      chmodSync(fakeCode, 0o755);

      expect(
        resolveEditorArgv({
          env: { VISUAL: '', EDITOR: 'code --wait', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: 'code', args: ['--wait'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on win32 resolves code.cmd and cursor.cmd from absolute PATH before terminal EDITOR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editor-command-test-'));
    try {
      const fakeCode = join(dir, 'code.cmd');
      writeFileSync(fakeCode, '@echo off\n');
      chmodSync(fakeCode, 0o755);

      const codeResult = resolveEditorArgv({
        env: { VISUAL: '', EDITOR: 'vim', PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        platform: 'win32',
      });
      expect(codeResult.args).toEqual(['--wait']);
      expect(basename(codeResult.command).toLowerCase()).toBe('code.cmd');

      rmSync(fakeCode, { force: true });

      const fakeCursor = join(dir, 'cursor.cmd');
      writeFileSync(fakeCursor, '@echo off\n');
      chmodSync(fakeCursor, 0o755);

      const cursorResult = resolveEditorArgv({
        env: { VISUAL: '', EDITOR: 'vim', PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        platform: 'win32',
      });
      expect(cursorResult.args).toEqual(['--wait']);
      expect(basename(cursorResult.command).toLowerCase()).toBe('cursor.cmd');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-executable GUI command matches on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editor-command-test-'));
    try {
      const fakeCursor = join(dir, 'cursor');
      writeFileSync(fakeCursor, '');
      chmodSync(fakeCursor, 0o600);

      expect(
        resolveEditorArgv({
          env: { VISUAL: '', EDITOR: '', PATH: dir },
          platform: 'linux',
        }),
      ).toEqual({ command: 'vi', args: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('editorDisplayLabel', () => {
  it('names the editor by basename', () => {
    expect(editorDisplayLabel('/usr/local/bin/code')).toBe('code');
  });

  it('drops Windows launcher extensions but keeps other suffixes', () => {
    expect(editorDisplayLabel('Cursor.CMD')).toBe('Cursor');
    expect(editorDisplayLabel('editor-sigint.js')).toBe('editor-sigint.js');
  });
});
