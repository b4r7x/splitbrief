import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeLegacySessionSummaryWithoutContextDetected } from '#testing/helpers/factories/legacy-session-summary.js';
import { migrateCommand, maybeMigrate, maybeMigrateWithSummaryRepair } from './executor.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { matches } from '../../utils/error.js';

const FIXTURE_DIR = join(import.meta.dirname, '../../../testing/fixtures/legacy-diptych-current');

const EXPECTED_SESSION_ID = '2026-03-15-add-email-validator';

function writeLegacySummaryWithoutContextDetected(summaryPath: string, sessionId: string): void {
  writeFileSync(
    summaryPath,
    JSON.stringify(makeLegacySessionSummaryWithoutContextDetected({ sessionId })),
  );
}

function setupLegacyDir(projectDir: string): void {
  const legacyDir = join(projectDir, DIPTYCH_DIR, 'current');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'state.json'), readFileSync(join(FIXTURE_DIR, 'state.json')));
  writeFileSync(join(legacyDir, 'events.jsonl'), readFileSync(join(FIXTURE_DIR, 'events.jsonl')));
  writeFileSync(join(legacyDir, 'spec.md'), readFileSync(join(FIXTURE_DIR, 'spec.md')));
}

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('migrateCommand', () => {
  beforeEach(() => {
    tmp = createTempDir('migrate-test');
  });

  it('migrates legacy .diptych/current/ to session folder', async () => {
    setupLegacyDir(tmp);
    const result = await migrateCommand(tmp);

    expect(result).toMatchObject({ status: 'migrated', sessionId: EXPECTED_SESSION_ID });

    const sessDir = join(tmp, DIPTYCH_DIR, 'sessions', EXPECTED_SESSION_ID);

    const state = JSON.parse(readFileSync(join(sessDir, 'state.json'), 'utf-8'));
    expect(state.stateVersion).toBe(3);
    expect(state.plannerSessionId).toBe('legacy-session-abc');
    expect(state.awaitingContinue).toBe(false);
    expect(state.messageQueue).toEqual([]);
    expect('sessionId' in state).toBe(false);

    const sessionLog = readFileSync(join(sessDir, 'session.jsonl'), 'utf-8');
    const lines = sessionLog.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    const line0 = JSON.parse(lines[0]!) as Record<string, unknown>;
    const line1 = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(line0.kind).toBe('event');
    expect(line1.kind).toBe('event');
    expect(line0.type).toBe('workflow_started');
    expect(line1.type).toBe('spec_done');

    expect(existsSync(join(sessDir, 'spec.md'))).toBe(true);

    const active = readFileSync(join(tmp, DIPTYCH_DIR, 'active'), 'utf-8').trim();
    expect(active).toBe(EXPECTED_SESSION_ID);

    expect(existsSync(join(tmp, DIPTYCH_DIR, 'current'))).toBe(false);
  });

  it('returns not-needed when no legacy dir exists', async () => {
    await expect(migrateCommand(tmp)).resolves.toEqual({ status: 'not-needed' });
  });

  it('handles collision by appending -migrated suffix', async () => {
    setupLegacyDir(tmp);
    mkdirSync(join(tmp, DIPTYCH_DIR, 'sessions', EXPECTED_SESSION_ID), { recursive: true });

    await migrateCommand(tmp);

    const migratedDir = join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated`);
    expect(existsSync(migratedDir)).toBe(true);

    const active = readFileSync(join(tmp, DIPTYCH_DIR, 'active'), 'utf-8').trim();
    expect(active).toBe(`${EXPECTED_SESSION_ID}-migrated`);
  });

  it('handles repeated migration collisions', async () => {
    setupLegacyDir(tmp);
    mkdirSync(join(tmp, DIPTYCH_DIR, 'sessions', EXPECTED_SESSION_ID), { recursive: true });
    mkdirSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated`), {
      recursive: true,
    });
    mkdirSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated-2`), {
      recursive: true,
    });

    const result = await migrateCommand(tmp);

    expect(result).toMatchObject({
      status: 'migrated',
      sessionId: `${EXPECTED_SESSION_ID}-migrated-3`,
    });
    expect(
      existsSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated-3`)),
    ).toBe(true);
  });

  it('falls back to the current date when legacy startedAt is invalid', async () => {
    const legacyDir = join(tmp, DIPTYCH_DIR, 'current');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'state.json'),
      JSON.stringify({
        feature: 'broken date',
        startedAt: 'not-a-date',
        phase: 'idle',
        currentTaskIndex: 0,
        attempt: 0,
        tasks: [],
        sessionId: 'legacy-session-abc',
        tokenUsage: {
          plannerInput: 0,
          plannerOutput: 0,
          implementerInput: 0,
          implementerOutput: 0,
          escalationInput: 0,
          escalationOutput: 0,
        },
      }),
    );

    await migrateCommand(tmp);

    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions', `${today}-broken-date`))).toBe(true);
  });

  it('skips and preserves the legacy directory when the migrated state fails schema validation', async () => {
    const legacyDir = join(tmp, DIPTYCH_DIR, 'current');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'state.json'),
      JSON.stringify({
        feature: 'bad phase',
        startedAt: '2026-03-15T10:00:00.000Z',
        phase: 'not-a-real-phase',
        currentTaskIndex: 0,
        attempt: 0,
        tasks: [],
        sessionId: 'legacy-session-abc',
        tokenUsage: {
          plannerInput: 0,
          plannerOutput: 0,
          implementerInput: 0,
          implementerOutput: 0,
          escalationInput: 0,
          escalationOutput: 0,
        },
      }),
    );

    const result = await migrateCommand(tmp);

    expect(result.status).toBe('skipped');
    expect(existsSync(legacyDir)).toBe(true);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions', '2026-03-15-bad-phase.tmp'))).toBe(false);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'active'))).toBe(false);
    if (result.status === 'skipped') {
      expect(result.warnings.some((w) => w.includes('does not match the current schema'))).toBe(
        true,
      );
    }
  });

  it('refuses to migrate a legacy dir that resolves outside the project root', async () => {
    const outside = createTempDir('migrate-outside');
    try {
      writeFileSync(join(outside, 'state.json'), '{}');
      mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
      symlinkSync(outside, join(tmp, DIPTYCH_DIR, 'current'), 'dir');

      const err = await migrateCommand(tmp).then(
        () => {
          throw new Error('expected migrateCommand to throw');
        },
        (caught: unknown) => caught,
      );

      expect(matches('migration-legacy-dir-outside-root')(err)).toBe(true);
      expect((err as { message: string }).message).toContain('Refusing to migrate');
      expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(false);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('removes temporary artifacts when migration fails after creating temp dir', async () => {
    setupLegacyDir(tmp);
    const eventsPath = join(tmp, DIPTYCH_DIR, 'current', 'events.jsonl');
    rmSync(eventsPath, { force: true });
    mkdirSync(eventsPath, { recursive: true });

    await expect(migrateCommand(tmp)).rejects.toThrow();

    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}.tmp`))).toBe(
      false,
    );
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'current'))).toBe(true);
  });
});

describe('maybeMigrate', () => {
  beforeEach(() => {
    tmp = createTempDir('maybe-migrate-test');
  });

  it('is a no-op when no legacy dir exists', async () => {
    await expect(maybeMigrate(tmp)).resolves.toEqual({ status: 'not-needed' });
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(false);
  });

  it('migrates legacy state into the sessions directory', async () => {
    setupLegacyDir(tmp);
    await maybeMigrate(tmp);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(true);
  });
});

describe('maybeMigrateWithSummaryRepair', () => {
  beforeEach(() => {
    tmp = createTempDir('maybe-migrate-repair-test');
  });

  it('runs summary repair after migration', async () => {
    setupLegacyDir(tmp);
    const sessionId = '2024-01-01-legacy-summary';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    const summaryPath = join(sessionDir, 'summary.json');
    mkdirSync(sessionDir, { recursive: true });
    writeLegacySummaryWithoutContextDetected(summaryPath, sessionId);

    const { migration, repair } = await maybeMigrateWithSummaryRepair(tmp);

    expect(migration.status).toBe('migrated');
    expect(repair).toMatchObject({ checked: 1, repaired: 1 });
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

  it('still repairs summaries when no legacy migration is needed', async () => {
    const sessionId = '2024-01-01-legacy-summary';
    const sessionDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    const summaryPath = join(sessionDir, 'summary.json');
    mkdirSync(sessionDir, { recursive: true });
    writeLegacySummaryWithoutContextDetected(summaryPath, sessionId);

    const { migration, repair } = await maybeMigrateWithSummaryRepair(tmp);

    expect(migration.status).toBe('not-needed');
    expect(repair).toMatchObject({ checked: 1, repaired: 1 });
  });
});
