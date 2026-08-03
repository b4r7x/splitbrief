import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushEffects } from '#testing/helpers/ink.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../../src/stores/project/config.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';

const DOWN = '\u001b[B';
const TAB = '\t';
const ENTER = '\r';
const FILE_SCAN_WAIT_MS = 15_000;

function seedProjectFiles(prefix: string, files: string[]): string {
  const projectDir = createTempDir(prefix);
  for (const file of files) {
    const directory = file.split('/').slice(0, -1).join('/');
    if (directory) {
      mkdirSync(join(projectDir, directory), { recursive: true });
    }
    writeFileSync(join(projectDir, file), '');
  }
  configStore.__testReset({ projectDir });
  return projectDir;
}

describe('composer integration: completions', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('completes a fuzzy slash command and dispatches it only after the user submits', async () => {
    const commandCalls: string[] = [];
    const submits: string[] = [];

    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      onSubmit: (t) => submits.push(t),
      onRuntimeCommand: (c) => commandCalls.push(c),
    });
    await flushEffects();

    ui.stdin.write('/mde');
    await flushEffects();

    expect(ui.lastFrame()).toContain('/mde');

    await flushEffects();
    ui.stdin.write(TAB);
    await flushEffects();

    expect(ui.lastFrame()).toContain('/mode');

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(commandCalls).toEqual(['/mode']);
    expect(submits).toEqual([]);

    ui.unmount();
  });

  it('fills the arrow-highlighted slash command without dispatching until submit', async () => {
    const commandCalls: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: (c) => commandCalls.push(c),
    });
    await flushEffects();

    ui.stdin.write('/');
    await flushEffects();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/mode');
    });
    await flushEffects();
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(TAB);
    await flushEffects();

    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/mode');
    });
    expect(ui.lastFrame()).not.toContain('/help');
    expect(commandCalls).toEqual([]);

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/mode']);
    });
    ui.unmount();
  });

  it('typing @src/ shows project file suggestions, fills the selected path, and appends later input', async () => {
    const projectDir = seedProjectFiles('composer-at-file', ['src/app.ts']);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (t) => submits.push(t),
        onRuntimeCommand: () => {},
      });

      await flushEffects();
      ui.stdin.write('@src/');
      await flushEffects();

      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
      }, FILE_SCAN_WAIT_MS);
      await flushEffects();

      ui.stdin.write(TAB);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('@src/app.ts');
      });
      await flushEffects();
      ui.stdin.write(' done');
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();

      expect(submits).toEqual(['@src/app.ts done']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  }, 20_000);

  it('accepts the arrow-highlighted file suggestion with Enter, then submits on the next Enter', async () => {
    const projectDir = seedProjectFiles('composer-at-file-arrow', [
      'src/app.ts',
      'src/components/composer/composer.tsx',
    ]);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submits.push(text),
        onRuntimeCommand: () => {},
      });
      await flushEffects();

      ui.stdin.write('@src');
      await flushEffects();
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
        expect(ui.lastFrame()).toContain('src/components/composer/composer.tsx');
        expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(
          new RegExp(`${glyph('cursor')}\\s+src/app\\.ts`),
        );
      }, FILE_SCAN_WAIT_MS);
      await flushEffects();

      ui.stdin.write(DOWN);
      await flushEffects();
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(
          new RegExp(`${glyph('cursor')}\\s+src/components/composer/composer\\.tsx`),
        );
      });
      await flushEffects();
      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('@src/components/composer/composer.tsx');
      });
      expect(submits).toEqual([]);

      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();

      expect(submits).toEqual(['@src/components/composer/composer.tsx']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  }, 20_000);

  it('Escape dismisses file suggestions without clearing the typed reference', async () => {
    const projectDir = seedProjectFiles('composer-at-file-escape', ['src/app.ts']);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submits.push(text),
        onRuntimeCommand: () => {},
      });
      await flushEffects();

      ui.stdin.write('@src');
      await flushEffects();

      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
      }, FILE_SCAN_WAIT_MS);

      await flushEffects();
      ui.stdin.write('\u001b');
      await flushEffects();

      const dismissedFrame = ui.lastFrame() ?? '';
      expect(dismissedFrame).toContain('@src');
      expect(dismissedFrame).not.toContain('src/app.ts');

      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();

      expect(submits).toEqual(['@src']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  }, 20_000);

  it('treats @ inside a word as plain text instead of opening file suggestions', async () => {
    const projectDir = seedProjectFiles('composer-at-file-boundary', ['src/app.ts']);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submits.push(text),
        onRuntimeCommand: () => {},
      });

      await flushEffects();
      ui.stdin.write('email user@example.com');
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('user@example.com');
      expect(frame).not.toContain('src/app.ts');

      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();

      expect(submits).toEqual(['email user@example.com']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
