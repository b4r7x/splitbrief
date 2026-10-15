import { createElement } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import type { Config } from '../../../core/schemas/config.js';
import { SETTINGS_DEFS, type SettingDef } from '../../../core/settings/catalog.js';
import { buildSettingsItems, type SettingsItem } from '../items.js';
import {
  hintFor,
  useSettingsEditor,
  type CrewSettingsItem,
  type FallbackSettingsItem,
} from './editor.js';

const CLI_PLANNER = {
  kind: 'cli',
  tool: 'claude-code',
} as const;

function crewItems(config: Config): SettingsItem[] {
  return buildSettingsItems({ config, defs: [], cliTools: [] });
}

function Harness(props: {
  config: Config;
  items: SettingsItem[];
  initialKey: string | undefined;
  activated: CrewSettingsItem[];
  activatedFallbacks?: FallbackSettingsItem[];
}) {
  const state = useSettingsEditor({
    config: props.config,
    items: props.items,
    initialKey: props.initialKey,
    initialFilter: undefined,
    onClose: () => undefined,
    onActivateCrew: (item) => {
      props.activated.push(item);
    },
    onActivateFallback: (item) => {
      props.activatedFallbacks?.push(item);
    },
    pageSize: 20,
    canActOnIndex: () => true,
  });
  return createElement(
    Text,
    null,
    `cursor=${state.filtered[state.effectiveIndex]?.key ?? ''} editing=${state.editingId ?? 'none'}`,
  );
}

let projectDir = '';

function seed(config: Config): void {
  configStore.__testReset({ projectDir, config });
}

describe('useSettingsEditor', () => {
  beforeEach(() => {
    resetAllStores();
    projectDir = createTempDir('settings-editor');
  });

  afterEach(() => {
    resetAllStores();
    cleanupTempDir(projectDir);
  });

  it('hands a crew row to the injected activation handler on Enter', async () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    seed(config);
    const items = crewItems(config);
    const activated: CrewSettingsItem[] = [];

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:build', activated }),
    );
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(activated).toEqual([items.find((item) => item.key === 'seat:build')]);
    ui.unmount();
  });

  it('hands a fallback row only to its activation handler on Enter without editing inline', async () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    seed(config);
    const items = crewItems(config);
    const activated: CrewSettingsItem[] = [];
    const activatedFallbacks: FallbackSettingsItem[] = [];
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, {
        config,
        items,
        initialKey: 'fallback:build',
        activated,
        activatedFallbacks,
      }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(20);
    expect(activatedFallbacks).toEqual([]);
    ui.stdin.write('\r');
    await tick(20);

    expect(activatedFallbacks).toEqual([items.find((item) => item.key === 'fallback:build')]);
    expect(activated).toEqual([]);
    expect(ui.lastFrame()).toContain('editing=none');
    expect(JSON.stringify(configStore.get().config)).toBe(before);
    ui.unmount();
  });

  it('leaves the config untouched when space lands on an inherited review seat', async () => {
    const config = makeConfig({ planner: { ...CLI_PLANNER, effort: 'high' } });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:review', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('says nothing when space lands on an api seat', async () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5-coder:7b',
      },
    });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('leaves a kilo seat untouched and silent on space', async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'kilo-code', model: 'openai/gpt-5.6' },
    });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('leaves an opencode seat alone when its provider offers no variants', async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode', model: 'opencode-go/gpt-5.6-luna' },
    });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('leaves a cursor seat untouched and silent on space', async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'cursor', model: 'gpt-5.6-luna-high' },
    });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('cycles the isolation row worktree → staged copy → your checkout and saves the YAML value', async () => {
    const config = makeConfig();
    seed(config);
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'workflow.isolation', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(configStore.get().config?.workflow.isolation).toBe('staged-copy');
    });
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(configStore.get().config?.workflow.isolation).toBe('none');
    });
    ui.unmount();
  });

  it('confirms each saved setting the way Setup and the picker do', async () => {
    const config = makeConfig();
    seed(config);
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });

    const ui = renderFeature(
      createElement(Harness, {
        config,
        items,
        initialKey: 'workflow.git.createBranch',
        activated: [],
      }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({
        message: 'Saved Create branch · on to .splitbrief/config.yaml',
        isError: false,
      });
    });
    ui.stdin.write('\u001b[B');
    await flushEffects();
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toBe(
        'Saved Isolation · staged copy to .splitbrief/config.yaml',
      );
    });
    ui.unmount();
  });

  it('leaves a claude-code seat untouched and silent across multiple space presses', async () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'seat:plan', activated: [] }),
    );
    await flushEffects();
    for (let i = 0; i < 4; i++) {
      ui.stdin.write(' ');
      await tick(10);
    }

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });
});

describe('hintFor', () => {
  const enumDef: SettingDef = {
    id: 'workflow.approve',
    label: 'Plan approval',
    section: 'Workflow',
    description: '',
    kind: 'enum',
    options: ['plan', 'none'],
  };

  it('advertises space rather than Enter on a row Enter cannot act on', () => {
    expect(hintFor({ kind: 'setting', def: enumDef, key: enumDef.id })).not.toContain('⏎');
  });

  it("cycles an enum and toggles a boolean, in each row's own word", () => {
    const booleanDef: SettingDef = {
      id: 'test.boolean',
      label: 'Boolean',
      section: 'Workflow',
      description: '',
      kind: 'boolean',
    };
    expect(hintFor({ kind: 'setting', def: enumDef, key: enumDef.id })).toBe('space cycle');
    expect(hintFor({ kind: 'setting', def: booleanDef, key: booleanDef.id })).toBe('space toggle');
  });

  it("advertises '⏎ edit' on a string or number setting row", () => {
    const stringDef: SettingDef = {
      id: 'test.string',
      label: 'String',
      section: 'Workflow',
      description: '',
      kind: 'string',
    };
    const numberDef: SettingDef = {
      id: 'test.number',
      label: 'Number',
      section: 'Workflow',
      description: '',
      kind: 'number',
    };
    expect(hintFor({ kind: 'setting', def: stringDef, key: stringDef.id })).toBe('⏎ edit');
    expect(hintFor({ kind: 'setting', def: numberDef, key: numberDef.id })).toBe('⏎ edit');
  });

  it('cycles the isolation row with space', () => {
    const isolation = SETTINGS_DEFS.find((def) => def.id === 'workflow.isolation');
    expect(isolation && hintFor({ kind: 'setting', def: isolation, key: isolation.id })).toBe(
      'space cycle',
    );
  });

  it("returns '⏎ change seat' on a seat row", () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    const seat = crewItems(config).find((item) => item.key === 'seat:plan');
    expect(seat && hintFor(seat)).toBe('⏎ change seat');
  });

  it("returns '⏎ change fallback' on a fallback row", () => {
    const fallback = crewItems(makeConfig()).find((item) => item.key === 'fallback:build');
    expect(fallback && hintFor(fallback)).toBe('⏎ change fallback');
  });
});
