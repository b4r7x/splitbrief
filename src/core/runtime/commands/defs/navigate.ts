import { ALL_SCREENS } from '../../../navigation/types.js';
import { getShortcutKey } from '../../../keybindings/registry.js';
import { pluralize } from '../../../../utils/pluralize.js';
import type { RuntimeCommandDef, RuntimeCommandContext } from '../types.js';

export function navigateCommands(ctx: RuntimeCommandContext): RuntimeCommandDef[] {
  const skills = ctx.listSkills();
  return [
    {
      kind: 'noarg',
      name: '/help',
      label: 'help',
      description: 'Show help',
      shortcut: getShortcutKey('help'),
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('help'),
    },
    {
      kind: 'noarg',
      name: '/palette',
      label: 'palette',
      description: 'Open command palette',
      category: 'navigate',
      hidden: true,
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('command-palette'),
    },
    {
      kind: 'arg',
      name: '/skills',
      label: 'skills',
      description: 'Skills for every seat',
      category: 'navigate',
      args: {
        kind: 'closed',
        options: skills.map((skill) => skill.id),
        optionDescriptions: Object.fromEntries(
          skills.map((skill) => [
            skill.id,
            [skill.name === skill.id ? '' : skill.name, skill.description]
              .filter(Boolean)
              .join(' — '),
          ]),
        ),
        optionHints: Object.fromEntries(
          skills.filter((skill) => skill.attached).map((skill) => [skill.id, 'attached']),
        ),
        // A machine can hold hundreds of skills; spelling every id into a row would swamp the
        // palette description, which is also its fuzzy-match target.
        hint: '<skill-id …>',
        optional: true,
        multi: true,
        match: 'fuzzy',
      },
      validScreens: ALL_SCREENS,
      handler: async (args) => {
        await ctx.refreshSkills();
        const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? [];
        if (tokens.length === 0) {
          ctx.openOverlay('skills');
          return undefined;
        }
        const attached: string[] = [];
        const detached: string[] = [];
        const unknown: string[] = [];
        const unavailable = new Set<string>();
        for (const token of tokens) {
          const result = ctx.toggleSkill(token);
          if (result.status === 'selected') attached.push(result.name);
          else if (result.status === 'deselected') detached.push(result.name);
          else if (result.status === 'unavailable') unavailable.add(result.message);
          else unknown.push(token);
        }
        const parts: string[] = [];
        if (attached.length > 0) parts.push(`Attached: ${attached.join(', ')}`);
        if (detached.length > 0) parts.push(`Detached: ${detached.join(', ')}`);
        const failures = [...unavailable];
        if (unknown.length > 0) {
          failures.push(`Unknown ${pluralize(unknown.length, 'skill')}: ${unknown.join(', ')}`);
        }
        // A line that changed no skill is refused with its reason. A line that changed one ran.
        if (parts.length === 0) return failures.join(' ');
        ctx.setFeedbackMessage(parts.join('; '));
        for (const failure of failures) ctx.setFeedbackError(failure);
        return undefined;
      },
    },
    {
      kind: 'noarg',
      name: '/sessions',
      label: 'sessions',
      description: 'Browse past sessions',
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('sessions'),
    },
    {
      kind: 'noarg',
      name: '/settings',
      label: 'settings',
      description: 'Crew, fallback, validation, workflow',
      shortcut: getShortcutKey('settings'),
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.openOverlay('settings'),
    },
    {
      kind: 'noarg',
      name: '/home',
      label: 'home',
      description: 'Return to home screen',
      category: 'navigate',
      validScreens: ['workflow'],
      handler: () => ctx.navigate('home'),
    },
    {
      kind: 'noarg',
      name: '/quit',
      label: 'quit',
      description: 'Exit application',
      shortcut: getShortcutKey('quit'),
      category: 'navigate',
      validScreens: ALL_SCREENS,
      handler: () => ctx.quit(),
    },
  ];
}
