import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readActive, writeActive, clearActive, isSessionLive, generateSessionId } from './lifecycle.js';
import { DIPTYCH_DIR } from '../paths.js';
import { sessionDir } from '../paths.js';
import { STATE_FILE } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../state/machine.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('active-test');
  return tmp;
}

describe('writeActive / readActive round-trip', () => {
  it('writes and reads back the session id', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-my-feature' });
    expect(readActive(dir)).toBe('2026-04-14-my-feature');
  });

  it('trims trailing newline', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    expect(readActive(dir)).toBe('2026-04-14-feature');
  });

  it('rejects invalid session ids', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    expect(() => writeActive({ projectDir: dir, sessionId: '../outside' })).toThrow('Invalid session id');
  });
});

describe('readActive', () => {
  it('returns null when active file does not exist', () => {
    const dir = makeTmp();
    expect(readActive(dir)).toBeNull();
  });

  it('returns null for empty file', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeFileSync(join(dir, '.diptych', 'active'), '');
    expect(readActive(dir)).toBeNull();
  });
});

describe('clearActive', () => {
  it('deletes the active file', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    clearActive(dir);
    expect(readActive(dir)).toBeNull();
  });

  it('is a no-op if active file does not exist', () => {
    const dir = makeTmp();
    expect(() => clearActive(dir)).not.toThrow();
  });
});

describe('isSessionLive', () => {
  it('returns false when session folder does not exist', () => {
    const dir = makeTmp();
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-nonexistent' })).toBe(false);
  });

  it('returns false for session in complete phase', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-done');
    mkdirSync(sDir, { recursive: true });
    const state = { ...createInitialState('done'), phase: 'complete' };
    writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-done' })).toBe(false);
  });

  it('returns false for session in idle phase', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-idle');
    mkdirSync(sDir, { recursive: true });
    const state = createInitialState('idle');
    writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-idle' })).toBe(false);
  });

  it('returns true for session in implementing phase', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-implementing');
    mkdirSync(sDir, { recursive: true });
    const state = { ...createInitialState('feature'), phase: 'implementing' };
    writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-implementing' })).toBe(true);
  });

  it('returns false when state.json is corrupt', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-corrupt');
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, STATE_FILE), '{bad json!!!');
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-corrupt' })).toBe(false);
  });

  it('rejects invalid session ids before reading state', () => {
    const dir = makeTmp();
    expect(() => isSessionLive({ projectDir: dir, sessionId: '../outside' })).toThrow('Invalid session id');
  });
});

function mkSessionDir(projectDir: string, id: string): void {
  mkdirSync(join(projectDir, DIPTYCH_DIR, 'sessions', id), { recursive: true });
}

describe('generateSessionId', () => {
  it('formats date as YYYY-MM-DD with feature slug', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00'));
    expect(id).toBe('2026-04-14-add-email-validator');
  });

  it('appends -2 on first collision', () => {
    const dir = makeTmp();
    mkSessionDir(dir, '2026-04-14-add-email-validator');
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00'));
    expect(id).toBe('2026-04-14-add-email-validator-2');
  });

  it('appends -3 on second collision', () => {
    const dir = makeTmp();
    mkSessionDir(dir, '2026-04-14-add-email-validator');
    mkSessionDir(dir, '2026-04-14-add-email-validator-2');
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00'));
    expect(id).toBe('2026-04-14-add-email-validator-3');
  });

  it('reduces non-alphanumeric characters to hyphens (Polish diacritics)', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Dodaj walidację e-mail', new Date('2026-04-14T00:00:00'));
    expect(id).toBe('2026-04-14-dodaj-walidacj-e-mail');
  });

  it('reduces emoji and special chars to hyphens', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, '🚀 Launch rocket! 🎉', new Date('2026-04-14T00:00:00'));
    expect(id).not.toContain('🚀');
    expect(id).not.toContain('🎉');
    expect(id).toMatch(/^2026-04-14-[a-z0-9-]+$/);
  });

  it('truncates slug to 50 characters', () => {
    const dir = makeTmp();
    const longFeature = 'this is a very long feature description that exceeds fifty characters easily';
    const id = generateSessionId(dir, longFeature, new Date('2026-04-14T00:00:00'));
    const slug = id.slice('2026-04-14-'.length);
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('collapses multiple non-alphanumeric chars into single hyphen', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add--email  validator', new Date('2026-04-14T00:00:00'));
    expect(id).toBe('2026-04-14-add-email-validator');
  });

  it('strips leading and trailing hyphens from slug', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, '---feature---', new Date('2026-04-14T00:00:00'));
    expect(id).toBe('2026-04-14-feature');
  });
});
