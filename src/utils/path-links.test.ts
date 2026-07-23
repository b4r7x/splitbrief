import { describe, expect, it } from 'vitest';
import { filePathUrl, projectRelativePathLabel, resolveMarkdownLinkTarget } from './path-links.js';

describe('projectRelativePathLabel', () => {
  it.each([
    ['/repo/src/app/root.tsx', '/repo', 'src/app/root.tsx'],
    ['/repo/src/app/root.tsx:14', '/repo', 'src/app/root.tsx:14'],
    ['/repo/src/main.ts:12:5', '/repo', 'src/main.ts:12:5'],
    ['/repo/src/a.ts', '/repo/', 'src/a.ts'],
    ['/elsewhere/lib/x.ts', '/repo', '/elsewhere/lib/x.ts'],
    ['/elsewhere/lib/x.ts:3', '/repo', '/elsewhere/lib/x.ts:3'],
    ['/repository/src/a.ts', '/repo', '/repository/src/a.ts'],
    ['/repo', '/repo', '/repo'],
    ['src/app/root.tsx', '/repo', 'src/app/root.tsx'],
    ['./src/app/root.tsx:7', '/repo', './src/app/root.tsx:7'],
  ])('labels %j against root %j as %j', (path, rootDir, expected) => {
    expect(projectRelativePathLabel({ path, rootDir })).toBe(expected);
  });
});

describe('filePathUrl', () => {
  it.each([
    ['src/app/root.tsx', '/repo', 'file:///repo/src/app/root.tsx'],
    ['src/app/root.tsx:14', '/repo', 'file:///repo/src/app/root.tsx'],
    ['docs/GUIDE.md', '/repo/', 'file:///repo/docs/GUIDE.md'],
    ['/repo/src/main.ts', '/repo', 'file:///repo/src/main.ts'],
    ['/repo/src/main.ts:12:5', '/repo', 'file:///repo/src/main.ts'],
    ['/elsewhere/x.ts:3', '/repo', 'file:///elsewhere/x.ts'],
    ['src/x.ts:5', '/Users/jane/My Projects/app', 'file:///Users/jane/My%20Projects/app/src/x.ts'],
    ['notes#1.md', '/repo', 'file:///repo/notes%231.md'],
  ])('resolves %j against root %j to %j', (path, rootDir, expected) => {
    expect(filePathUrl({ path, rootDir })).toBe(expected);
  });
});

describe('resolveMarkdownLinkTarget', () => {
  it.each([
    [
      { label: 'package.json:5', href: 'package.json:5', rootDir: '/repo' },
      { label: 'package.json:5', href: 'file:///repo/package.json' },
    ],
    [
      { label: 'src/x.ts:5', href: 'src/x.ts:5', rootDir: '/repo' },
      { label: 'src/x.ts:5', href: 'file:///repo/src/x.ts' },
    ],
    [
      { label: 'docs', href: 'https://example.com/a', rootDir: '/repo' },
      { label: 'docs', href: 'https://example.com/a' },
    ],
    [
      { label: 'src/x.ts:5', href: 'src/x.ts:5', rootDir: undefined },
      { label: 'src/x.ts:5', href: undefined },
    ],
    [
      { label: 'open the config', href: 'x-vulnerable-app://payload', rootDir: '/repo' },
      { label: 'open the config', href: undefined },
    ],
    [
      { label: 'run', href: 'javascript:alert(1)', rootDir: undefined },
      { label: 'run', href: undefined },
    ],
    [
      { label: 'site', href: 'https://example.com', rootDir: undefined },
      { label: 'site', href: 'https://example.com' },
    ],
    [
      { label: 'site', href: 'http://example.com', rootDir: undefined },
      { label: 'site', href: 'http://example.com' },
    ],
    [
      { label: 'mail', href: 'mailto:a@b.c', rootDir: undefined },
      { label: 'mail', href: 'mailto:a@b.c' },
    ],
    [
      { label: 'file', href: 'file:///x', rootDir: undefined },
      { label: 'file', href: 'file:///x' },
    ],
  ])('resolves %j to %j', (input, expected) => {
    expect(resolveMarkdownLinkTarget(input)).toEqual(expected);
  });
});
