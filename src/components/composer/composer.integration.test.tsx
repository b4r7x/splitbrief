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
import { inputHeightStore } from '../../stores/ui/input-height.js';
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

describe('composer integration: Tab autocomplete', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('typing /mde then Tab fills the input with /mode, then Enter submits the command', async () => {
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

  it('typing / then Down and Tab fills the highlighted command', async () => {
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

  it('keeps the reserved input height stable while command suggestions overlay', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await tick(20);

    const before = inputHeightStore.get().rows;
    ui.stdin.write('/');
    await tick(20);

    expect(ui.lastFrame()).toContain('Tab fill');
    expect(inputHeightStore.get().rows).toBe(before);
    ui.unmount();
  });

  it('typing @src/ shows project file suggestions, fills the selected path, and appends later input', async () => {
    const projectDir = createTempDir('composer-at-file');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), '');
      configStore.__testReset({ projectDir });

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

  it('keeps the reserved input height stable while file suggestions overlay', async () => {
    const projectDir = createTempDir('composer-at-file-height');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), '');
      configStore.__testReset({ projectDir });

      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: () => {},
        onRuntimeCommand: () => {},
      });
      await tick(20);

      const before = inputHeightStore.get().rows;
      ui.stdin.write('@src/');
      await tick(20);

      expect(ui.lastFrame()).toContain('src/app.ts');
      expect(inputHeightStore.get().rows).toBe(before);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
