import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { loadClaudeCodeModelOptions } from './claude-code-options.js';

describe('loadClaudeCodeModelOptions', () => {
  let home: string | undefined;

  function homeWith(contents: string): string {
    home = createTempDir('claude-code-options');
    writeFileSync(join(home, '.claude.json'), contents);
    return home;
  }

  afterEach(() => {
    if (home) cleanupTempDir(home);
    home = undefined;
  });

  it('reads the account model options Claude Code cached locally', () => {
    const dir = homeWith(
      '{"additionalModelOptionsCache":[{"value":"claude-fable-5[1m]","label":"Fable"}]}',
    );

    expect(loadClaudeCodeModelOptions(dir)).toEqual([
      { id: 'claude-fable-5[1m]', displayName: 'Fable' },
    ]);
  });

  it('keeps the sentence Claude Code stores beside the label', () => {
    const dir = homeWith(
      '{"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]","label":"Fable","description":"Fable 5.1 · Most capable for your hardest and longest-running tasks"}]}',
    );

    expect(loadClaudeCodeModelOptions(dir)).toEqual([
      {
        id: 'claude-fable-5-1[1m]',
        displayName: 'Fable',
        description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
      },
    ]);
  });

  it('leaves the description unset when the entry carries none', () => {
    const dir = homeWith(
      '{"additionalModelOptionsCache":[{"value":"claude-x","label":"X","description":"  "}]}',
    );

    expect(loadClaudeCodeModelOptions(dir)[0]?.description).toBeUndefined();
  });

  it('accepts the cache as an object map as well as an array', () => {
    const dir = homeWith('{"additionalModelOptionsCache":{"a":{"value":"claude-x","label":"X"}}}');

    expect(loadClaudeCodeModelOptions(dir)).toEqual([{ id: 'claude-x', displayName: 'X' }]);
  });

  it('returns no options when ~/.claude.json is missing', () => {
    const dir = createTempDir('claude-code-options');
    home = dir;

    expect(() => loadClaudeCodeModelOptions(dir)).not.toThrow();
    expect(loadClaudeCodeModelOptions(dir)).toEqual([]);
  });

  it('returns no options when ~/.claude.json is corrupt', () => {
    const dir = homeWith('not json{');

    expect(() => loadClaudeCodeModelOptions(dir)).not.toThrow();
    expect(loadClaudeCodeModelOptions(dir)).toEqual([]);
  });

  it('ignores cache entries that carry no model id', () => {
    const dir = homeWith('{"additionalModelOptionsCache":[{"label":"X"},{"value":""},7,null]}');

    expect(loadClaudeCodeModelOptions(dir)).toEqual([]);
  });

  it('drops a duplicated model id', () => {
    const dir = homeWith(
      '{"additionalModelOptionsCache":[{"value":"claude-x","label":"X"},{"value":"claude-x","label":"Later"}]}',
    );

    expect(loadClaudeCodeModelOptions(dir)).toEqual([{ id: 'claude-x', displayName: 'X' }]);
  });
});
