import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { detectProjectLanguage } from './project-meta.js';

function withTempProject(fn: (dir: string) => void): void {
  const tmpDir = createTempDir('project-meta-language');
  try {
    fn(tmpDir);
  } finally {
    cleanupTempDir(tmpDir);
  }
}

describe('detectProjectLanguage', () => {
  it.each([
    [
      'TypeScript package projects',
      (dir: string) =>
        writeFileSync(join(dir, 'package.json'), '{"devDependencies":{"typescript":"^6.0.0"}}'),
      'typescript',
    ],
    [
      'Python project markers',
      (dir: string) => {
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]');
      },
      'python',
    ],
    [
      'Rust from Cargo.toml',
      (dir: string) => writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myapp"'),
      'rust',
    ],
    [
      'Go from go.mod',
      (dir: string) => writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp'),
      'go',
    ],
    [
      'JavaScript package projects',
      (dir: string) =>
        writeFileSync(join(dir, 'package.json'), '{"dependencies":{"express":"^4.0.0"}}'),
      'javascript',
    ],
    ['unknown projects', () => {}, undefined],
  ] as const)('detects %s', (_name, arrange, expected) => {
    withTempProject((tmpDir) => {
      arrange(tmpDir);
      expect(detectProjectLanguage(tmpDir)).toBe(expected);
    });
  });
});
