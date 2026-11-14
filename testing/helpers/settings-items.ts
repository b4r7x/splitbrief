import type { Config } from '../../src/core/schemas/config.js';
import { buildSettingsItems, type SettingsItem } from '../../src/features/settings/items.js';

export const CLI_PLANNER = {
  kind: 'cli',
  tool: 'claude-code',
} as const;

export function crewItems(config: Config): SettingsItem[] {
  return buildSettingsItems({ config, defs: [], cliTools: [] });
}
