import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { parsePtyChildArgs, runPtyChild } from './pty/child.js';
import {
  PTY_CHILD_PROJECT_ENV,
  PTY_EDITOR_FINISHED_MARKER,
  PTY_EDITOR_SENTINEL_ENV,
  PTY_EDITOR_STARTED_MARKER,
} from './pty/contract.js';
import { runEditorChild } from './pty/editor-child.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PTY behavior child', () => {
  it('rejects arguments before starting the production app', () => {
    expect(() => parsePtyChildArgs([])).not.toThrow();
    expect(() => parsePtyChildArgs(['--scenario', 'home'])).toThrow(
      'PTY child does not accept arguments',
    );
  });

  it('runs the deterministic editor child exactly once', () => {
    const root = createTempDir('pty-editor-child-test');
    const sentinel = join(root, 'editor-ran');
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      runEditorChild(['/tmp/supporting-spec.md'], {
        [PTY_EDITOR_SENTINEL_ENV]: sentinel,
      });

      expect(existsSync(sentinel)).toBe(true);
      expect(output).toBe(
        `${PTY_EDITOR_STARTED_MARKER}:${process.pid}\n${PTY_EDITOR_FINISHED_MARKER}:${process.pid}\n`,
      );
      expect(() =>
        runEditorChild(['/tmp/supporting-spec.md'], {
          [PTY_EDITOR_SENTINEL_ENV]: sentinel,
        }),
      ).toThrow('PTY editor must run exactly once');
    } finally {
      cleanupTempDir(root);
    }
  });

  it('leaves its parent-owned project for parent cleanup when production rendering fails', async () => {
    const environmentRoot = createTempDir('pty-child-parent-cleanup');
    const expectedProjectDir = join(environmentRoot, 'project');
    let renderedProjectDir: string | undefined;
    const exitListeners = process.listenerCount('exit');

    try {
      await expect(
        runPtyChild(
          [],
          {
            renderApp: async (_element, options) => {
              renderedProjectDir = options.projectDir;
              expect(renderedProjectDir).toBe(expectedProjectDir);
              expect(existsSync(renderedProjectDir ?? '')).toBe(true);
              throw new Error('deterministic render setup failure');
            },
          },
          { [PTY_CHILD_PROJECT_ENV]: expectedProjectDir },
        ),
      ).rejects.toThrow('deterministic render setup failure');

      expect(renderedProjectDir).toBe(expectedProjectDir);
      expect(existsSync(expectedProjectDir)).toBe(true);
      expect(process.listenerCount('exit')).toBe(exitListeners);
    } finally {
      cleanupTempDir(environmentRoot);
    }
    expect(existsSync(expectedProjectDir)).toBe(false);
  });

  it('requires an explicit safe parent-owned project path', async () => {
    await expect(
      runPtyChild(
        [],
        {
          renderApp: async () => {
            throw new Error('render must not start');
          },
        },
        {},
      ),
    ).rejects.toThrow('PTY child project path is unavailable or unsafe');
  });
});
