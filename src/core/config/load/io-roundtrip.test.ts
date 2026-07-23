import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { configPath, createDefaultConfig, loadConfig, writeConfig } from './io.js';
import { DIPTYCH_DIR } from '../../paths.js';
import { optionalSectionsYaml, writeConfigYaml } from '#testing/helpers/config-io.js';

const TMP = join(import.meta.dirname, '.tmp-config-io-roundtrip');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('config roundtrip', () => {
  describe('loadConfig', () => {
    it('writes a default config that loadConfig reads back to the same shape', () => {
      const dir = join(TMP, 'default-roundtrip');
      mkdirSync(dir, { recursive: true });
      writeConfig(dir, createDefaultConfig());

      expect(existsSync(configPath(dir))).toBe(true);

      const { config, warnings } = loadConfig(dir);
      expect(warnings).toEqual([]);
      expect(config).toEqual(createDefaultConfig());
    });

    it('writes loaded optional top-level sections back to YAML', () => {
      const dir = join(TMP, 'optional-sections-write');
      writeConfigYaml(dir, {
        implementer: { model: 'codellama:13b' },
        ...optionalSectionsYaml(),
      });

      const { config } = loadConfig(dir);
      writeConfig(dir, config);

      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.codebase).toBeDefined();
      expect(written.hooks).toBeDefined();
      expect(written.otel).toBeDefined();
      expect(written.snapshots).toBeDefined();
      expect(written.palette).toBeDefined();
      expect(written.approval).toBeDefined();
      expect((written.palette as Record<string, unknown>).custom_actions).toBeDefined();
      const approval = written.approval as Record<string, unknown>;
      const tiers = approval.tiers as Record<string, unknown>;
      expect(tiers.write_in_scope).toBe('sticky');
      expect(tiers.write_out_of_scope).toBe('confirm');
      expect(tiers.package_change).toBe('confirm');
      expect(tiers.writeInScope).toBeUndefined();
    });

    it('loads and writes implementer profiles without changing the legacy implementer', () => {
      const dir = join(TMP, 'implementer-profiles');
      writeConfigYaml(dir, {
        implementer: { model: 'legacy-local' },
        implementer_profiles: {
          default: 'local-qwen',
          profiles: {
            'local-qwen': {
              kind: 'api',
              provider: 'ollama',
              api_base: 'http://localhost:11434/v1',
              model: 'qwen2.5-coder:7b',
              context_length: 32768,
              cost_tier: 'local',
            },
            'agent-cli': {
              kind: 'cli',
              tool: 'codex',
              model: 'gpt-5.4-mini',
              context_length: 200000,
              label: 'Codex CLI',
              cost_tier: 'standard',
            },
          },
        },
      });

      const { config } = loadConfig(dir);
      expect(config.implementer.model).toBe('legacy-local');
      expect(config.implementerProfiles?.default).toBe('local-qwen');
      expect(config.implementerProfiles?.profiles['agent-cli']?.label).toBe('Codex CLI');

      writeConfig(dir, config);
      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.implementer_profiles).toBeDefined();
      const profiles = written.implementer_profiles as Record<string, unknown>;
      expect(profiles.default).toBe('local-qwen');
      expect(profiles.profiles).toBeDefined();
    });

    it('converts snake_case keys to camelCase and migrates commitPerTask', () => {
      const dir = join(TMP, 'snake-case');
      writeConfigYaml(dir, {
        planner_estimate_review: true,
        auto_split_overflow: true,
        workflow: { max_retries: 5, commit_per_task: false },
      });

      const { config } = loadConfig(dir);
      expect(config.plannerEstimateReview).toBe(true);
      expect(config.autoSplitOverflow).toBe(true);
      expect(config.workflow.maxRetries).toBe(5);
      expect(config.workflow.commitStrategy).toBe('none');

      writeConfig(dir, config);
      const written = YAML.parse(
        readFileSync(join(dir, DIPTYCH_DIR, 'config.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(written.planner_estimate_review).toBe(true);
      expect(written.auto_split_overflow).toBe(true);
    });
  });
});
