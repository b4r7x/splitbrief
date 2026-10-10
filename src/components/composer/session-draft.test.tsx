import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { readSessionDraft, writeSessionDraft } from '../../core/sessions/draft.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { routerStore } from '../../stores/navigation/router.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { flushSessionDrafts } from '../../stores/ui/session-drafts.js';
import { Composer } from './composer.js';

const document: DraftDocument = {
  version: 1,
  parts: [
    { kind: 'text', text: 'before\npasted one\npasted two\npasted three\n' },
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
    { kind: 'text', text: 'after' },
  ],
};

describe('unsent session composer draft', () => {
  let projectDir: string;
  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('session-draft-');
  });
  afterEach(() => {
    flushSessionDrafts();
    cleanupTempDir(projectDir);
  });

  function open(sessionId: string) {
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId } }),
      execution: { kind: 'at-rest' },
    });
  }

  it('restores full ordered content after leaving, isolates other sessions, and survives a disk reload without submitting', async () => {
    open('one');
    const onSubmit = vi.fn();
    const composer = (mode: 'normal' | 'question' = 'normal') => (
      <Composer
        currentScreen="workflow"
        mode={mode}
        questionEpoch={1}
        hint=""
        commands={[]}
        onSubmit={onSubmit}
        onRuntimeCommand={() => {}}
      />
    );
    const ui = renderFeature(composer());
    await flushEffects();
    composerDraftStore.requestDocument(document);
    await flushEffects();
    flushSessionDrafts();
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(document);
    ui.rerender(composer('question'));
    await flushEffects();
    ui.rerender(composer());
    await flushEffects();
    expect(ui.lastFrame()).toContain('[image #1]');
    expect(ui.lastFrame()).toContain('after');
    routerStore.navigate({ to: 'home' });
    ui.unmount();
    await flushEffects();
    open('two');
    const other = renderFeature(composer());
    await flushEffects();
    expect(other.lastFrame()).not.toContain('after');
    other.unmount();
    await flushEffects();
    open('one');
    const restored = renderFeature(composer('question'));
    await flushEffects();
    expect(restored.lastFrame()).toContain('[image #1]');
    expect(restored.lastFrame()).toContain('pasted two');
    expect(onSubmit).not.toHaveBeenCalled();
    flushSessionDrafts();
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(document);
    restored.unmount();
  });

  it('keeps typed edits with their session when switching a mounted composer', async () => {
    open('one');
    const ui = renderFeature(
      <Composer
        currentScreen="workflow"
        mode="normal"
        hint=""
        commands={[]}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('first session');
    await flushEffects();
    flushSessionDrafts();
    open('two');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('first session');
    ui.stdin.write('second session');
    await flushEffects();
    open('one');
    await flushEffects();
    expect(ui.lastFrame()).toContain('first session');
    expect(ui.lastFrame()).not.toContain('second session');
    flushSessionDrafts();
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(
      createDraftDocument('first session'),
    );
    expect(readSessionDraft({ projectDir, sessionId: 'two' })).toEqual(
      createDraftDocument('second session'),
    );
    ui.unmount();
  });

  it('clears a submitted draft on disk so it does not replay on reopen', async () => {
    const ref = { projectDir, sessionId: 'one' };
    writeSessionDraft(ref, createDraftDocument('send this'));
    open('one');
    const onSubmit = vi.fn();
    const ui = renderFeature(
      <Composer
        currentScreen="workflow"
        mode="normal"
        hint=""
        commands={[]}
        onSubmit={onSubmit}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    flushSessionDrafts();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ text: 'send this' }) }),
    );
    expect(readSessionDraft(ref)).toEqual(createDraftDocument(''));
    ui.unmount();
  });

  it('keeps a whitespace-padded draft verbatim on disk when the submit trims it', async () => {
    const ref = { projectDir, sessionId: 'one' };
    open('one');
    const onSubmit = vi.fn();
    const ui = renderFeature(
      <Composer
        currentScreen="workflow"
        mode="normal"
        hint=""
        submitKeepsDraft
        commands={[]}
        onSubmit={onSubmit}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('  keep my spacing  ');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    flushSessionDrafts();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ text: 'keep my spacing' }) }),
    );
    expect(readSessionDraft(ref)).toEqual(createDraftDocument('  keep my spacing  '));
    ui.unmount();
  });

  it('flushes a consumed quit command as an empty draft before its handler exits', async () => {
    const ref = { projectDir, sessionId: 'one' };
    writeSessionDraft(ref, createDraftDocument('/quit'));
    open('one');
    const onRuntimeCommand = vi.fn(() => {
      flushSessionDrafts();
      expect(readSessionDraft(ref)).toEqual(createDraftDocument(''));
    });
    const ui = renderFeature(
      <Composer
        currentScreen="workflow"
        mode="normal"
        hint=""
        commands={[]}
        onRuntimeCommand={onRuntimeCommand}
      />,
    );
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(onRuntimeCommand).toHaveBeenCalledWith('/quit');
    ui.unmount();
  });
});
