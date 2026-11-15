import { describe, expect, it } from 'vitest';
import { isWithinRoot } from './within.js';

describe('isWithinRoot', () => {
  it.each([
    ['/work/repo', '/work/repo', true],
    ['/work/repo', '/work/repo/src/a.ts', true],
    ['/work/repo', '/work/repo/..cache', true],
    ['/work/repo', '/work', false],
    ['/work/repo', '/work/x', false],
    ['/work/repo', '/work/repository/a.ts', false],
    ['/work/repo', '/elsewhere/a.ts', false],
    ['/', '/etc/hosts', true],
  ])('root %j holds %j: %j', (root, target, expected) => {
    expect(isWithinRoot(root, target)).toBe(expected);
  });
});
