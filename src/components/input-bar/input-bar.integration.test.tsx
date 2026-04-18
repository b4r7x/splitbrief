import { beforeEach, describe, expect, it } from 'vitest';
import { InputBar } from './index.js';
import { renderFeature, tick } from '../../../testing/helpers/ink.js';
import { resetAllStores } from '../../../testing/helpers/stores.js';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';

const COMMANDS: SlashCommandDef[] = [
  { kind: 'noarg', name: '/help', label: 'Help', description: 'Show help', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: 'Workflow mode', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/settings', label: 'Settings', description: 'Open settings', validScreens: ['home'], handler: () => {} },
];

describe('input-bar integration: Tab autocomplete', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('typing /mde then Tab fills the input with /mode, then Enter submits the slash command', async () => {
    const slashCalls: string[] = [];
    const submits: string[] = [];

    const ui = renderFeature(
      <InputBar
        commands={COMMANDS}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(t) => submits.push(t)}
        onSlashCommand={(c) => slashCalls.push(c)}
      />,
    );

    ui.stdin.write('/mde');
    await tick(20);

    // Before Tab: typed query shows fuzzy suggestion, buffer still literal /mde
    expect(ui.lastFrame()).toContain('/mde');

    ui.stdin.write('\t');
    await tick(20);

    // Tab replaces the value with the fuzzy match — the frame now shows /mode
    expect(ui.lastFrame()).toContain('/mode');

    ui.stdin.write('\r');
    await tick(20);

    expect(slashCalls).toEqual(['/mode']);
    expect(submits).toEqual([]);

    ui.unmount();
  });
});
