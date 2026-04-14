import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateSessionId } from './id.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR } from '../paths.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('session-id-test');
  return tmp;
}

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
