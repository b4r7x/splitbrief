import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { SPLITBRIEF_DIR } from '../../src/core/paths.js';

export function writeConfigYamlText(projectDir: string, text: string) {
  const dir = join(projectDir, SPLITBRIEF_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), text, 'utf-8');
}

export function writeConfigYaml(projectDir: string, obj: Record<string, unknown>) {
  writeConfigYamlText(projectDir, YAML.stringify({ version: 3, ...obj }));
}

export function optionalSectionsYaml(): Record<string, unknown> {
  return {
    codebase: {
      enabled: true,
      token_budget: 1234,
      include: ['src/**'],
      exclude: ['dist/**'],
    },
    hooks: {
      pre_task: [{ command: './scripts/pre-task.sh' }],
    },
    palette: {
      custom_actions: [
        {
          id: 'refresh-docs',
          label: 'Refresh docs',
          description: 'Refresh documentation',
          command: '/refresh',
        },
      ],
    },
    approval: {
      enabled: true,
      tiers: {
        read: 'auto',
        write_in_scope: 'sticky',
        write_out_of_scope: 'confirm',
        destructive: 'confirm',
        package_change: 'confirm',
      },
      feed_rejections_to_planner: false,
    },
  };
}
