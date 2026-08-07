import { describe, expect, it } from 'vitest';
import { extractNamedChangedFiles } from './extract-named-changed-files.js';

describe('extractNamedChangedFiles', () => {
  it('returns an empty list when nothing in the output matches', () => {
    expect(extractNamedChangedFiles('no paths here', ['src/loop.ts'])).toEqual([]);
  });

  it('matches the project-relative path', () => {
    expect(
      extractNamedChangedFiles('error: src/loop.ts(12,5) is broken', [
        'src/loop.ts',
        'src/other.ts',
      ]),
    ).toEqual(['src/loop.ts']);
  });

  it('matches a ./-prefixed occurrence', () => {
    expect(extractNamedChangedFiles('cannot read ./src/loop.ts', ['src/loop.ts'])).toEqual([
      'src/loop.ts',
    ]);
  });

  it('matches backslash separators in the output and the changed file', () => {
    expect(
      extractNamedChangedFiles('error in src\\loop.ts', ['src\\loop.ts', 'src\\other.ts']),
    ).toEqual(['src\\loop.ts']);
  });

  it('matches a basename that is unique among the changed files', () => {
    expect(extractNamedChangedFiles('loop.ts has a type error', ['src/loop.ts'])).toEqual([
      'src/loop.ts',
    ]);
  });

  it('does not match a basename shared with another changed file', () => {
    expect(
      extractNamedChangedFiles('index.ts is broken', ['src/index.ts', 'lib/index.ts']),
    ).toEqual([]);
  });

  it('returns an empty list when the output is empty', () => {
    expect(extractNamedChangedFiles('', ['src/loop.ts'])).toEqual([]);
  });
});
