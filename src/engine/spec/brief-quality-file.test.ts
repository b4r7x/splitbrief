import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { taskId } from '../../core/schemas/task.js';
import { evaluateBriefQuality, type BriefQualityIssue } from './brief-quality.js';
import { briefQualityReportBytes, writeBriefQualityReport } from './brief-quality-file.js';

const warning: BriefQualityIssue = {
  taskId: taskId('T001'),
  severity: 'warning',
  code: 'missing_type_definitions',
  message: 'Task T001 has no type definitions',
};

const failure: BriefQualityIssue = {
  taskId: taskId('T001'),
  severity: 'error',
  code: 'missing_scope',
  message: 'Task T001 has no scope definition',
};

describe('briefQualityReportBytes', () => {
  it('carries the evaluated score for a warning-carrying issue list', () => {
    const parsed = JSON.parse(briefQualityReportBytes({ issues: [warning] })) as unknown;

    expect(parsed).toEqual({
      version: 1,
      passed: true,
      score: 0.95,
      issues: [warning],
      ruleVersion: 'brief-quality-v1',
    });
  });

  it('reproduces the evaluation verdict of the same issues', () => {
    const evaluated = evaluateBriefQuality([]);
    const bytes = JSON.parse(briefQualityReportBytes({ issues: evaluated.issues })) as {
      passed: boolean;
      score: number;
    };

    expect({ passed: bytes.passed, score: bytes.score }).toEqual({
      passed: evaluated.passed,
      score: evaluated.score,
    });
  });

  it('fails the report when an error issue is present and omits an unknown brief hash', () => {
    const bytes = briefQualityReportBytes({ issues: [failure, warning] });

    expect(JSON.parse(bytes)).toMatchObject({ passed: false, score: 0.75 });
    expect(bytes).not.toContain('briefHash');
  });

  it('records the brief hash it was given', () => {
    expect(JSON.parse(briefQualityReportBytes({ issues: [], briefHash: 'abc' }))).toMatchObject({
      briefHash: 'abc',
    });
  });
});

describe('writeBriefQualityReport', () => {
  it('writes exactly the bytes a report hash is computed over', () => {
    const projectDir = createTempDir('brief-quality-file');
    try {
      const ref = { projectDir, sessionId: 'brief-quality-file-session' };
      ensureSessionDir(ref.projectDir, ref.sessionId);

      writeBriefQualityReport({
        ref,
        content: { issues: [warning], briefHash: 'brief-hash' },
        metadata: null,
      });

      expect(
        readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), BRIEF_QUALITY_FILE), 'utf8'),
      ).toBe(briefQualityReportBytes({ issues: [warning], briefHash: 'brief-hash' }));
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
