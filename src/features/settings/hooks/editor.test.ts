import { createElement } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../../stores/project/config.js';
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

function plannerEffort(): unknown {
  const planner = configStore.get().config?.planner;
  return planner && 'effort' in planner ? planner.effort : undefined;
}

function implementerVariant(): unknown {
  const implementer = configStore.get().config?.implementer;
  return implementer && 'variant' in implementer ? implementer.variant : undefined;
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

  it('cycles an editable effort row through every level and back to unset', async () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    seed(config);
    const items = crewItems(config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'effort:plan', activated: [] }),
    );
    await flushEffects();
    expect(plannerEffort()).toBeUndefined();

    const seen: unknown[] = [];
    for (let press = 0; press < 5; press++) {
      const previous = plannerEffort();
      ui.stdin.write(' ');
      for (let poll = 0; poll < 50 && plannerEffort() === previous; poll++) await tick(10);
      seen.push(plannerEffort());
    }

    expect(seen).toEqual(['low', 'medium', 'high', 'xhigh', undefined]);
    const planner = configStore.get().config?.planner;
    expect(planner && 'effort' in planner).toBe(false);
    ui.unmount();
  });

  it('leaves the config untouched when space lands on an inherited effort row', async () => {
    const config = makeConfig({ planner: { ...CLI_PLANNER, effort: 'high' } });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'effort:review', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    ui.unmount();
  });

  it('leaves the config untouched when space lands on an undeliverable effort row', async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex' },
    });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'effort:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    ui.unmount();
  });

  it("cycles an opencode build seat through its provider's verbatim variant ladder", async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6-luna' },
    });
    seed(config);
    const items = crewItems(config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'effort:build', activated: [] }),
    );
    await flushEffects();
    expect(implementerVariant()).toBeUndefined();

    const seen: unknown[] = [];
    for (let press = 0; press < 7; press++) {
      const previous = implementerVariant();
      ui.stdin.write(' ');
      for (let poll = 0; poll < 50 && implementerVariant() === previous; poll++) await tick(10);
      seen.push(implementerVariant());
    }

    expect(seen).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', undefined]);
    const implementer = configStore.get().config?.implementer;
    expect(implementer && 'variant' in implementer).toBe(false);
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
      createElement(Harness, { config, items, initialKey: 'effort:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    ui.unmount();
  });

  it("leaves a cursor seat's effort row read-only", async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'cursor', model: 'gpt-5.6-luna-high' },
    });
    seed(config);
    const items = crewItems(config);
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: 'effort:build', activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
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

  it('advertises Enter on a seat row', () => {
    const config = makeConfig({ planner: CLI_PLANNER });
    const seat = crewItems(config)[0];
    expect(seat && hintFor(seat)).toContain('⏎');
  });

  function buildEffortHint(config: Config): string {
    const row = crewItems(config).find((item) => item.key === 'effort:build');
    if (row === undefined) throw new Error('no build effort row');
    return hintFor(row);
  }

  // Space is inert wherever the provider spells no presets, so the row must not
  // promise it: the cycle stops at the vocabulary, not at the channel.
  it('promises no cycle on a variant seat whose provider spells no presets', () => {
    expect(
      buildEffortHint(makeConfig({ implementer: { kind: 'cli', tool: 'opencode' } })),
    ).not.toContain('space cycle');
    expect(
      buildEffortHint(
        makeConfig({
          implementer: { kind: 'cli', tool: 'opencode', model: 'opencode-go/gpt-5.6-luna' },
        }),
      ),
    ).not.toContain('space cycle');
  });

  it('promises the cycle on a variant seat whose provider spells presets', () => {
    expect(
      buildEffortHint(
        makeConfig({
          implementer: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6-luna' },
        }),
      ),
    ).toContain('space cycle');
  });
});
