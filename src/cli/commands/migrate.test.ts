import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { migrateCommand, maybeMigrate } from './migrate.js';
import { DIPTYCH_DIR } from '../../utils/fs.js';

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
    await migrateCommand(tmp);

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

  it('prints "Nothing to migrate." when no legacy dir exists', async () => {
    const output: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => output.push(msg);
    try {
      await migrateCommand(tmp);
    } finally {
      console.log = origLog;
    }
    expect(output).toContain('Nothing to migrate.');
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
});

describe('maybeMigrate', () => {
  beforeEach(() => {
    tmp = createTempDir('maybe-migrate-test');
  });

  it('is a no-op when no legacy dir exists', async () => {
    await expect(maybeMigrate(tmp)).resolves.toBeUndefined();
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(false);
  });

  it('calls migrateCommand when legacy dir exists', async () => {
    setupLegacyDir(tmp);
    await maybeMigrate(tmp);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(true);
  });
});
