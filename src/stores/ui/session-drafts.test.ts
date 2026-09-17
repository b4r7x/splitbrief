import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { sessionDir } from '../../core/paths.js';
import { readSessionDraft } from '../../core/sessions/draft.js';
import { flushSessionDrafts, loadSessionDraft, saveSessionDraft } from './session-drafts.js';

describe('pending session drafts', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = createTempDir('session-draft-');
    vi.useFakeTimers();
  });
  afterEach(() => {
    flushSessionDrafts();
    vi.useRealTimers();
    cleanupTempDir(projectDir);
  });

  it('flushes the latest change synchronously before the debounce and reloads it from disk', () => {
    const ref = { projectDir, sessionId: 'one' };
    saveSessionDraft(ref, createDraftDocument('old'));
    const latest = createDraftDocument('last key\nsecond line');
    saveSessionDraft(ref, latest);
    expect(readSessionDraft(ref)).toBeNull();
    flushSessionDrafts();
    expect(readSessionDraft(ref)).toEqual(latest);
    expect(loadSessionDraft(ref)).toEqual(latest);
    expect(
      loadSessionDraft({ projectDir: join(projectDir, 'other-project'), sessionId: 'one' }),
    ).toEqual(createDraftDocument(''));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains failed writes for explicit retry instead of claiming the draft was saved', () => {
    const ref = { projectDir, sessionId: 'one' };
    const dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    const outside = join(projectDir, 'outside');
    writeFileSync(outside, 'keep');
    const draftFile = join(dir, 'draft.json');
    symlinkSync(outside, draftFile);
    const draft = createDraftDocument('unsaved');
    saveSessionDraft(ref, draft);
    expect(() => flushSessionDrafts()).toThrow();
    expect(loadSessionDraft(ref)).toEqual(draft);
    unlinkSync(draftFile);
    flushSessionDrafts();
    expect(readSessionDraft(ref)).toEqual(draft);
  });
});
