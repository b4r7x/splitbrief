import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box } from 'ink';
import type { ComponentProps } from 'react';
import { Composer } from './composer.js';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '../../../testing/helpers/temp-dir.js';
import { configStore } from '../../stores/project/config.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';

const COMMANDS: RuntimeCommandDef[] = [
  { kind: 'noarg', name: '/help', label: 'Help', description: 'Show help', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: 'Workflow mode', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/settings', label: 'Settings', description: 'Open settings', validScreens: ['home'], handler: () => {} },
];

const DOWN = '\u001b[B';
const TAB = '\t';
const ENTER = '\r';

function renderDockedComposer(props: ComponentProps<typeof Composer>) {
  return renderFeature(
    <Box flexDirection="column" height={20} justifyContent="flex-end">
      <Composer {...props} />
    </Box>,
  );
}

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

    ui.stdin.write('/mde');
    await tick(20);

    expect(ui.lastFrame()).toContain('/mde');

    ui.stdin.write(TAB);
    await tick(20);

    expect(ui.lastFrame()).toContain('/mode');

    ui.stdin.write(ENTER);
    await tick(20);

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

    ui.stdin.write('/');
    await tick(20);
    ui.stdin.write(DOWN);
    await tick(20);
    ui.stdin.write(TAB);
    await tick(20);

    expect(ui.lastFrame()).toContain('/mode');
    expect(commandCalls).toEqual([]);

    ui.stdin.write(ENTER);
    await tick(20);
    expect(commandCalls).toEqual(['/mode']);
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

      ui.stdin.write('@src/');
      await tick(20);

      expect(ui.lastFrame()).toContain('src/app.ts');

      ui.stdin.write(TAB);
      await tick(20);
      ui.stdin.write(' done');
      await tick(20);
      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['@src/app.ts done']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

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

      ui.stdin.write('@src');
      await tick(20);
      expect(ui.lastFrame()).toContain('src/app.ts');

      ui.stdin.write(DOWN);
      await tick(20);
      ui.stdin.write(ENTER);
      await tick(20);

      expect(ui.lastFrame()).toContain('@src/components/composer/composer.tsx');
      expect(submits).toEqual([]);

      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['@src/components/composer/composer.tsx']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

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

      ui.stdin.write('@src');
      await tick(20);

      expect(ui.lastFrame()).toContain('src/app.ts');

      ui.stdin.write('\u001b');
      await tick(20);

      const dismissedFrame = ui.lastFrame() ?? '';
      expect(dismissedFrame).toContain('@src');
      expect(dismissedFrame).not.toContain('src/app.ts');

      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['@src']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

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

      ui.stdin.write('email user@example.com');
      await tick(20);

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('user@example.com');
      expect(frame).not.toContain('src/app.ts');

      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['email user@example.com']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
