import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { collectExportData, writeSessionHtmlReport } from './collect.js';

let sessionDirectory: string;
let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('export-collect-test');
  sessionDirectory = join(projectDir, '.diptych', 'sessions', 'test-session');
  mkdirSync(sessionDirectory, { recursive: true });
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

function writeSummary(): void {
  writeFileSync(join(sessionDirectory, 'summary.json'), JSON.stringify(makeSession({
    id: 'test-session',
    status: 'complete',
    feature: 'add auth',
    completedAt: Date.parse('2026-05-04T12:00:00Z'),
    summary: makeSummary({
      feature: 'add auth',
      totalTasks: 3,
      completedByLocal: 2,
      escalatedToPlanner: 1,
      totalTime: 60_000,
    }),
  })));
}

describe('collectExportData', () => {
  it('reads summary.json and returns ExportData', () => {
    writeSummary();

    const result = collectExportData(sessionDirectory, 'test-session');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.feature).toBe('add auth');
    expect(result.data.summary.totalTasks).toBe(3);
    expect(result.data.completedAt).toBe('2026-05-04T12:00:00.000Z');
    expect(result.data.isComplete).toBe(true);
  });

  it('returns missing when summary.json does not exist', () => {
    const result = collectExportData(sessionDirectory, 'missing');
    expect(result.status).toBe('missing');
  });

  it('returns invalid when summary.json exists but is malformed', () => {
    writeFileSync(join(sessionDirectory, 'summary.json'), '{not valid json!!!');
    const result = collectExportData(sessionDirectory, 'test-session');
    expect(result.status).toBe('invalid');
  });

  it('returns invalid when summary.json does not match schema', () => {
    writeFileSync(join(sessionDirectory, 'summary.json'), JSON.stringify({ foo: 'bar' }));
    const result = collectExportData(sessionDirectory, 'test-session');
    expect(result.status).toBe('invalid');
  });

  it('includes evidence when evidence.json is present', () => {
    writeSummary();
    writeFileSync(join(sessionDirectory, 'evidence.json'), JSON.stringify({
      version: 1,
      sessionId: 'test-session',
      feature: 'add auth',
      generatedAt: '2026-05-04T12:00:00Z',
      validationSummary: { passed: 2, failed: 0, skipped: 0, escalated: 0 },
      tasks: [
        {
          id: 'T001',
          title: 'one',
          file: 'src/one.ts',
          status: 'done',
          retries: 0,
          changedFiles: ['src/one.ts'],
          validation: [{ stage: 'test', passed: true }],
          expectedEvidence: ['tests pass'],
          observedEvidence: ['test passed'],
          escalated: false,
        },
        {
          id: 'T002',
          title: 'two',
          file: 'src/two.ts',
          status: 'escalated',
          retries: 0,
          changedFiles: [],
          validation: [],
          expectedEvidence: [],
          observedEvidence: [],
          escalated: true,
        },
      ],
    }));

    const result = collectExportData(sessionDirectory, 'test-session');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.evidence).toEqual({
      totalTasks: 2,
      tasksWithValidationEvidence: 1,
      escalatedTasks: 1,
      failedTasks: 0,
    });
  });

  it('omits optional sections when optional artifacts are missing', () => {
    writeSummary();

    const result = collectExportData(sessionDirectory, 'test-session');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.evidence).toBeUndefined();
    expect(result.data.drift).toBeUndefined();
    expect(result.data.briefQuality).toBeUndefined();
  });

  it('includes drift and brief quality when their artifacts are present', () => {
    writeSummary();
    writeFileSync(join(sessionDirectory, 'drift-report.json'), JSON.stringify({
      version: 1,
      passed: false,
      score: 0.75,
      changedFiles: [],
      expectedFiles: [],
      briefHash: null,
      findings: [
        { severity: 'warning', code: 'missing_expected_file', message: 'missing' },
        { severity: 'error', code: 'out_of_scope_file', message: 'extra' },
      ],
    }));
    writeFileSync(join(sessionDirectory, 'brief-quality.json'), JSON.stringify({
      version: 1,
      passed: true,
      score: 0.95,
      issues: [
        { taskId: 'T001', severity: 'warning', code: 'missing_type_definitions', message: 'missing types' },
      ],
    }));

    const result = collectExportData(sessionDirectory, 'test-session');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.drift).toEqual({ passed: false, score: 0.75, errorCount: 1, warningCount: 1 });
    expect(result.data.briefQuality).toEqual({ passed: true, score: 0.95, errorCount: 0, warningCount: 1 });
  });
});

describe('writeSessionHtmlReport', () => {
  it('writes report.html by default', () => {
    writeSummary();

    const result = writeSessionHtmlReport(sessionDirectory, 'test-session');

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' ? result.path : '').toBe(join(sessionDirectory, 'report.html'));
    expect(readFileSync(join(sessionDirectory, 'report.html'), 'utf-8')).toMatch(/^<!DOCTYPE html>/);
  });

  it('reports missing when summary.json does not exist', () => {
    const result = writeSessionHtmlReport(sessionDirectory, 'test-session');
    expect(result).toEqual({ status: 'error', error: 'No summary.json found for session' });
  });

  it('reports invalid when summary.json is corrupt', () => {
    writeFileSync(join(sessionDirectory, 'summary.json'), '{broken');
    const result = writeSessionHtmlReport(sessionDirectory, 'test-session');
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error).toContain('could not be parsed');
  });
});
