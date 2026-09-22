import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { DetectedModel } from '../../core/discovery/detection.js';
import { readHostModelSelection } from './host-model-selection.js';

const ANTIGRAVITY_CATALOG: readonly DetectedModel[] = [
  { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-pro', displayName: 'Gemini 3.8 Pro' },
];

describe('readHostModelSelection', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = createTempDir('host-model');
    env = { HOME: home };
  });

  afterEach(() => {
    cleanupTempDir(home);
  });

  function write(relative: string, contents: string): string {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('prefers the opencode config file over the state file', async () => {
    const path = write('.config/opencode/opencode.json', '{"model":"anthropic/claude-opus-5"}');
    const recent = { recent: [{ providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }] };
    write('.local/state/opencode/model.json', JSON.stringify(recent));

    const selection = await readHostModelSelection('opencode', env);

    expect(selection).toEqual({ model: 'anthropic/claude-opus-5', source: path });
  });

  it('reads the last opencode selection from the state file', async () => {
    const state = {
      recent: [
        { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
        { providerID: 'anthropic', modelID: 'claude-opus-5' },
      ],
      variant: {},
    };
    const path = write('.local/state/opencode/model.json', JSON.stringify(state));

    const selection = await readHostModelSelection('opencode', env);

    expect(selection).toEqual({ model: 'opencode-go/deepseek-v4.1-flash', source: path });
  });

  it('reads a jsonc config without mistaking a schema URL for a comment', async () => {
    const jsonc = [
      '{',
      '  // written by the tool itself',
      '  "$schema": "https://opencode.ai/config.json",',
      '  /* the picker keeps this in sync */',
      '  "model": "opencode-go/deepseek-v4.1-flash"',
      '}',
    ].join('\n');
    const path = write('.config/opencode/opencode.jsonc', jsonc);

    const selection = await readHostModelSelection('opencode', env);

    expect(selection).toEqual({ model: 'opencode-go/deepseek-v4.1-flash', source: path });
  });

  it('reads kilo-code from its own state directory', async () => {
    const state = { recent: [{ providerID: 'kilo', modelID: 'kilo-fast' }] };
    const path = write('.local/state/kilo/model.json', JSON.stringify(state));

    const selection = await readHostModelSelection('kilo-code', env);

    expect(selection).toEqual({ model: 'kilo/kilo-fast', source: path });
  });

  it('honours XDG_CONFIG_HOME over the default config directory', async () => {
    const xdg = join(home, 'xdg-config');
    const path = join(xdg, 'opencode', 'opencode.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"model":"opencode-go/deepseek-v4.1-flash"}', 'utf8');

    const xdgEnv = { HOME: home, XDG_CONFIG_HOME: xdg };
    const selection = await readHostModelSelection('opencode', xdgEnv);

    expect(selection).toEqual({ model: 'opencode-go/deepseek-v4.1-flash', source: path });
  });

  it('reads the top-level codex model', async () => {
    const toml = ['# the tool writes this', 'model = "gpt-6-astra"', '', '[profiles.review]'];
    const path = write('.codex/config.toml', toml.join('\n'));

    const selection = await readHostModelSelection('codex', env);

    expect(selection).toEqual({ model: 'gpt-6-astra', source: path });
  });

  it('ignores a codex model that belongs to a section', async () => {
    write('.codex/config.toml', ['[profiles.review]', 'model = "gpt-6-astra"'].join('\n'));

    await expect(readHostModelSelection('codex', env)).resolves.toBeNull();
  });

  it('reads the claude-code settings model', async () => {
    const path = write('.claude/settings.json', '{"model":"claude-fable-5-1[1m]"}');

    const selection = await readHostModelSelection('claude-code', env);

    expect(selection).toEqual({ model: 'claude-fable-5-1[1m]', source: path });
  });

  it('resolves the antigravity display name through the detected catalog', async () => {
    const settings = '{"model":"Gemini 3.8 Flash (High)"}';
    const path = write('.gemini/antigravity-cli/settings.json', settings);

    const selection = await readHostModelSelection('antigravity', env, ANTIGRAVITY_CATALOG);

    expect(selection).toEqual({ model: 'gemini-3.8-flash-high', source: path });
  });

  it('returns null when the antigravity display name matches no catalog row', async () => {
    write('.gemini/antigravity-cli/settings.json', '{"model":"Gemini 4 Ultra"}');

    const selection = await readHostModelSelection('antigravity', env, ANTIGRAVITY_CATALOG);

    expect(selection).toBeNull();
  });

  it.each(['cursor', 'copilot', 'command-code'] as const)(
    'reads no selection for %s',
    async (tool) => {
      await expect(readHostModelSelection(tool, env)).resolves.toBeNull();
    },
  );

  it('returns null for a malformed selection file', async () => {
    write('.claude/settings.json', '{not json');

    await expect(readHostModelSelection('claude-code', env)).resolves.toBeNull();
  });

  it('returns null when nothing on the host names a model', async () => {
    await expect(readHostModelSelection('opencode', env)).resolves.toBeNull();
  });
});
