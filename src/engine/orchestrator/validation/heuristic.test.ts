import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectValidationHeuristic } from './heuristic.js';

describe('detectValidationHeuristic', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'val-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('detects Rust project from Cargo.toml', () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('rust');
    expect(result?.typecheckCommand).toBe('cargo check');
    expect(result?.lintCommand).toBe('cargo clippy --no-deps');
    expect(result?.testCommand).toBe('cargo test');
  });

  it('detects Go project from go.mod', () => {
    writeFileSync(join(tmpDir, 'go.mod'), 'module example.com/test');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('go');
    expect(result?.typecheckCommand).toBe('go vet ./...');
  });

  it('detects Python project from pyproject.toml', () => {
    writeFileSync(join(tmpDir, 'pyproject.toml'), '[tool.pytest]');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('python');
    expect(result?.typecheckCommand).toBeUndefined();
  });

  it('returns null for TS project without a linter config (use existing defaults)', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toBeNull();
  });

  it('resolves npm run lint for a TS project with only a lint package script', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      '{"devDependencies":{"typescript":"^5"},"scripts":{"lint":"eslint ."}}',
    );
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toEqual({ lintCommand: 'npm run lint', language: 'typescript' });
  });

  it('resolves npm run lint for a JS project with only a lint package script', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"scripts":{"lint":"eslint ."}}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toEqual({
      testCommand: 'npm test',
      lintCommand: 'npm run lint',
      language: 'javascript',
    });
  });

  it('resolves a lint command for a TS project with a Biome config', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toEqual({ lintCommand: 'npx biome check .', language: 'typescript' });
  });

  it('resolves a lint command for a TS project with an ESLint config', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    writeFileSync(join(tmpDir, 'eslint.config.js'), 'export default [];');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.lintCommand).toBe('npx eslint .');
    expect(result?.typecheckCommand).toBeUndefined();
    expect(result?.testCommand).toBeUndefined();
  });

  it('resolves a lint command for a JS project with an ESLint config', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    writeFileSync(join(tmpDir, '.eslintrc.json'), '{}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toEqual({
      testCommand: 'npm test',
      lintCommand: 'npx eslint .',
      language: 'javascript',
    });
  });

  it('returns null when no marker files exist', () => {
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toBeNull();
  });

  it('prefers Cargo.toml over package.json when both exist', () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]');
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('rust');
  });
});
