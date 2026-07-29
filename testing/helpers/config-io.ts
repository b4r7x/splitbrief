import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { SPLITBRIEF_DIR } from '../../src/core/paths.js';

export function writeConfigYaml(projectDir: string, obj: Record<string, unknown>) {
  const dir = join(projectDir, SPLITBRIEF_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), YAML.stringify(obj), 'utf-8');
}

export function optionalSectionsYaml(): Record<string, unknown> {
  return {
    codebase: {
      enabled: true,
      token_budget: 1234,
      cache_dir: '.splitbrief-cache',
      include: ['src/**'],
      exclude: ['dist/**'],
    },
    hooks: {
      builtin: { snapshots: false },
    },
    otel: {
      enabled: true,
      service_name: 'splitbrief-test',
    },
    snapshots: {
      auto: {
        pre_task: true,
        post_task: false,
        pre_final_review: true,
      },
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
      headless: true,
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
