import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { WORKFLOW_MODES } from '../../core/schemas/enums.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { Screen } from '../../core/navigation/types.js';
import { createInitialState } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { routerStore } from '../../stores/navigation/router.js';
import { handleSessionSelect, sessionSelectStore } from '../../stores/navigation/session-select.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { skillsStore } from '../../stores/project/skills.js';
import { buildPaletteSources } from './sources.js';

const noop = () => {};
const noopSessionSelect = async () => {};

function buildCommandSources(
  commands: RuntimeCommandDef[],
  onRuntimeCommand: (raw: string) => void = noop,
  opts: { screen?: Screen; phase?: Phase } = {},
) {
  return buildPaletteSources({
    commands,
    screen: opts.screen ?? 'home',
    config: makeConfig(),
    phase: opts.phase ?? 'idle',
    tasks: [],
    sessions: [],
    projectDir: '/tmp/splitbrief-test',
    onRuntimeCommand,
    onSessionSelect: noopSessionSelect,
  }).commandItems;
}

function buildRegistrySources(onRuntimeCommand: (raw: string) => void = noop) {
  return buildCommandSources(createRuntimeCommands(makeCtx()), onRuntimeCommand, {
    screen: 'workflow',
    phase: 'implementing',
  });
}

describe('buildPaletteSources command items', () => {
  it('converts visible commands to palette command items', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/help',
        label: 'Help',
        description: 'Show help',
        shortcut: 'ctrl+/',
        category: 'navigate',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: '/help',
      description: 'Show help',
      shortcut: 'ctrl+/',
      category: 'navigate',
    });
  });

  it('excludes hidden commands and commands unavailable on the current screen', () => {
    const items = buildCommandSources([
      {
        kind: 'noarg',
        name: '/hidden',
        description: 'Hidden',
        category: 'navigate',
        hidden: true,
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/workflow-only',
        description: 'Workflow command',
        category: 'navigate',
        validScreens: ['workflow'],
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        description: 'Visible command',
        category: 'navigate',
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => item.label)).toEqual(['/visible']);
  });

  it('excludes phase-guarded commands outside their valid phase', () => {
    const commands: RuntimeCommandDef[] = [
      {
        kind: 'arg',
        name: '/redo-task',
        description: 'Reset a task',
        category: 'workflow',
        args: { kind: 'free', hint: '<task-id>' },
        validScreens: ['workflow'],
        guard: (c) => (c.phase === 'implementing' ? undefined : 'Only while implementing'),
        handler: noop,
      },
      {
        kind: 'noarg',
        name: '/visible',
        description: 'Visible command',
        category: 'navigate',
        validScreens: ['workflow'],
        handler: noop,
      },
    ];

    expect(
      buildCommandSources(commands, noop, { screen: 'workflow', phase: 'planning' }).map(
        (item) => item.label,
      ),
    ).toEqual(['/visible']);
    expect(
      buildCommandSources(commands, noop, { screen: 'workflow', phase: 'implementing' }).map(
        (item) => item.label,
      ),
    ).toEqual(['/redo-task', '/visible']);
  });

  it('carries the accepted values of an argument command as its own hint cell', () => {
    const items = buildCommandSources([
      {
        kind: 'arg',
        name: '/mode',
        description: 'Workflow mode',
        category: 'crew',
        args: { kind: 'closed', options: ['instant', 'quick'], optional: true },
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'arg',
        name: '/redo-task',
        description: 'Reset a task',
        category: 'workflow',
        args: { kind: 'free', hint: '<task-id>' },
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => [item.description, item.hint])).toEqual([
      ['Workflow mode', '[instant|quick]'],
      ['Reset a task', '<task-id>'],
    ]);
  });

  it('shows a closed-argument command its grammar hint instead of every option', () => {
    const items = buildCommandSources([
      {
        kind: 'arg',
        name: '/skills',
        description: 'Select planner skills',
        category: 'navigate',
        args: { kind: 'closed', options: ['a', 'b', 'c'], hint: '<thing …>' },
        validScreens: ['home'],
        handler: noop,
      },
      {
        kind: 'arg',
        name: '/scroll',
        description: 'Scroll the transcript',
        category: 'view',
        args: { kind: 'closed', options: ['a', 'b', 'c'] },
        validScreens: ['home'],
        handler: noop,
      },
    ]);

    expect(items.map((item) => [item.description, item.hint])).toEqual([
      ['Select planner skills', '<thing …>'],
      ['Scroll the transcript', '[a|b|c]'],
    ]);
  });

  it('runs a no-argument command through the runtime command callback', () => {
    const calls: string[] = [];
    const items = buildCommandSources(
      [
        {
          kind: 'noarg',
          name: '/settings',
          description: 'Open settings',
          category: 'navigate',
          validScreens: ['home'],
          handler: noop,
        },
      ],
      (raw) => calls.push(raw),
    );

    const action = items[0]?.action;
    if (action?.kind === 'run') void action.run();

    expect(calls).toEqual(['/settings']);
  });
});

