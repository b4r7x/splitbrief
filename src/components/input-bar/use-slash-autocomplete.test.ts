import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { fuzzyMatchCommand, useSlashAutocomplete } from './use-slash-autocomplete.js';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';

const COMMANDS: SlashCommandDef[] = [
  { kind: 'noarg', name: '/help', label: 'Help', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/settings', label: 'Settings', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/planner', label: 'Planner', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/quit', label: 'Quit', description: '', validScreens: ['home'], handler: () => {} },
];

describe('fuzzyMatchCommand (re-exported from use-slash-autocomplete)', () => {
  it('returns null for empty query', () => {
    expect(fuzzyMatchCommand(COMMANDS, '')).toBeNull();
    expect(fuzzyMatchCommand(COMMANDS, '/')).toBeNull();
  });

  it('resolves typos to the closest command', () => {
    expect(fuzzyMatchCommand(COMMANDS, '/mde')?.name).toBe('/mode');
    expect(fuzzyMatchCommand(COMMANDS, '/settngs')?.name).toBe('/settings');
    expect(fuzzyMatchCommand(COMMANDS, '/hlp')?.name).toBe('/help');
  });

  it('returns null when the query has no resemblance to any command', () => {
    expect(fuzzyMatchCommand(COMMANDS, '/zzzzzzzzz')).toBeNull();
  });

  it('matches without a leading slash', () => {
    expect(fuzzyMatchCommand(COMMANDS, 'hlp')?.name).toBe('/help');
  });
});

interface HarnessProps {
  value: string;
  onSlashCommand: (command: string) => void;
  onState?: (state: { filtered: SlashCommandDef[]; fuzzyMatch: SlashCommandDef | null }) => void;
  setValueSpy?: { current: ((v: string) => void) | null };
}

function Harness({ value: initialValue, onSlashCommand, onState, setValueSpy }: HarnessProps) {
  const [value, setValue] = React.useState(initialValue);
  if (setValueSpy) setValueSpy.current = setValue;
  const result = useSlashAutocomplete({
    commands: COMMANDS,
    currentScreen: 'home',
    value,
    setValue,
    onSlashCommand,
  });
  if (onState) onState({ filtered: result.filtered, fuzzyMatch: result.fuzzyMatch });
  return React.createElement(Text, null, `value=${value}|first=${result.filtered[0]?.name ?? ''}|fuzzy=${result.fuzzyMatch?.name ?? ''}`);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('useSlashAutocomplete (integration)', () => {
  beforeEach(() => {
    inputHistoryStore.reset();
    lifecycleStore.__testReset();
  });

  afterEach(() => {
    inputHistoryStore.reset();
    lifecycleStore.__testReset();
  });

  it('Enter on a prefix-filtered command invokes onSlashCommand with the selected command', async () => {
    let received: string | null = null;
    const instance = render(
      React.createElement(Harness, {
        value: '/he',
        onSlashCommand: (cmd: string) => { received = cmd; },
      }),
    );
    await flush();
    // Prefix filter surfaces /help as the first match for "/he".
    expect(instance.lastFrame() ?? '').toContain('first=/help');

    instance.stdin.write('\r');
    await flush();

    expect(received).toBe('/help');
    // Selected command is pushed to input history on the home screen.
    expect(inputHistoryStore.get().entries[0]).toBe('/help');

    instance.unmount();
  });

  it('Tab with only a fuzzy match rewrites the value to the fuzzy-matched command name', async () => {
    const setValueSpy: HarnessProps['setValueSpy'] = { current: null };
    let received: string | null = null;
    const instance = render(
      React.createElement(Harness, {
        value: '/hlp',
        onSlashCommand: (cmd: string) => { received = cmd; },
        setValueSpy,
      }),
    );
    await flush();
    // No prefix match; fuzzy resolves /hlp → /help.
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('first=');
    expect(frame).toContain('fuzzy=/help');

    instance.stdin.write('\t');
    await flush();

    // After Tab, the controlled value has been rewritten to the fuzzy match.
    expect(instance.lastFrame() ?? '').toContain('value=/help');
    // Tab on a fuzzy match completes; it does not dispatch the command.
    expect(received).toBeNull();

    instance.unmount();
  });
});
