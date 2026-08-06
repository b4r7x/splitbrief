import { describe, expect, it } from 'vitest';
import { matchesGlob, scopePathPatterns } from './path-patterns.js';

describe('scopePathPatterns', () => {
  it('extracts exactly the backticked path from a prose bullet', () => {
    expect(scopePathPatterns('Modify only `src/core/state/types.ts`.')).toEqual([
      'src/core/state/types.ts',
    ]);
  });

  it('returns nothing for a prose bullet naming no path', () => {
    expect(scopePathPatterns('Do not touch anything outside the task file.')).toEqual([]);
  });

  it('does not treat a bare filename with no directory as a path', () => {
    expect(scopePathPatterns('helpers.ts')).toEqual([]);
    expect(scopePathPatterns('package.json')).toEqual([]);
  });

  it('does not treat a dotted identifier as a path', () => {
    expect(scopePathPatterns('process.stdout.write')).toEqual([]);
  });

  it('keeps a glob scope pattern', () => {
    expect(scopePathPatterns('src/features/**')).toEqual(['src/features/**']);
    expect(scopePathPatterns('Update all `*.md` docs.')).toEqual(['*.md']);
  });

  it('extracts an unquoted path embedded in a sentence', () => {
    expect(scopePathPatterns('Keep src/core/state/types.ts in sync with the plan.')).toEqual([
      'src/core/state/types.ts',
    ]);
  });

  it('drops backticked tokens that are not paths', () => {
    expect(scopePathPatterns('Call `process.stdout.write` once.')).toEqual([]);
  });

  it('trims surrounding whitespace from a bare bullet', () => {
    expect(scopePathPatterns('  src/main.ts  ')).toEqual(['src/main.ts']);
  });
});

describe('matchesGlob', () => {
  it('exact path equality matches', () => {
    expect(matchesGlob('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('/** matches the prefix and any descendant', () => {
    expect(matchesGlob('src/feature/widget.ts', 'src/feature/**')).toBe(true);
    expect(matchesGlob('src/feature/deep/nested.ts', 'src/feature/**')).toBe(true);
    expect(matchesGlob('src/feature', 'src/feature/**')).toBe(true);
    expect(matchesGlob('src/other/widget.ts', 'src/feature/**')).toBe(false);
  });

  it('/* matches direct children only, not nested', () => {
    expect(matchesGlob('src/feature/widget.ts', 'src/feature/*')).toBe(true);
    expect(matchesGlob('src/feature/deep/nested.ts', 'src/feature/*')).toBe(false);
    expect(matchesGlob('src/other/widget.ts', 'src/feature/*')).toBe(false);
  });

  it('*.ext matches by extension regardless of directory', () => {
    expect(matchesGlob('docs/guide.md', '*.md')).toBe(true);
    expect(matchesGlob('a/b/c/notes.md', '*.md')).toBe(true);
    expect(matchesGlob('src/a.ts', '*.md')).toBe(false);
  });

  it('embedded * matches prefix and suffix around the wildcard', () => {
    expect(matchesGlob('src/foo.test.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/foo.test.ts', 'src/foo*')).toBe(true);
    expect(matchesGlob('lib/foo.test.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('src/foo.test.js', 'src/*.ts')).toBe(false);
  });

  it('a literal pattern with no wildcard only matches the exact path', () => {
    expect(matchesGlob('src/feature/widget.ts', 'src/feature')).toBe(false);
  });
});
