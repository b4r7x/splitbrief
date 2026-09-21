import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../../src/stores/project/config.js';
import { attachmentsStore } from '../../../src/stores/workflow/attachments.js';
import { composerDraftStore } from '../../../src/stores/ui/composer-draft.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import type { ClipboardImageResult } from '../../../src/core/attachments/clipboard-image.js';

const ENTER = '\r';

describe('composer paste capture', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('collapses a big multi-line paste to a dim marker instead of filling the field', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });

    await flushEffects();
    ui.stdin.write('line 1\nline 2\nline 3\nline 4\nline 5');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('[paste #1 +5 lines]');
    expect(frame).not.toContain('line 5');

    ui.unmount();
  });

  it('submits the paste where the caret took it, with what was typed after it', async () => {
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    });

    await flushEffects();
    ui.stdin.write('alpha\nbeta\ngamma\ndelta');
    await flushEffects();
    ui.stdin.write('fix the log');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    // The marker collapses the paste on screen; the text stays in the draft, in its own place.
    expect(submits).toEqual(['alpha\nbeta\ngamma\ndeltafix the log']);
    ui.unmount();
  });

  it('keeps the pasted lines intact, trimming only the edges at send and history recall', async () => {
    const submissions: string[] = [];
    const text = '  alpha\nbeta\ngamma\ndelta\n';
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (value) => submissions.push(value),
      onRuntimeCommand: () => {},
    });
    try {
      await flushEffects();
      ui.stdin.write(text);
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();
      ui.stdin.write('\u001b[A');
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();
      // The paste itself is untouched — every interior line break survives — while the leading
      // spaces and the trailing newline come off at send; history recalls the same trimmed text.
      expect(submissions).toEqual(['alpha\nbeta\ngamma\ndelta', 'alpha\nbeta\ngamma\ndelta']);
    } finally {
      ui.unmount();
    }
  });
});

