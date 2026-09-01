import { createElement } from 'react';
import { Box, Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../composer.js';
import { renderFeature, flushEffects, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { inputHistoryStore } from '../../../../stores/ui/input-history.js';
import { useCommandCompletion } from './hook.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';

const ENTER = '\r';
const ARROW_UP = '\u001b[A';

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/copy',
    label: 'Copy',
    description: 'Copy a value',
    category: 'navigate',
    args: { kind: 'free', hint: '<text>' },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/queue',
    label: 'Queue',
    description: 'Manage the queue',
    category: 'navigate',
    args: { kind: 'free', hint: '<text>' },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/sidebar',
    label: 'Sidebar',
    description: 'Toggle the sidebar',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/mode',
    label: 'Mode',
    description: 'Workflow mode',
    category: 'crew',
    aliases: [{ name: '/m' }],
    args: { kind: 'closed', options: ['instant', 'quick', 'standard', 'speckit'], optional: true },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/crew',
    label: 'Crew',
    description: 'Who fills each seat',
    category: 'crew',
    aliases: [{ name: '/planner', args: 'plan' }],
    args: { kind: 'closed', options: ['plan', 'build', 'review'], optional: true },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/skills',
    label: 'Skills',
    description: 'Select planner skills',
    category: 'navigate',
    args: {
      kind: 'closed',
      options: ['alpha', 'bravo'],
      optionDescriptions: { alpha: 'Reviews alpha conventions', bravo: 'Drafts bravo notes' },
      optional: true,
    },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/scroll',
    label: 'Scroll',
    description: 'Scroll the transcript',
    category: 'view',
    args: { kind: 'closed', options: ['top', 'bottom', 'page-up', 'page-down'] },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/revise-spec',
    label: 'Revise spec',
    description: 'Revise the spec',
    category: 'workflow',
    args: { kind: 'free', hint: '<instruction>' },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/settings',
    label: 'Settings',
    description: 'Crew, validation, workflow',
    category: 'navigate',
    aliases: [{ name: '/config' }],
    validScreens: ['home'],
    handler: () => {},
  },
];

function ShowSuggestionsHarness({ value, suppressed }: { value: string; suppressed?: boolean }) {
  const command = useCommandCompletion({
    commands: COMMANDS,
    currentScreen: 'home',
    value,
    setValue: () => {},
    onRuntimeCommand: () => {},
    suppressed,
  });
  return createElement(Text, null, String(command.showSuggestions));
}

function renderComposer() {
  const commandCalls: string[] = [];
  const submits: string[] = [];
  const ui = renderFeature(
    createElement(
      Box,
      { flexDirection: 'column', height: 12, justifyContent: 'flex-end' },
      createElement(Composer, {
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text: string) => submits.push(text),
        onRuntimeCommand: (command: string) => commandCalls.push(command),
      }),
    ),
  );
  return { ui, commandCalls, submits };
}

describe('useCommandCompletion submit routing', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('sends an unmatched slash command to the dispatcher on Enter', async () => {
    const { ui, commandCalls, submits } = renderComposer();

    await flushEffects();
    ui.stdin.write('/nope');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/nope');
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/nope']);
      },
      { timeout: 5000 },
    );

    expect(submits).toEqual([]);
    ui.unmount();
  });

  it.each(['/copy path', '/queue clear'])('forwards %s unchanged on Enter', async (typed) => {
    const { ui, commandCalls, submits } = renderComposer();

    await flushEffects();
    ui.stdin.write(typed);
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain(typed);
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual([typed]);
      },
      { timeout: 5000 },
    );

    expect(submits).toEqual([]);
    ui.unmount();
  });

  it('runs the highlighted command when one matches the token', async () => {
    const { ui, commandCalls } = renderComposer();

    await flushEffects();
    ui.stdin.write('/cop');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/cop');
      },
      { timeout: 5000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/copy']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });
});

