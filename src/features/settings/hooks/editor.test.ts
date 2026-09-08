import { createElement } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import type { Config } from '../../../core/schemas/config.js';
import type { SettingDef } from '../../../core/settings/catalog.js';
import { buildSettingsItems, type SettingsItem } from '../items.js';
import { hintFor, useSettingsEditor, type CrewSettingsItem } from './editor.js';

const CLI_PLANNER = {
  kind: 'cli',
  tool: 'claude-code',
} as const;

function crewItems(config: Config): SettingsItem[] {
  return buildSettingsItems({ config, defs: [] });
}

function Harness(props: {
  config: Config;
  items: SettingsItem[];
  initialKey: string | undefined;
  activated: CrewSettingsItem[];
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
    pageSize: 20,
    canActOnIndex: () => true,
  });
  return createElement(Text, null, `cursor=${state.filtered[state.effectiveIndex]?.key ?? ''}`);
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
    id: 'workflow.mode',
    label: 'Mode',
    section: 'Workflow',
    description: '',
    kind: 'enum',
    options: ['quick', 'standard'],
  };

  it('advertises space rather than Enter on a row Enter cannot act on', () => {
    expect(hintFor({ kind: 'setting', def: enumDef, key: enumDef.id })).not.toContain('⏎');
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

  it("returns '⏎ change seat' on a seat row", () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    const seat = crewItems(config).find((item) => item.key === 'seat:plan');
    expect(seat && hintFor(seat)).toBe('⏎ change seat');
  });
});