describe('composer clipboard images', () => {
  let projectDir = '';

  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('composer-clipboard');
    configStore.__testReset({ projectDir, config: makeConfig() });
    terminalSizeStore.__testReset({ cols: 100, rows: 24 });
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  it('inserts the Zed image-paste signal at its caret while typing continues, then sends only remaining atoms', async () => {
    const imagePath = join(projectDir, 'clipboard.png');
    writeFileSync(imagePath, 'image fixture');
    const firstPaste = Promise.withResolvers<ClipboardImageResult>();
    const submissions: string[] = [];
    let reads = 0;
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '',
      onSubmit: (text) => submissions.push(text),
      onRuntimeCommand: () => {},
      readClipboardImage: () => {
        reads += 1;
        return reads === 1 ? firstPaste.promise : Promise.resolve({ ok: true, path: imagePath });
      },
    });
    try {
      await flushEffects();
      ui.stdin.write('left right');
      await flushEffects();
      for (let index = 0; index < 5; index += 1) {
        ui.stdin.write('\u001b[D');
        await flushEffects();
      }
      // Zed 1.20.2 forwards Cmd+V for an image as raw Ctrl+V. This injects that byte,
      // not a native macOS keyboard event; the clipboard port is a fixture.
      ui.stdin.write('\u0016');
      await flushEffects();
      ui.stdin.write('typed ');
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();
      expect(submissions).toEqual([]);
      expect(ui.lastFrame()).toContain('Pasting image');

      ui.stdin.write('fast ');
      firstPaste.resolve({ ok: true, path: imagePath });
      await flushEffects();
      expect(ui.lastFrame()).toContain('left [image #1]typed fast ');
      expect(ui.lastFrame()).toContain('right');
      expect(attachmentsStore.peek()).toEqual([]);

      ui.stdin.write('\u0016');
      await flushEffects();
      expect(ui.lastFrame()).toContain('left [image #1]typed fast [image #2]');
      ui.stdin.write('\u007f');
      await flushEffects();
      expect(ui.lastFrame()).not.toContain('[image #2]');
      ui.stdin.write(ENTER);
      await flushEffects();
      const images = attachmentsStore.peek();
      expect(images).toHaveLength(1);
      expect(images[0]?.path).toContain('clipboard.png');
      expect(submissions[0]).toContain(`left [image:${images[0]?.id}]typed fast right`);
    } finally {
      ui.unmount();
    }
  });

  it('leaves ordinary text alone and reports failed image reads without altering the draft', async () => {
    const submissions: string[] = [];
    let reads = 0;
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '',
      onSubmit: (text) => submissions.push(text),
      onRuntimeCommand: () => {},
      readClipboardImage: async () => {
        reads += 1;
        return { ok: false, reason: 'no-image' };
      },
    });
    try {
      await flushEffects();
      ui.stdin.write('ordinary pasted text');
      await flushEffects();
      expect(reads).toBe(0);
      ui.stdin.write('\u0016');
      await flushEffects();
      expect(ui.lastFrame()).toContain('Clipboard has no image');
      expect(ui.lastFrame()).toContain('ordinary pasted text');
      ui.stdin.write(ENTER);
      await flushEffects();
      expect(submissions).toEqual(['ordinary pasted text']);
      expect(attachmentsStore.peek()).toEqual([]);
    } finally {
      ui.unmount();
    }
  });

  it('removes a deleted retained-draft image from resubmission while preserving an independent attachment', async () => {
    const imagePath = join(projectDir, 'retained.png');
    writeFileSync(imagePath, 'image fixture');
    const submissions: string[] = [];
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '',
      submitKeepsDraft: true,
      onSubmit: (text) => submissions.push(text),
      onRuntimeCommand: () => {},
      readClipboardImage: async () => ({ ok: true, path: imagePath }),
    });
    try {
      await flushEffects();
      ui.stdin.write('keep');
      await flushEffects();
      ui.stdin.write('\u0016');
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();
      expect(attachmentsStore.peek()).toHaveLength(1);
      attachmentsStore.add({
        id: 'explicit-cli-image',
        kind: 'image',
        path: imagePath,
        mimeType: 'image/png',
        sizeBytes: 1,
      });
      ui.stdin.write('\u007f');
      await flushEffects();
      expect(ui.lastFrame()).not.toContain('[image #1]');
      ui.stdin.write(ENTER);
      await flushEffects();
      expect(submissions[1]).toBe('keep');
      expect(attachmentsStore.peek().map((image) => image.id)).toEqual(['explicit-cli-image']);
    } finally {
      ui.unmount();
    }
  });

  it('cancels a clipboard read when the draft is replaced and when the composer unmounts', async () => {
    const pending = Promise.withResolvers<ClipboardImageResult>();
    const signals: AbortSignal[] = [];
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      readClipboardImage: ({ signal }) => {
        signals.push(signal);
        return pending.promise;
      },
    });
    await flushEffects();
    ui.stdin.write('\u0016');
    await flushEffects();
    composerDraftStore.request('replacement');
    await flushEffects();
    expect(signals[0]?.aborted).toBe(true);
    expect(ui.lastFrame()).toContain('replacement');
    ui.stdin.write('\u0016');
    await flushEffects();
    ui.unmount();
    expect(signals[1]?.aborted).toBe(true);
    pending.resolve({ ok: true, path: join(projectDir, 'late.png') });
    await flushEffects();
    expect(attachmentsStore.peek()).toEqual([]);
  });

  it('refuses clipboard access for a seat without images', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'shell', command: 'fixture' } }),
    });
    let reads = 0;
    const ui = renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      readClipboardImage: async () => {
        reads += 1;
        return { ok: false, reason: 'no-image' };
      },
    });
    try {
      await flushEffects();
      ui.stdin.write('\u0016');
      await flushEffects();
      expect(ui.lastFrame()).toContain('cannot see images');
      expect(reads).toBe(0);
    } finally {
      ui.unmount();
    }
  });
});
