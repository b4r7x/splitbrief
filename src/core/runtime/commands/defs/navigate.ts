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
      description: 'Select planner skills',
      category: 'navigate',
      args: {
        kind: 'closed',
        options: skills.map((skill) => skill.id),
        optionDescriptions: Object.fromEntries(
          skills.map((skill) => [
            skill.id,
            skill.description ? `${skill.name} — ${skill.description}` : skill.name,
          ]),
        ),
        // A machine can hold hundreds of skills; spelling every id into a row would swamp the
        // palette description, which is also its fuzzy-match target.
        hint: '<skill-id …>',
        optional: true,
      },
      validScreens: ALL_SCREENS,
      handler: (args) => {
        const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? [];
        if (tokens.length === 0) {
          ctx.refreshSkills();
          ctx.openOverlay('skills');
          return;
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
        if (parts.length > 0) ctx.setFeedbackMessage(parts.join('; '));
        for (const message of unavailable) ctx.setFeedbackError(message);
        if (unknown.length > 0) {
          ctx.setFeedbackError(
            `Unknown ${pluralize(unknown.length, 'skill')}: ${unknown.join(', ')}`,
          );
        }
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
      description: 'Crew, validation, workflow',
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
      validScreens: ['workflow', 'summary'],
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
