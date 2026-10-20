import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { readSessionDraft, writeSessionDraft } from '../../core/sessions/draft.js';
import type { DraftDocument } from '../../core/schemas/draft-document.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
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

  it('keeps the draft behind a filled-in command when the session is left', async () => {
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
    composerDraftStore.requestDocument(document);
    await flushEffects();
    composerDraftStore.requestCommand('/copy ');
    await flushEffects();
    expect(ui.lastFrame()).toContain('/copy');

    routerStore.navigate({ to: 'home' });
    ui.unmount();
    await flushEffects();
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(document);
  });

  it('keeps the text typed after a filled-in command, under the draft, when the session is left', async () => {
    open('one');
    const composer = () => (
      <Composer
        currentScreen="workflow"
        mode="normal"
        hint=""
        commands={[]}
        onRuntimeCommand={() => {}}
      />
    );
    const ui = renderFeature(composer());
    await flushEffects();
    composerDraftStore.requestDocument(document);
    await flushEffects();
    composerDraftStore.requestCommand('/steer ');
    await flushEffects();
    ui.stdin.write('stop touching the header');
    await flushEffects();

    routerStore.navigate({ to: 'home' });
    ui.unmount();
    await flushEffects();
    const kept: DraftDocument = {
      version: 1,
      parts: [
        ...document.parts.slice(0, 2),
        { kind: 'text', text: 'after\n/steer stop touching the header' },
      ],
    };
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(kept);

    open('one');
    const restored = renderFeature(composer());
    await flushEffects();
    expect(restored.lastFrame()).toContain('[image #1]');
    expect(restored.lastFrame()).toContain('/steer stop touching the header');
    restored.unmount();
  });

  it('keeps only the draft behind a command edited back to its prefill when the session is left', async () => {
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
    composerDraftStore.requestDocument(document);
    await flushEffects();
    composerDraftStore.requestCommand('/steer ');
    await flushEffects();
    ui.stdin.write('x');
    await flushEffects();
    ui.stdin.write('\b');
    await flushEffects();
    expect(ui.lastFrame()).toContain('/steer');
    expect(ui.lastFrame()).not.toContain('/steer x');

    routerStore.navigate({ to: 'home' });
    ui.unmount();
    await flushEffects();
    expect(readSessionDraft({ projectDir, sessionId: 'one' })).toEqual(document);
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

describe('unsent home composer draft', () => {
  let projectDir: string;
  let mounted: ReturnType<typeof renderFeature>[];
  beforeEach(() => {
    mounted = [];
    resetAllStores();
    projectDir = createTempDir('home-draft-');
    configStore.__testReset({ projectDir });
  });
  afterEach(() => {
    for (const ui of mounted) ui.unmount();
    cleanupTempDir(projectDir);
  });

  const home = () => (
    <Composer
      currentScreen="home"
      mode="normal"
      hint=""
      submitKeepsDraft
      commands={[]}
      onRuntimeCommand={() => {}}
    />
  );

  function mountHome() {
    const ui = renderFeature(home());
    mounted.push(ui);
    return ui;
  }

  async function leaveForRunAndReturn(ui: ReturnType<typeof renderFeature>) {
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId: 'one' } }),
      execution: { kind: 'at-rest' },
    });
    ui.unmount();
    await flushEffects();
    routerStore.navigate({ to: 'home' });
    const back = mountHome();
    await flushEffects();
    return back;
  }

  it('comes back when home mounts again after a run was opened, for its own project only', async () => {
    const ui = mountHome();
    await flushEffects();
    ui.stdin.write('Home draft keep this');
    await flushEffects();

    const back = await leaveForRunAndReturn(ui);
    expect(back.lastFrame()).toContain('Home draft keep this');
    back.unmount();

    configStore.__testReset({ projectDir: join(projectDir, 'other') });
    const other = mountHome();
    await flushEffects();
    expect(other.lastFrame()).not.toContain('Home draft keep this');
    other.unmount();
  });

  it('keeps the draft behind a command taken from the palette, not the command', async () => {
    const ui = mountHome();
    await flushEffects();
    ui.stdin.write('Home draft keep this');
    await flushEffects();
    composerDraftStore.requestCommand('/crew ');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('/crew'));

    const back = await leaveForRunAndReturn(ui);
    expect(back.lastFrame()).toContain('Home draft keep this');
    expect(back.lastFrame()).not.toContain('/crew');
    back.unmount();
  });
});
