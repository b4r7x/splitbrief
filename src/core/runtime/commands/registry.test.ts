import { describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { ALL_SCREENS } from '../../navigation/types.js';
import { WORKFLOW_MODES, type WorkflowMode } from '../../schemas/enums.js';
import { describeModeCost } from '../../pipeline-spec/mode-cost.js';
import {
  COMMAND_CATEGORIES,
  REMOVED_COMMANDS,
  type CommandCategory,
  type RuntimeCommandContext,
  type RuntimeCommandDef,
} from './types.js';
import { navigateCommands } from './defs/navigate.js';
import { crewCommands } from './defs/crew.js';
import { workflowCommands } from './defs/workflow.js';
import { viewCommands } from './defs/view.js';
import { ioCommands } from './defs/io.js';
import { makeCtx, runCommandInTest } from '#testing/helpers/runtime-commands.js';

describe('createRuntimeCommands registry shape', () => {
  const commands = createRuntimeCommands(makeCtx({}));

  it('registers the commands the reference documents, once each', () => {
    const registered = commands.map((cmd) => cmd.name);
    expect(registered).toHaveLength(26);
    expect(new Set(registered).size).toBe(26);
  });

  it('files every command under the category its module owns, in category order', () => {
    const modules = {
      navigate: navigateCommands,
      crew: crewCommands,
      workflow: workflowCommands,
      view: viewCommands,
      io: ioCommands,
    } satisfies Record<CommandCategory, (ctx: RuntimeCommandContext) => RuntimeCommandDef[]>;

    for (const category of COMMAND_CATEGORIES) {
      for (const cmd of modules[category](makeCtx({}))) {
        expect(cmd.category, `${cmd.name} is defined in defs/${category}.ts`).toBe(category);
      }
    }

    expect(commands.map((cmd) => cmd.category)).toEqual(
      COMMAND_CATEGORIES.flatMap((category) => modules[category](makeCtx({})).map(() => category)),
    );
  });

  it('spells every argument set the way the palette and help rows read it', () => {
    for (const cmd of commands) {
      if (cmd.kind !== 'arg') continue;
      if (cmd.args.kind === 'free') {
        expect(cmd.args.hint.trim(), `${cmd.name} free-arg hint`).not.toBe('');
        continue;
      }
      const { options, optionDescriptions, optionHints } = cmd.args;
      expect(
        options.filter((option) => option.trim() === ''),
        `${cmd.name} options`,
      ).toEqual([]);
      expect(new Set(options).size, `${cmd.name} duplicate options`).toBe(options.length);
      expect(
        Object.keys(optionDescriptions ?? {}).filter((id) => !options.includes(id)),
        `${cmd.name} described options that are not offered`,
      ).toEqual([]);
      expect(
        Object.keys(optionHints ?? {}).filter((id) => !options.includes(id)),
        `${cmd.name} hinted options that are not offered`,
      ).toEqual([]);
    }
  });

  it('keeps the palette typeable but out of its own list', () => {
    const palette = commands.find((cmd) => cmd.name === '/palette');
    expect(palette?.hidden).toBe(true);
  });

  it('offers images only while the PLAN seat can receive them', () => {
    const image = commands.find((cmd) => cmd.name === '/image');

    expect(image?.guard?.({ phase: 'idle', plannerSupportsImages: false })).toBeTypeOf('string');
    expect(image?.guard?.({ phase: 'idle', plannerSupportsImages: true })).toBeUndefined();
  });

  it('offers no command under a name a release removed', () => {
    const names = commands.map((cmd) => cmd.name.toLowerCase());
    for (const removed of Object.keys(REMOVED_COMMANDS)) {
      expect(names).not.toContain(removed);
    }
  });
});

describe('/mode options', () => {
  function modeArgs(current: WorkflowMode) {
    const command = createRuntimeCommands(makeCtx({ getWorkflowMode: () => current })).find(
      (cmd) => cmd.name === '/mode',
    );
    if (command?.kind !== 'arg' || command.args.kind !== 'closed') {
      throw new Error('/mode is not a closed-argument command');
    }
    return command.args;
  }

  it('prices every mode from the pipeline spec, gate names spelled out', () => {
    const args = modeArgs('speckit');

    expect(args.options).toEqual([...WORKFLOW_MODES]);
    expect(args.optionDescriptions).toEqual(
      Object.fromEntries(
        WORKFLOW_MODES.map((mode) => [mode, describeModeCost(mode, { gateNames: true })]),
      ),
    );
  });

  it('marks the mode the config is on, and only that one', () => {
    expect(modeArgs('speckit').optionHints).toEqual({ speckit: 'current' });
    expect(modeArgs('quick').optionHints).toEqual({ quick: 'current' });
  });
});

const SKILL_OPTIONS = [
  { id: 'alpha', name: 'Alpha', description: 'Reviews alpha conventions', attached: false },
  { id: 'bravo', name: 'Bravo', description: '', attached: false },
] as const;

function skillsCommand(overrides: Parameters<typeof makeCtx>[0]) {
  const command = createRuntimeCommands(makeCtx(overrides)).find((cmd) => cmd.name === '/skills');
  if (command?.kind !== 'arg' || command.args.kind !== 'closed') {
    throw new Error('/skills is not a closed-argument command');
  }
  return { command, args: command.args };
}

describe('/skills command', () => {
  it('offers every available skill id as a closed option', () => {
    const { args } = skillsCommand({ listSkills: () => SKILL_OPTIONS });

    expect(args.options).toEqual(['alpha', 'bravo']);
    expect(args.optional).toBe(true);
  });

  it('spells the argument as a short grammar rather than every id', () => {
    const { args } = skillsCommand({ listSkills: () => SKILL_OPTIONS });

    expect(args.hint).toBe('<skill-id …>');
  });

  it('advertises no shortcut, since ctrl+s is bound on home alone', () => {
    const { command } = skillsCommand({ listSkills: () => SKILL_OPTIONS });

    expect(command.shortcut).toBeUndefined();
  });

  it('describes each skill option with its name and description', () => {
    const { args } = skillsCommand({ listSkills: () => SKILL_OPTIONS });

    expect(args.optionDescriptions).toEqual({
      alpha: 'Alpha — Reviews alpha conventions',
      bravo: 'Bravo',
    });
  });

  it('spells the name only when it differs from the id', () => {
    const { args } = skillsCommand({
      listSkills: () => [
        {
          id: 'agents-root',
          name: 'AGENTS.md',
          description: 'Root agent instructions',
          attached: false,
        },
        {
          id: 'charlie',
          name: 'charlie',
          description: 'Reviews charlie conventions',
          attached: false,
        },
        { id: 'delta', name: 'delta', description: '', attached: false },
      ],
    });

    expect(args.optionDescriptions).toEqual({
      'agents-root': 'AGENTS.md — Root agent instructions',
      charlie: 'Reviews charlie conventions',
      delta: '',
    });
  });

  it('marks only the skills already attached', () => {
    const { args } = skillsCommand({
      listSkills: () => [
        { id: 'alpha', name: 'Alpha', description: 'Reviews alpha conventions', attached: false },
        { id: 'bravo', name: 'Bravo', description: 'Drafts bravo notes', attached: true },
      ],
    });

    expect(args.optionHints).toEqual({ bravo: 'attached' });
  });

  it('opens the skills overlay after a rescan when invoked bare', async () => {
    const steps: string[] = [];
    const { command } = skillsCommand({
      listSkills: () => SKILL_OPTIONS,
      refreshSkills: async () => {
        steps.push('rescan');
      },
      openOverlay: (type) => steps.push(`open:${type}`),
    });

    await command.handler(undefined);

    expect(steps).toEqual(['rescan', 'open:skills']);
  });

  it('toggles a named skill and reports it', async () => {
    const messages: string[] = [];
    const toggled: string[] = [];
    const { command } = skillsCommand({
      listSkills: () => SKILL_OPTIONS,
      toggleSkill: (id) => {
        toggled.push(id);
        return { status: 'selected', name: 'Alpha' };
      },
      setFeedbackMessage: (msg) => messages.push(msg),
    });

    await command.handler('alpha');

    expect(toggled).toEqual(['alpha']);
    expect(messages).toEqual(['Attached: Alpha']);
  });

  it('toggles two skills from one invocation', async () => {
    const messages: string[] = [];
    const { command } = skillsCommand({
      listSkills: () => SKILL_OPTIONS,
      toggleSkill: (id) =>
        id === 'alpha'
          ? { status: 'selected', name: 'Alpha' }
          : { status: 'deselected', name: 'Bravo' },
      setFeedbackMessage: (msg) => messages.push(msg),
    });

    await command.handler('alpha bravo');

    expect(messages).toEqual(['Attached: Alpha; Detached: Bravo']);
  });

  it('names an unknown skill in the error feedback', async () => {
    const messages: string[] = [];
    const errors: string[] = [];
    const { command } = skillsCommand({
      listSkills: () => SKILL_OPTIONS,
      toggleSkill: (id) =>
        id === 'alpha' ? { status: 'selected', name: 'Alpha' } : { status: 'unknown' },
      setFeedbackMessage: (msg) => messages.push(msg),
      setFeedbackError: (msg) => errors.push(msg),
    });

    await command.handler('alpha charlie');

    expect(messages).toEqual(['Attached: Alpha']);
    expect(errors).toEqual(['Unknown skill: charlie']);
  });

  it('reports unavailability once instead of calling every skill unknown', async () => {
    const errors: string[] = [];
    const { command } = skillsCommand({
      listSkills: () => SKILL_OPTIONS,
      toggleSkill: () => ({ status: 'unavailable', message: 'Skills are unavailable here.' }),
      setFeedbackError: (msg) => errors.push(msg),
    });

    await command.handler('alpha bravo');

    expect(errors).toEqual(['Skills are unavailable here.']);
  });

  it('is available on every screen', async () => {
    const steps: string[] = [];
    const errors: string[] = [];
    const ctx = makeCtx({
      listSkills: () => SKILL_OPTIONS,
      refreshSkills: async () => {
        steps.push('rescan');
      },
      openOverlay: (type) => steps.push(`open:${type}`),
    });
    const commands = createRuntimeCommands(ctx);
    const skills = commands.find((cmd) => cmd.name === '/skills');

    expect(skills?.validScreens).toEqual(ALL_SCREENS);

    await runCommandInTest({
      commands,
      raw: '/skills',
      screen: 'workflow',
      onError: (msg) => errors.push(msg),
    });

    expect(errors).toEqual([]);
    expect(steps).toEqual(['rescan', 'open:skills']);
  });
});

describe('/settings command', () => {
  function openedBy(raw: string): Array<{ type: string; focus: string | undefined }> {
    const opened: Array<{ type: string; focus: string | undefined }> = [];
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type, focus) => {
          opened.push({ type, focus });
        },
      }),
    );
    runCommandInTest({ commands, raw, screen: 'home', onError: () => {} });
    return opened;
  }

  it('opens the overlay with no focus and takes no argument', () => {
    const settings = createRuntimeCommands(makeCtx({})).find((cmd) => cmd.name === '/settings');

    expect(settings?.kind).toBe('noarg');
    expect(openedBy('/settings')).toEqual([{ type: 'settings', focus: undefined }]);
  });
});
