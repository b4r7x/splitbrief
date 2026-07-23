import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeBriefDrift } from './analyze.js';
import { driftReportPath, readDriftReport, writeDriftReport } from './io.js';

describe('readDriftReport — backward compat', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-compat-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not throw on legacy JSON without briefHash and normalizes to null', () => {
    const report = analyzeBriefDrift({ tasks: [], changedFiles: [], diff: '' });
    const { briefHash: _bh, ...legacy } = report;
    const sessionPath = join(dir, '.diptych', 'sessions', 's1');
    mkdirSync(sessionPath, { recursive: true });
    const path = driftReportPath({ projectDir: dir, sessionId: 's1' });
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);
    expect(() => readDriftReport({ projectDir: dir, sessionId: 's1' })).not.toThrow();
    const result = readDriftReport({ projectDir: dir, sessionId: 's1' });
    expect(result).not.toBeNull();
    expect(result?.briefHash).toBeNull();
  });
});

describe('writeDriftReport', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the report at the session path with trailing newline', () => {
    const report = analyzeBriefDrift({ tasks: [], changedFiles: [], diff: '' });
    writeDriftReport({ projectDir: dir, sessionId: 's1' }, report);
    const path = driftReportPath({ projectDir: dir, sessionId: 's1' });
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).version).toBe(1);
  });

  it('returns null when the report file is missing', () => {
    expect(readDriftReport({ projectDir: dir, sessionId: 'missing' })).toBeNull();
  });

  it('returns null when the report file cannot be parsed', () => {
    const path = driftReportPath({ projectDir: dir, sessionId: 's1' });
    mkdirSync(join(dir, '.diptych', 'sessions', 's1'), { recursive: true });
    writeFileSync(path, '{not valid json');
    expect(readDriftReport({ projectDir: dir, sessionId: 's1' })).toBeNull();
  });
});
