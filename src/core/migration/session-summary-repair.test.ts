import { describe, expect, it, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeLegacySessionSummaryWithoutContextDetected } from '#testing/helpers/factories/legacy-session-summary.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { repairSessionSummaries } from './session-summary-repair.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function writeLegacySummaryWithoutContextDetected(
  summaryPath: string,
  sessionId: string,
  payloadId = sessionId,
): void {
  writeFileSync(
    summaryPath,
    JSON.stringify(makeLegacySessionSummaryWithoutContextDetected({ sessionId, payloadId })),
  );
}

describe('repairSessionSummaries', () => {
  it('persists legacy summaries missing contextDetected', () => {
    tmp = createTempDir('summary-repair-test');
    const sessionId = '2024-01-01-legacy-summary';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    const summaryPath = join(sessionDir, 'summary.json');
    mkdirSync(sessionDir, { recursive: true });
    writeLegacySummaryWithoutContextDetected(summaryPath, sessionId);

    expect(repairSessionSummaries(tmp)).toMatchObject({ checked: 1, repaired: 1 });

    const repaired = JSON.parse(readFileSync(summaryPath, 'utf-8')) as {
      summary: {
        costPrediction: {
          deterministic: {
            contextConfidenceCounts: { contextDetected?: number };
          };
        };
      };
    };
    expect(
      repaired.summary.costPrediction.deterministic.contextConfidenceCounts.contextDetected,
    ).toBe(1);
  });

  itUnix('skips a sessions root symlinked outside the project', () => {
    tmp = createTempDir('summary-repair-outside-root');
    const outside = createTempDir('summary-repair-outside-sessions');
    try {
      mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
      symlinkSync(outside, join(tmp, DIPTYCH_DIR, SESSIONS_DIR), 'dir');

      const result = repairSessionSummaries(tmp);
      expect(result).toMatchObject({
        checked: 0,
        repaired: 0,
        skippedInvalid: 0,
        skippedUnreadable: 0,
      });
      expect(result.warnings.some((w) => w.includes('symlink'))).toBe(true);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('warns and skips when the sessions root is a regular file', () => {
    tmp = createTempDir('summary-repair-root-file');
    mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
    writeFileSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR), 'not-a-directory');

    const result = repairSessionSummaries(tmp);
    expect(result).toMatchObject({
      checked: 0,
      repaired: 0,
      skippedInvalid: 0,
      skippedUnreadable: 0,
    });
    expect(result.warnings.some((w) => w.includes('not a directory'))).toBe(true);
  });

  itUnix('skips symlinked summary.json as unreadable', () => {
    tmp = createTempDir('summary-repair-symlink-summary');
    const outside = createTempDir('summary-repair-outside-summary');
    try {
      const sessionId = '2024-01-01-symlink-summary';
      const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
      const summaryPath = join(sessionDir, 'summary.json');
      mkdirSync(sessionDir, { recursive: true });
      writeLegacySummaryWithoutContextDetected(join(outside, 'summary.json'), sessionId);
      symlinkSync(join(outside, 'summary.json'), summaryPath);

      expect(repairSessionSummaries(tmp)).toMatchObject({
        checked: 0,
        repaired: 0,
        skippedUnreadable: 1,
      });
    } finally {
      cleanupTempDir(outside);
    }
  });

  itUnix('skips fifo summary.json as unreadable', () => {
    tmp = createTempDir('summary-repair-fifo-summary');
    const sessionId = '2024-01-01-fifo-summary';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    const summaryPath = join(sessionDir, 'summary.json');
    mkdirSync(sessionDir, { recursive: true });
    execSync(`mkfifo ${JSON.stringify(summaryPath)}`);

    expect(repairSessionSummaries(tmp)).toMatchObject({
      checked: 0,
      repaired: 0,
      skippedUnreadable: 1,
    });
  });

  it('canonicalizes payload id to the directory id when repairing', () => {
    tmp = createTempDir('summary-repair-id-mismatch');
    const sessionId = '2024-01-01-directory-id';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    const summaryPath = join(sessionDir, 'summary.json');
    mkdirSync(sessionDir, { recursive: true });
    writeLegacySummaryWithoutContextDetected(summaryPath, sessionId, 'wrong-payload-id');

    expect(repairSessionSummaries(tmp)).toMatchObject({ checked: 1, repaired: 1 });

    const repaired = JSON.parse(readFileSync(summaryPath, 'utf-8')) as { id: string };
    expect(repaired.id).toBe(sessionId);
  });
});
