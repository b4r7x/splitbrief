import { describe, it, expect } from 'vitest';
import { ATTACHED_AVAILABLE_COMMANDS, createRuntimeCommands } from './registry.js';
import { ALL_SCREENS } from '../../navigation/types.js';
import {
  COMMAND_CATEGORIES,
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

const ATTACHED_LOCAL_ONLY = [
  '/skills',
  '/settings',
  '/mode',
  '/crew',
  '/refresh',
  '/revise-spec',
  '/revise-plan',
  '/redo-task',
  '/handoff',
  '/export',
  '/compact-transcript',
  '/image',
  '/approval',
  '/run',
  '/yolo',
  '/diff',
  '/cost',
] as const;

// Registry order: categories concatenated as COMMAND_CATEGORIES lists them.
const ATTACHED_AVAILABLE = [
  '/help',
  '/palette',
  '/sessions',
  '/home',
  '/quit',
  '/queue',
  '/scroll',
  '/activity',
  '/sidebar',
  '/copy',
] as const;

function names(ctxOverrides: Parameters<typeof makeCtx>[0]): string[] {
  return createRuntimeCommands(makeCtx(ctxOverrides)).map((cmd) => cmd.name);
}

describe('createRuntimeCommands attached-client gating', () => {
  it('exposes local-only workflow mutation commands for in-process clients', () => {
    const exposed = names({ isAttached: false });
    for (const name of ATTACHED_LOCAL_ONLY) {
      expect(exposed).toContain(name);
    }
  });

  it('hides local-only and config-mutating commands from attached clients', () => {
    const exposed = names({ isAttached: true });
    for (const name of ATTACHED_LOCAL_ONLY) {
      expect(exposed).not.toContain(name);
    }
  });

  it('keeps server-safe commands available for attached clients', () => {
    const exposed = names({ isAttached: true });
    expect(exposed).toEqual([...ATTACHED_AVAILABLE]);
  });
});

describe('createRuntimeCommands registry shape', () => {
  const commands = createRuntimeCommands(makeCtx({}));

  it('registers the commands the reference documents, once each', () => {
    const registered = commands.map((cmd) => cmd.name);
    expect(registered).toHaveLength(27);
    expect(new Set(registered).size).toBe(27);
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
      const { options, optionDescriptions } = cmd.args;
      expect(
        options.filter((option) => option.trim() === ''),
        `${cmd.name} options`,
      ).toEqual([]);
      expect(new Set(options).size, `${cmd.name} duplicate options`).toBe(options.length);
      expect(
        Object.keys(optionDescriptions ?? {}).filter((id) => !options.includes(id)),
        `${cmd.name} described options that are not offered`,
      ).toEqual([]);
    }
  });

  it('keeps the palette typeable but out of its own list', () => {
    const palette = commands.find((cmd) => cmd.name === '/palette');
    expect(palette?.hidden).toBe(true);
  });

  it('offers images only while the PLAN seat can receive them', () => {
    const image = commands.find((cmd) => cmd.name === '/image');

    expect(
      image?.guard?.({ phase: 'idle', attached: false, plannerSupportsImages: false }),
    ).toBeTypeOf('string');
    expect(
      image?.guard?.({ phase: 'idle', attached: false, plannerSupportsImages: true }),
    ).toBeUndefined();
  });

  it('offers no /attach or /detach alias on the image command', () => {
    const image = commands.find((cmd) => cmd.name === '/image');
    expect(image?.aliases ?? []).toHaveLength(0);

    const aliasNames = commands.flatMap((cmd) => cmd.aliases?.map((alias) => alias.name) ?? []);
    expect(aliasNames).not.toContain('/attach');
    expect(aliasNames).not.toContain('/detach');
  });

  it('offers attached clients only names the registry still knows', () => {
    const registered = new Set(commands.map((cmd) => cmd.name));
    for (const name of ATTACHED_AVAILABLE_COMMANDS) {
      expect(registered).toContain(name);
    }
  });
});

const SKILL_OPTIONS = [
  { id: 'alpha', name: 'Alpha', description: 'Reviews alpha conventions' },
  { id: 'bravo', name: 'Bravo', description: '' },
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

  it('opens the skills overlay after a rescan when invoked bare', async () => {
    const steps: string[] = [];
    const { command } = skillsCommand({
      listSkills: () => SKILL_OPTIONS,
      refreshSkills: () => steps.push('rescan'),
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
      refreshSkills: () => steps.push('rescan'),
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