describe('useCommandCompletion suppression', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('suppressed hides command suggestions for a bare slash value', async () => {
    const shown = renderFeature(createElement(ShowSuggestionsHarness, { value: '/help' }));
    await tick(20);
    expect(shown.lastFrame()).toContain('true');
    shown.unmount();

    const hidden = renderFeature(
      createElement(ShowSuggestionsHarness, { value: '/help', suppressed: true }),
    );
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });

  it('recalling a bare slash command keeps history stepping on up-arrow', async () => {
    inputHistoryStore.hydrate(['/sidebar', 'older-a', 'older-b']);
    const { ui } = renderComposer();

    await flushEffects();
    ui.stdin.write(ARROW_UP);
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/sidebar');
      },
      { timeout: 5000 },
    );
    expect(ui.lastFrame()).not.toContain('Toggle the sidebar');

    await flushEffects();
    ui.stdin.write(ARROW_UP);
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('older-a');
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });
});

describe('useCommandCompletion closed arguments', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('lists the closed option set after the space and runs the picked option on Enter', async () => {
    const { ui, commandCalls } = renderComposer();

    await flushEffects();
    ui.stdin.write('/mode ');
    await tick(20);
    await vi.waitFor(
      () => {
        const frame = ui.lastFrame();
        expect(frame).toContain('instant');
        expect(frame).toContain('quick');
        expect(frame).toContain('standard');
        expect(frame).toContain('speckit');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write('sp');
    await tick(20);
    await vi.waitFor(
      () => {
        const frame = ui.lastFrame();
        expect(frame).toContain('speckit');
        expect(frame).not.toContain('instant');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/mode speckit']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });

  it('runs the highlighted option on Enter when the closed argument is optional', async () => {
    const { ui, commandCalls } = renderComposer();

    await flushEffects();
    ui.stdin.write('/mode ');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('instant');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/mode instant']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });

  it('lists the closed option set for an alias of the command', async () => {
    const shown = renderFeature(createElement(ShowSuggestionsHarness, { value: '/m ' }));
    await tick(20);
    expect(shown.lastFrame()).toContain('true');
    shown.unmount();
  });

  it('runs the highlighted option on Enter when the closed argument is required', async () => {
    const { ui, commandCalls } = renderComposer();

    await flushEffects();
    ui.stdin.write('/scroll ');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('top');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/scroll top']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });

  it('shows no suggestions after the space of an alias that pre-fills the argument', async () => {
    const hidden = renderFeature(createElement(ShowSuggestionsHarness, { value: '/planner ' }));
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });

  it('shows no suggestions when no closed option matches the typed prefix', async () => {
    const hidden = renderFeature(createElement(ShowSuggestionsHarness, { value: '/mode zz' }));
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });

  it('shows no suggestions once a free-argument command has its space', async () => {
    const shown = renderFeature(createElement(ShowSuggestionsHarness, { value: '/revise-spec' }));
    await tick(20);
    expect(shown.lastFrame()).toContain('true');
    shown.unmount();

    const hidden = renderFeature(createElement(ShowSuggestionsHarness, { value: '/revise-spec ' }));
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });

  it('renders the description supplied for a closed option', async () => {
    const { ui } = renderComposer();

    await flushEffects();
    ui.stdin.write('/skills ');
    await tick(20);
    await vi.waitFor(
      () => {
        const frame = ui.lastFrame();
        expect(frame).toContain('Reviews alpha conventions');
        expect(frame).toContain('Drafts bravo notes');
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });

  it('falls back to an empty description when a closed option has none', async () => {
    const { ui } = renderComposer();

    await flushEffects();
    ui.stdin.write('/mode ');
    await tick(20);
    await vi.waitFor(
      () => {
        const frame = ui.lastFrame();
        expect(frame).toContain('instant');
        expect(frame).not.toContain('Workflow mode');
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });

  it('offers an alias under its own name', async () => {
    const { ui, commandCalls } = renderComposer();

    await flushEffects();
    ui.stdin.write('/conf');
    await tick(20);
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain('/config');
      },
      { timeout: 5000 },
    );

    await flushEffects();
    ui.stdin.write(ENTER);
    await vi.waitFor(
      () => {
        expect(commandCalls).toEqual(['/config']);
      },
      { timeout: 5000 },
    );
    ui.unmount();
  });
});
