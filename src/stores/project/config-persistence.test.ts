import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import { writeConfig } from '../../core/config/load/io.js';
import { configStore } from './config.js';
import { editsForSave, persistedConfigForSave } from './config-persistence.js';

describe('config persistence', () => {
  afterEach(() => configStore.__testReset());

  it.each([
    { existingConfig: true, existingIgnore: true },
    { existingConfig: false, existingIgnore: true },
    { existingConfig: true, existingIgnore: false },
    { existingConfig: false, existingIgnore: false },
  ])('only a creating save adds the ignore rule', async ({ existingConfig, existingIgnore }) => {
    await withTempDir('settings-ignore', async (projectDir) => {
      const config = createDefaultConfig();
      if (existingConfig) writeConfig(projectDir, config);
      const ignorePath = join(projectDir, '.gitignore');
      if (existingIgnore) writeFileSync(ignorePath, 'node_modules/\n');
      configStore.load(projectDir);

      const result = await configStore.save({
        ...config,
        workflow: { ...config.workflow, approve: 'none' },
      });

      expect(result).toMatchObject({ kind: 'saved', ignoreRuleAdded: !existingConfig });
      if (!existingConfig) {
        expect(readFileSync(ignorePath, 'utf8')).toBe(
          existingIgnore ? 'node_modules/\n.splitbrief/\n' : '.splitbrief/\n',
        );
      } else if (existingIgnore) {
        expect(readFileSync(ignorePath, 'utf8')).toBe('node_modules/\n');
      } else {
        expect(existsSync(ignorePath)).toBe(false);
      }
    });
  });

  it('keeps an unchanged effective override out of the persisted config', () => {
    const persisted = createDefaultConfig();
    const effective = {
      ...persisted,
      implementer: { ...persisted.implementer, model: 'one-shot-override' },
    };

    const result = persistedConfigForSave({
      persisted,
      effective,
      updated: { ...effective, approval: { feedRejectionsToPlanner: false } },
    });

    expect(result.approval?.feedRejectionsToPlanner).toBe(false);
    expect(result.implementer.model).toBe(persisted.implementer.model);
  });

  it('derives snake-case path edits and deletions without unchanged siblings', () => {
    const before = {
      ...createDefaultConfig(),
      implementer: {
        kind: 'api' as const,
        provider: 'ollama',
        service: 'ollama',
        offering: 'local' as const,
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen3-coder:30b',
        contextLength: 32768,
      },
    };
    const after = {
      ...before,
      implementer: {
        kind: 'cli' as const,
        tool: 'codex' as const,
        model: 'gpt-5.4-mini',
      },
    };

    const rawYaml = `implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  api_base: http://localhost:11434/v1
  model: qwen3-coder:30b
  context_length: 32768
`;
    expect(editsForSave(before, after, rawYaml)).toEqual(
      expect.arrayContaining([
        { path: ['implementer', 'kind'], value: 'cli' },
        { path: ['implementer', 'tool'], value: 'codex' },
        { path: ['implementer', 'api_base'], value: undefined },
        { path: ['implementer', 'context_length'], value: undefined },
      ]),
    );
  });
});
