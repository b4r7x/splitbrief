import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useCommandCompletion } from './hook.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import { inputHistoryStore } from '../../../../stores/ui/input-history.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle.js';

const DOWN = '\u001B[B';
const TAB = '\t';
const ENTER = '\r';

const COMMANDS: RuntimeCommandDef[] = [
  { kind: 'noarg', name: '/help', label: 'Help', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'arg', name: '/mode', label: 'Mode', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/settings', label: 'Settings', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/planner', label: 'Planner', description: '', validScreens: ['home'], handler: () => {} },
  { kind: 'noarg', name: '/quit', label: 'Quit', description: '', validScreens: ['home'], handler: () => {} },
];

interface HarnessProps {
  value: string;
  onRuntimeCommand: (command: string) => void;
  onState?: (state: { filtered: RuntimeCommandDef[]; fuzzyMatch: RuntimeCommandDef | null }) => void;
  setValueSpy?: { current: ((v: string) => void) | null };
}

function Harness({ value: initialValue, onRuntimeCommand, onState, setValueSpy }: HarnessProps) {
  const [value, setValue] = React.useState(initialValue);
  if (setValueSpy) setValueSpy.current = setValue;
  const result = useCommandCompletion({
    commands: COMMANDS,
    currentScreen: 'home',
    value,
    setValue,
    onRuntimeCommand,
  });
  if (onState) onState({ filtered: result.filtered, fuzzyMatch: result.fuzzyMatch });
  return React.createElement(
    Text,
    null,
    `value=${value}|first=${result.filtered[0]?.name ?? ''}|selected=${result.filtered[result.selectedIndex]?.name ?? ''}|fuzzy=${result.fuzzyMatch?.name ?? ''}`,
  );
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('useCommandCompletion (integration)', () => {
  beforeEach(() => {
    inputHistoryStore.reset();
    lifecycleStore.__testReset();
  });

  afterEach(() => {
    inputHistoryStore.reset();
    lifecycleStore.__testReset();
  });

  it('Enter on a prefix-filtered command invokes onRuntimeCommand with the selected command', async () => {
    let received: string | null = null;
    const instance = render(
      React.createElement(Harness, {
        value: '/he',
        onRuntimeCommand: (cmd: string) => { received = cmd; },
      }),
    );
    await flush();
    expect(instance.lastFrame() ?? '').toContain('first=/help');

    instance.stdin.write(ENTER);
    await flush();

    expect(received).toBe('/help');
    expect(inputHistoryStore.get().entries[0]).toBe('/help');

    instance.unmount();
  });

  it('Tab with only a fuzzy match rewrites the value to the fuzzy-matched command name', async () => {
    const setValueSpy: HarnessProps['setValueSpy'] = { current: null };
    let received: string | null = null;
    const instance = render(
      React.createElement(Harness, {
        value: '/hlp',
        onRuntimeCommand: (cmd: string) => { received = cmd; },
        setValueSpy,
      }),
    );
    await flush();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('first=');
    expect(frame).toContain('fuzzy=/help');

    instance.stdin.write(TAB);
    await flush();

    expect(instance.lastFrame() ?? '').toContain('value=/help');
    expect(received).toBeNull();

    instance.unmount();
  });

  it('Down then Enter invokes the highlighted prefix match', async () => {
    let received: string | null = null;
    const instance = render(
      React.createElement(Harness, {
        value: '/',
        onRuntimeCommand: (cmd: string) => { received = cmd; },
      }),
    );
    await flush();
    expect(instance.lastFrame() ?? '').toContain('selected=/help');

    instance.stdin.write(DOWN);
    await flush();
    expect(instance.lastFrame() ?? '').toContain('selected=/mode');

    instance.stdin.write(ENTER);
    await flush();

    expect(received).toBe('/mode');
    expect(inputHistoryStore.get().entries[0]).toBe('/mode');
    instance.unmount();
  });

  it('Down then Tab fills the highlighted prefix match without dispatching it', async () => {
    let received: string | null = null;
    const instance = render(
      React.createElement(Harness, {
        value: '/',
        onRuntimeCommand: (cmd: string) => { received = cmd; },
      }),
    );
    await flush();

    instance.stdin.write(DOWN);
    await flush();
    instance.stdin.write(TAB);
    await flush();

    expect(instance.lastFrame() ?? '').toContain('value=/mode');
    expect(received).toBeNull();
    expect(inputHistoryStore.get().entries).toEqual([]);
    instance.unmount();
  });
});
