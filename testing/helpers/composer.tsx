import { Box } from 'ink';
import type { ComponentProps } from 'react';
import { Composer } from '../../src/components/composer/composer.js';
import type { RuntimeCommandDef } from '../../src/core/runtime/commands/types.js';
import { renderFeature } from '#testing/helpers/ink.js';

export const COMMANDS: RuntimeCommandDef[] = [
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
    name: '/mode',
    label: 'Mode',
    description: 'Workflow mode',
    category: 'navigate',
    args: { kind: 'free', hint: '<text>' },
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/settings',
    label: 'Settings',
    description: 'Open settings',
    category: 'navigate',
    validScreens: ['home'],
    handler: () => {},
  },
];

export function renderDockedComposer(props: ComponentProps<typeof Composer>) {
  return renderFeature(
    <Box flexDirection="column" height={20} justifyContent="flex-end">
      <Composer {...props} />
    </Box>,
  );
}
