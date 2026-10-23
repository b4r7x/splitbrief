import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { sessionDir } from '../../core/paths.js';
import { readSessionDraft } from '../../core/sessions/draft.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { routerStore } from '../navigation/router.js';
import { feedbackStore } from './feedback.js';
import {
  draftRefusalStore,
  flushSessionDrafts,
  loadSessionDraft,
  reportDraftNotSaved,
  saveSessionDraft,
} from './session-drafts.js';

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

  it('writes no file for a cleared draft and removes the one it saved before', () => {
    const ref = { projectDir, sessionId: 'one' };
    const draftFile = join(sessionDir(projectDir, 'one'), 'draft.json');
    saveSessionDraft(ref, createDraftDocument(''));
    flushSessionDrafts();
    expect(existsSync(draftFile)).toBe(false);
    saveSessionDraft(ref, createDraftDocument('typed'));
    flushSessionDrafts();
    saveSessionDraft(ref, createDraftDocument(''));
    flushSessionDrafts();
    expect(existsSync(draftFile)).toBe(false);
  });

  it('names the draft file and the cause in plain words when the draft cannot be saved', () => {
    const ref = { projectDir, sessionId: 'one' };
    const dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    saveSessionDraft(ref, createDraftDocument('unsaved'));
    try {
      expect(() => flushSessionDrafts()).toThrow(
        'Draft not saved: permission denied · .splitbrief/sessions/one/draft.json',
      );
      saveSessionDraft(ref, createDraftDocument(''));
      flushSessionDrafts();
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('saves every draft it can before it names the first one that failed', () => {
    const blocked = { projectDir, sessionId: 'a' };
    const writable = { projectDir, sessionId: 'b' };
    const dir = sessionDir(projectDir, 'a');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      saveSessionDraft(blocked, createDraftDocument('first session'));
      saveSessionDraft(writable, createDraftDocument('second session'));
      let failure: unknown;
      try {
        flushSessionDrafts();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('.splitbrief/sessions/a/draft.json');
      expect(readSessionDraft(writable)).toEqual(createDraftDocument('second session'));

      reportDraftNotSaved(failure, false);
      expect(() => flushSessionDrafts()).toThrow('.splitbrief/sessions/a/draft.json');
      expect(draftRefusalStore.get()?.message).toBe(
        'Draft not saved: permission denied · .splitbrief/sessions/a/draft.json',
      );
      chmodSync(dir, 0o755);
      flushSessionDrafts();
      expect(readSessionDraft(blocked)).toEqual(createDraftDocument('first session'));
      expect(draftRefusalStore.get()).toBeNull();
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('records the cause and the file of a failed typing save and keeps the feedback row short', () => {
    const ref = { projectDir, sessionId: 'one' };
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref }),
      execution: { kind: 'at-rest' },
    });
    const dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      saveSessionDraft(ref, createDraftDocument('typed'));
      vi.advanceTimersByTime(300);
      expect(draftRefusalStore.get()?.message).toBe(
        'Draft not saved: permission denied · .splitbrief/sessions/one/draft.json',
      );
      expect(feedbackStore.get()).toEqual({ message: 'Draft not saved', isError: true });
    } finally {
      chmodSync(dir, 0o755);
      routerStore.reset();
      feedbackStore.reset();
    }
  });
});
