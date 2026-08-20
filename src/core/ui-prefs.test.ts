import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readUiPrefs, writeUiPrefs, DEFAULT_UI_PREFS } from './ui-prefs.js';
import { SPLITBRIEF_DIR } from './paths.js';

describe('ui-prefs', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'splitbrief-ui-prefs-'));
  });

  afterEach(() => {
    try {
      chmodSync(join(testDir, SPLITBRIEF_DIR), 0o700);
    } catch {}
    rmSync(testDir, { recursive: true, force: true });
  });

  it('round-trips sidebar visibility', () => {
    writeUiPrefs(testDir, { sidebarVisible: false });
    expect(readUiPrefs(testDir)).toEqual({ sidebarVisible: false });

    writeUiPrefs(testDir, { sidebarVisible: true });
    expect(readUiPrefs(testDir)).toEqual({ sidebarVisible: true });
  });

  it('falls back to defaults on corrupt json', () => {
    const splitbriefDir = join(testDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      writeFileSync(join(splitbriefDir, 'ui-prefs.json'), '{ not valid json');
      expect(readUiPrefs(testDir)).toEqual(DEFAULT_UI_PREFS);

      writeFileSync(join(splitbriefDir, 'ui-prefs.json'), '"just a string"');
      expect(readUiPrefs(testDir)).toEqual(DEFAULT_UI_PREFS);

      writeFileSync(
        join(splitbriefDir, 'ui-prefs.json'),
        JSON.stringify({ sidebarVisible: 'invalid' }),
      );
      expect(readUiPrefs(testDir)).toEqual(DEFAULT_UI_PREFS);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not throw and warns when the state dir is unwritable', () => {
    const splitbriefDir = join(testDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });
    chmodSync(splitbriefDir, 0o400);

    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      writeUiPrefs(testDir, { sidebarVisible: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ui-prefs: failed to save'));
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores unknown keys in ui-prefs.json', () => {
    const splitbriefDir = join(testDir, SPLITBRIEF_DIR);
    mkdirSync(splitbriefDir, { recursive: true });
    writeFileSync(
      join(splitbriefDir, 'ui-prefs.json'),
      JSON.stringify({ sidebarVisible: false, extraField: 'ignored', count: 42 }),
    );

    expect(readUiPrefs(testDir)).toEqual({ sidebarVisible: false });
  });

  it('returns default preferences when file does not exist', () => {
    expect(readUiPrefs(testDir)).toEqual(DEFAULT_UI_PREFS);
  });
});
