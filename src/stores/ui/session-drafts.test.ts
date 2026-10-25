import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { sessionDir } from '../../core/paths.js';
import { readSessionDraft, writeSessionDraft } from '../../core/sessions/draft.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { routerStore } from '../navigation/router.js';
import { feedbackStore } from './feedback.js';
import {
  draftRefusalStore,
  __testDiscardPending,
  flushSessionDrafts,
  loadSessionDraft,
  nameDraftsNotRemoved,
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
    expect(existsSync(draftFile)).toBe(false);
    saveSessionDraft(ref, createDraftDocument('typed'));
    expect(existsSync(draftFile)).toBe(false);
    expect(readSessionDraft(ref)).toBeNull();
    flushSessionDrafts();
    expect(existsSync(draftFile)).toBe(true);
    saveSessionDraft(ref, createDraftDocument(''));
    expect(existsSync(draftFile)).toBe(false);
    expect(readSessionDraft(ref)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the file without advancing the timers when saving an empty document after a non-empty one', () => {
    const ref = { projectDir, sessionId: 'one' };
    const draftFile = join(sessionDir(projectDir, 'one'), 'draft.json');
    saveSessionDraft(ref, createDraftDocument('typed'));
    expect(readSessionDraft(ref)).toBeNull();
    flushSessionDrafts();
    expect(existsSync(draftFile)).toBe(true);
    saveSessionDraft(ref, createDraftDocument(''));
    expect(existsSync(draftFile)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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

describe('an emptied draft whose old file cannot be removed', () => {
  let projectDir: string;
  let dir: string;
  const ref = () => ({ projectDir, sessionId: 'one' });
  const NOTE =
    'Could not remove the old draft: permission denied · .splitbrief/sessions/one/draft.json · its text comes back when you restart SPLITBRIEF and open that run';

  beforeEach(() => {
    projectDir = createTempDir('session-draft-unremovable-');
    dir = sessionDir(projectDir, 'one');
    writeSessionDraft(ref(), createDraftDocument('my unsent draft'));
    chmodSync(dir, 0o555);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: ref() }),
      execution: { kind: 'at-rest' },
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    __testDiscardPending();
    vi.useRealTimers();
    routerStore.reset();
    feedbackStore.reset();
    cleanupTempDir(projectDir);
  });

  it('does not throw, holds nothing, and opens the run empty again in this process', () => {
    saveSessionDraft(ref(), createDraftDocument(''));

    expect(() => flushSessionDrafts()).not.toThrow();
    expect(draftRefusalStore.get()).toBeNull();
    expect(readSessionDraft(ref())).toEqual(createDraftDocument('my unsent draft'));
    expect(loadSessionDraft(ref())).toEqual(createDraftDocument(''));
  });

  it('says nothing on the typing save', () => {
    saveSessionDraft(ref(), createDraftDocument(''));
    vi.advanceTimersByTime(300);

    expect(draftRefusalStore.get()).toBeNull();
    expect(feedbackStore.get().message).toBeNull();
  });

  it('brings the old text back in a new process', () => {
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    __testDiscardPending();

    expect(loadSessionDraft(ref())).toEqual(createDraftDocument('my unsent draft'));
  });

  it('names the file once, on home feedback, however often it is left', () => {
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    routerStore.navigate({ to: 'home' });
    nameDraftsNotRemoved('screen');
    expect(feedbackStore.get()).toEqual({ message: NOTE, isError: true });

    feedbackStore.reset();
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    nameDraftsNotRemoved('screen');
    expect(feedbackStore.get().message).toBeNull();
  });

  it('names the file at the transcript tail when the leave lands on another run', () => {
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId: 'two' } }),
      execution: { kind: 'at-rest' },
    });
    nameDraftsNotRemoved('screen');

    expect(draftRefusalStore.get()?.message).toBe(NOTE);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('keeps throwing the save failure of another session in the same flush', () => {
    const blocked = { projectDir, sessionId: 'two' };
    const blockedDir = sessionDir(projectDir, 'two');
    mkdirSync(blockedDir, { recursive: true });
    chmodSync(blockedDir, 0o555);
    try {
      saveSessionDraft(ref(), createDraftDocument(''));
      saveSessionDraft(blocked, createDraftDocument('real unsent words'));

      expect(() => flushSessionDrafts()).toThrow(
        'Draft not saved: permission denied · .splitbrief/sessions/two/draft.json',
      );
      expect(loadSessionDraft(blocked)).toEqual(createDraftDocument('real unsent words'));
      expect(loadSessionDraft(ref())).toEqual(createDraftDocument(''));
    } finally {
      chmodSync(blockedDir, 0o755);
    }
  });

  it('holds again for real text typed over the old file', () => {
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    saveSessionDraft(ref(), createDraftDocument('typed again'));

    expect(() => flushSessionDrafts()).toThrow(
      'Draft not saved: permission denied · .splitbrief/sessions/one/draft.json',
    );
  });

  it('removes the file and reads it again once the folder is writable', () => {
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    chmodSync(dir, 0o755);
    saveSessionDraft(ref(), createDraftDocument('saved now'));
    flushSessionDrafts();

    expect(loadSessionDraft(ref())).toEqual(createDraftDocument('saved now'));
    saveSessionDraft(ref(), createDraftDocument(''));
    flushSessionDrafts();
    expect(existsSync(join(dir, 'draft.json'))).toBe(false);
  });
});
