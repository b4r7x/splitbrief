import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { migrateCommand, maybeMigrate } from './executor.js';
import { DIPTYCH_DIR } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '../../../testing/fixtures/legacy-diptych-current');

const EXPECTED_SESSION_ID = '2026-03-15-add-email-validator';

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
    expect(existsSync(sessDir)).toBe(true);

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
    mkdirSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated`), { recursive: true });
    mkdirSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated-2`), { recursive: true });

    const result = await migrateCommand(tmp);

    expect(result).toMatchObject({
      status: 'migrated',
      sessionId: `${EXPECTED_SESSION_ID}-migrated-3`,
    });
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}-migrated-3`))).toBe(true);
  });

  it('falls back to the current date when legacy startedAt is invalid', async () => {
    const legacyDir = join(tmp, DIPTYCH_DIR, 'current');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'state.json'), JSON.stringify({
      feature: 'broken date',
      startedAt: 'not-a-date',
      sessionId: 'legacy-session-abc',
    }));

    await migrateCommand(tmp);

    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions', `${today}-broken-date`))).toBe(true);
  });

  it('removes temporary artifacts when migration fails after creating temp dir', async () => {
    setupLegacyDir(tmp);
    const eventsPath = join(tmp, DIPTYCH_DIR, 'current', 'events.jsonl');
    rmSync(eventsPath, { force: true });
    mkdirSync(eventsPath, { recursive: true });

    await expect(migrateCommand(tmp)).rejects.toThrow();

    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions', `${EXPECTED_SESSION_ID}.tmp`))).toBe(false);
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
