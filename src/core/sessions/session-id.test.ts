import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateSessionId } from './session-id.js';
import { SPLITBRIEF_DIR } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('active-test');
  return tmp;
}

describe('generateSessionId', () => {
  it.each([
    {
      feature: 'Add email validator',
      isoDate: '2026-04-14T10:00:00Z',
      expectedId: '2026-04-14-add-email-validator',
    },
    {
      feature: 'Dodaj walidację e-mail',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-dodaj-walidacj-e-mail',
    },
    {
      feature: '機能を追加',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-unknown',
    },
    {
      feature: 'Add--email  validator',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-add-email-validator',
    },
    {
      feature: '---feature---',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-feature',
    },
    {
      feature: 'Add email validator',
      isoDate: '2026-04-15T02:00:00Z',
      expectedId: '2026-04-15-add-email-validator',
    },
    {
      feature: 'Add email validator',
      isoDate: '2026-01-05T23:30:00Z',
      expectedId: '2026-01-05-add-email-validator',
    },
  ])('builds $expectedId from feature and UTC date', ({ feature, isoDate, expectedId }) => {
    const dir = makeTmp();
    const id = generateSessionId({ projectDir: dir, feature, now: new Date(isoDate) });
    expect(id).toBe(expectedId);
  });

  it('appends -2 on first collision', () => {
    const dir = makeTmp();
    mkSessionDir(dir, '2026-04-14-add-email-validator');
    const id = generateSessionId({
      projectDir: dir,
      feature: 'Add email validator',
      now: new Date('2026-04-14T10:00:00Z'),
    });
    expect(id).toBe('2026-04-14-add-email-validator-2');
  });

  it('appends -3 on second collision', () => {
    const dir = makeTmp();
    mkSessionDir(dir, '2026-04-14-add-email-validator');
    mkSessionDir(dir, '2026-04-14-add-email-validator-2');
    const id = generateSessionId({
      projectDir: dir,
      feature: 'Add email validator',
      now: new Date('2026-04-14T10:00:00Z'),
    });
    expect(id).toBe('2026-04-14-add-email-validator-3');
  });

  it('reduces emoji and special chars to hyphens', () => {
    const dir = makeTmp();
    const id = generateSessionId({
      projectDir: dir,
      feature: '🚀 Launch rocket! 🎉',
      now: new Date('2026-04-14T00:00:00Z'),
    });
    expect(id).not.toContain('🚀');
    expect(id).not.toContain('🎉');
    expect(id).toMatch(/^2026-04-14-[a-z0-9-]+$/);
  });

  it('truncates slug to 50 characters', () => {
    const dir = makeTmp();
    const longFeature =
      'this is a very long feature description that exceeds fifty characters easily';
    const id = generateSessionId({
      projectDir: dir,
      feature: longFeature,
      now: new Date('2026-04-14T00:00:00Z'),
    });
    const slug = id.slice('2026-04-14-'.length);
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('keeps the feature slug', () => {
    const dir = makeTmp();
    const id = generateSessionId({
      projectDir: dir,
      feature: 'Add email validator',
      now: new Date('2026-04-14T10:00:00Z'),
    });
    expect(id).toBe('2026-04-14-add-email-validator');
  });
});

function mkSessionDir(projectDir: string, id: string): void {
  mkdirSync(join(projectDir, SPLITBRIEF_DIR, 'sessions', id), { recursive: true });
}
