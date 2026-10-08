import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFormatFixCommand } from './lint-detection.js';

describe('detectFormatFixCommand', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'format-detect-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it.each(['biome.json', 'biome.jsonc'])('resolves biome format when %s exists', (file) => {
    writeFileSync(join(tmpDir, file), '{}');
    expect(detectFormatFixCommand(tmpDir)).toBe('npx biome format --write');
  });

  it.each([
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.yaml',
    '.prettierrc.js',
    'prettier.config.js',
    'prettier.config.mjs',
  ])('resolves prettier when %s exists', (file) => {
    writeFileSync(join(tmpDir, file), '{}');
    expect(detectFormatFixCommand(tmpDir)).toBe('npx prettier --write');
  });

  it('prefers Biome when both formatters are configured', () => {
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    writeFileSync(join(tmpDir, '.prettierrc'), '{}');
    expect(detectFormatFixCommand(tmpDir)).toBe('npx biome format --write');
  });

  it('returns null for an ESLint-only project: --fix is not a formatter', () => {
    writeFileSync(join(tmpDir, '.eslintrc.json'), '{}');
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":"eslint ."}}');
    expect(detectFormatFixCommand(tmpDir)).toBeNull();
  });

  it('returns null without any formatter config', () => {
    expect(detectFormatFixCommand(tmpDir)).toBeNull();
  });

  it('returns null for a project directory that is not there', () => {
    const missing = join(tmpDir, 'no-such-project');
    expect(detectFormatFixCommand(missing)).toBeNull();
  });
});
