import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { routerStore } from '../../stores/navigation/router.js';
import { buildPaletteSources } from './sources.js';

const noop = () => {};

function buildCommandSources(
  commands: RuntimeCommandDef[],
  onRuntimeCommand: (raw: string) => void = noop,
) {
  return buildPaletteSources({
    commands,
    screen: 'home',
    config: makeConfig(),
    phase: 'idle',
    tasks: [],
    sessions: [],
    projectDir: '/tmp/diptych-test',
    onRuntimeCommand,
    onWorkflowMode: noop,
  }).commandItems;
}

describe('buildPaletteSources command items', () => {
  it('converts labeled commands to palette command items', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/help',
        label: 'Help',
        description: 'Show help',
        shortcut: 'ctrl+/',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: 'Help',
      description: 'Show help',
      shortcut: 'ctrl+/',
      availableOn: ['home'],
    });
  });

  it('excludes unlabeled commands and commands unavailable on the current screen', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/no-label',
        description: 'Hidden',
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/workflow-only',
        label: 'Workflow only',
        description: 'Workflow command',
        validScreens: ['workflow'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        label: 'Visible',
        description: 'Visible command',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => item.label)).toEqual(['Visible']);
  });

  it('runs command item actions through the runtime command callback', () => {
    const calls: string[] = [];
    const items = buildCommandSources(
      [
        {
          kind: 'noarg',
          name: '/settings',
          label: 'Settings',
          description: 'Open settings',
          validScreens: ['home'],
          handler: noop,
        },
      ],
      (raw) => calls.push(raw),
    );

    items[0]?.action();

    expect(calls).toEqual(['/settings']);
  });
});

describe('buildPaletteSources session items', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir('palette-session-test');
    overlayStore.reset();
    routerStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    overlayStore.reset();
    routerStore.reset();
    feedbackStore.reset();
  });

  it('resumes an interrupted session with its saved state instead of starting fresh', () => {
    const session = makeSession({
      id: 'sess-resume',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = {
      ...createInitialState('saved add auth'),
      phase: 'implementing' as const,
    };
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);

    const { sessionItems } = buildPaletteSources({
      commands: [],
      screen: 'home',
      config: makeConfig(),
      phase: 'idle',
      tasks: [],
      sessions: [session],
      projectDir: tmp,
      onRuntimeCommand: noop,
      onWorkflowMode: noop,
    });

    sessionItems[0]?.action();

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.feature).toBe('saved add auth');
      expect(route.resumeState).toEqual(savedState);
      expect(route.sessionId).toBe(session.id);
    }
  });
});
