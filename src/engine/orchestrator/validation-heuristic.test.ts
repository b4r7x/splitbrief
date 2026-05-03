import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectValidationHeuristic } from './validation-heuristic.js';

describe('detectValidationHeuristic', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'val-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true }); });

  it('detects Rust project from Cargo.toml', () => {
    writeFileSync(join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
    const result = detectValidationHeuristic(tmpDir);
    expect(result?.language).toBe('rust');
    expect(result?.typecheckCommand).toBe('cargo check');
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

  it('returns null for TS project (use existing defaults)', () => {
    writeFileSync(join(tmpDir, 'package.json'), '{"devDependencies":{"typescript":"^5"}}');
    const result = detectValidationHeuristic(tmpDir);
    expect(result).toBeNull();
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
