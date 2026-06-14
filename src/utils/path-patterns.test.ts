import { describe, expect, it } from 'vitest';
import { matchesGlob } from './path-patterns.js';

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
