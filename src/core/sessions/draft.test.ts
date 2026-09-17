import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../paths.js';
import type { DraftDocument } from '../schemas/draft-document.js';
import { readSessionDraft, writeSessionDraft } from './draft.js';

const document: DraftDocument = {
  version: 1,
  parts: [
    { kind: 'text', text: 'before\nline two\nline three\nline four\n' },
    {
      kind: 'image',
      attachment: {
        id: 'image-1',
        kind: 'image',
        path: '/tmp/example.png',
        mimeType: 'image/png',
        sizeBytes: 123,
      },
    },
    { kind: 'text', text: '\nafter 🙂' },
  ],
};

describe('session drafts', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = createTempDir('session-draft-');
  });
  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('round trips the complete document in order, isolated by session with private permissions', () => {
    const ref = { projectDir, sessionId: 'one' };
    expect(readSessionDraft(ref)).toBeNull();
    writeSessionDraft(ref, document);
    expect(readSessionDraft(ref)).toEqual(document);
    expect(readSessionDraft({ projectDir, sessionId: 'two' })).toBeNull();
    expect(statSync(join(sessionDir(projectDir, 'one'), 'draft.json')).mode & 0o777).toBe(0o600);
    writeSessionDraft(ref, { version: 1, parts: [] });
    expect(readSessionDraft(ref)?.parts).toEqual([]);
  });

  it('rejects a session symlink pointing at another session in the same project', () => {
    const ref = { projectDir, sessionId: 'one' };
    writeSessionDraft(ref, document);
    symlinkSync(sessionDir(projectDir, 'one'), sessionDir(projectDir, 'two'));
    expect(() => readSessionDraft({ projectDir, sessionId: 'two' })).toThrow();
    expect(() => writeSessionDraft({ projectDir, sessionId: 'two' }, document)).toThrow();
  });

  it('rejects invalid persisted documents', () => {
    const dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'draft.json'), '{"version":9,"parts":[]}');
    expect(() => readSessionDraft({ projectDir, sessionId: 'one' })).toThrow();
  });

  it('does not follow symlinked draft targets or escaped session ids', () => {
    const ref = { projectDir, sessionId: 'one' };
    const dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    const outside = join(projectDir, 'outside');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(dir, 'draft.json'));
    expect(() => writeSessionDraft(ref, document)).toThrow();
    expect(() => readSessionDraft(ref)).toThrow();
    expect(() => writeSessionDraft({ projectDir, sessionId: '../escape' }, document)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  });
});