describe('buildPaletteSources registry rows', () => {
  it('gives every row a distinct slash-command label', () => {
    const labels = buildRegistrySources().map((item) => item.label);

    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.startsWith('/'))).toBe(true);
  });

  it('offers one prefill row for an argument command instead of one row per option', () => {
    const items = buildRegistrySources();

    const modeRows = items.filter((item) => item.label === '/mode');
    expect(modeRows).toHaveLength(1);
    expect(modeRows[0]?.action).toEqual({ kind: 'prefill', text: '/mode ' });
    for (const mode of WORKFLOW_MODES) {
      expect(items.some((item) => item.label === mode)).toBe(false);
    }
  });
});

function buildSkillRows() {
  return buildPaletteSources({
    commands: [],
    screen: 'home',
    config: makeConfig(),
    phase: 'idle',
    tasks: [],
    sessions: [],
    projectDir: '/tmp/splitbrief-test',
    onRuntimeCommand: noop,
    onSessionSelect: noopSessionSelect,
  }).skillItems;
}

describe('buildPaletteSources skill rows', () => {
  beforeEach(() => {
    skillsStore.reset();
    skillsStore.setAvailable([
      {
        id: 'terminal-layout',
        name: 'Terminal layout',
        description: 'Check spacing and terminal-width behavior',
        path: 'fixtures/skills/terminal-layout/SKILL.md',
        scope: 'project',
      },
      {
        id: 'release-checks',
        name: 'Release checks',
        description: 'Run deterministic quality gates',
        path: 'fixtures/skills/release-checks/SKILL.md',
        scope: 'global',
      },
    ]);
    skillsStore.setSelected(new Set(['terminal-layout']));
  });

  afterEach(() => {
    skillsStore.reset();
  });

  it('renders one row per discovered skill and marks the attached one', () => {
    const rows = buildSkillRows();

    expect(rows.map((row) => row.label)).toEqual([
      'Skill · Terminal layout',
      'Skill · Release checks',
    ]);
    expect(rows.map((row) => row.hint)).toEqual(['attached', null]);
    expect(rows[0]).toMatchObject({
      id: 'terminal-layout',
      description: 'Check spacing and terminal-width behavior',
      category: 'navigate',
    });
  });

  it('toggles the skill selection when a row runs', () => {
    const rows = buildSkillRows();

    const attach = rows[1]?.action;
    if (attach?.kind === 'run') void attach.run();
    expect([...skillsStore.get().selected].sort()).toEqual(['release-checks', 'terminal-layout']);

    const detach = buildSkillRows()[0]?.action;
    if (detach?.kind === 'run') void detach.run();
    expect([...skillsStore.get().selected]).toEqual(['release-checks']);
  });
});

describe('buildPaletteSources session items', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir('palette-session-test');
    overlayStore.reset();
    routerStore.reset();
    feedbackStore.reset();
    sessionSelectStore.reset();
  });

  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    overlayStore.reset();
    routerStore.reset();
    feedbackStore.reset();
    sessionSelectStore.reset();
  });

  it('awaits interrupted-session preparation before exposing the prepared route', async () => {
    const session = makeSession({
      id: 'sess-resume',
      feature: 'add auth',
      status: 'open',
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
      onSessionSelect: (selected, projectDir) =>
        handleSessionSelect(selected, projectDir, {
          loadResumeState: loadOwnerWorkflowState,
          prepareResume: async ({ ref, state }) => ({
            kind: 'prepared',
            execution: prepareWorkflowExecution({
              projectDir: ref.projectDir,
              feature: state.feature,
              sessionId: ref.sessionId,
              resumeState: state,
            }),
          }),
          hydrateRun: async () => {},
        }),
    });

    await sessionItems[0]?.action();

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.execution.kind).toBe('at-rest');
      expect(route.run.ref.sessionId).toBe(session.id);
      expect(route.run.hydration).toEqual({ kind: 'loaded', state: savedState });
    }
  });

  it('opens a palette-picked run with no saved state at rest, rather than refusing it', async () => {
    const session = makeSession({
      id: 'sess-missing-state',
      feature: 'missing state',
      status: 'open',
      summary: null,
    });

    const { sessionItems } = buildPaletteSources({
      commands: [],
      screen: 'home',
      config: makeConfig(),
      phase: 'idle',
      tasks: [],
      sessions: [session],
      projectDir: tmp,
      onRuntimeCommand: noop,
      onSessionSelect: (selected, projectDir) =>
        handleSessionSelect(selected, projectDir, {
          loadResumeState: loadOwnerWorkflowState,
          prepareResume: async () => {
            throw new Error('Preparation should not run without saved state');
          },
          hydrateRun: async () => {},
        }),
    });

    await sessionItems[0]?.action();

    expect(sessionSelectStore.get().error).toBeNull();
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.run.hydration.kind).not.toBe('loaded');
    }
  });
});
