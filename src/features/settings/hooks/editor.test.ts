import { createElement } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  CHECKING_TOOLS_STAGE,
  preparationStore,
  type PreparationOrigin,
} from '../../../stores/navigation/preparation.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { markCancellationRequested } from '../../../stores/workflow/actions/interrupt.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore } from '../../../stores/workflow/stop.js';
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
  showDescription?: boolean;
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
    showDescription: props.showDescription ?? true,
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

  it.each(['validation.endChecks', 'workflow.review'])(
    'a locked row does not toggle: %s',
    async (lockedKey) => {
      const config = makeConfig({
        reviewer: 'none',
        validation: { endChecks: false },
        workflow: { review: 'task' },
      });
      seed(config);
      const defs = SETTINGS_DEFS.filter(
        (def) => def.id === lockedKey || def.id === 'workflow.isolation',
      );
      expect(defs.map((def) => def.id)).toContain(lockedKey);
      const items = buildSettingsItems({ config, defs, cliTools: [] });
      const lockedAt = items.findIndex((item) => item.key === lockedKey);
      const isolationAt = items.findIndex((item) => item.key === 'workflow.isolation');

      const ui = renderFeature(
        createElement(Harness, { config, items, initialKey: lockedKey, activated: [] }),
      );
      await flushEffects();
      ui.stdin.write(' ');
      ui.stdin.write(isolationAt > lockedAt ? '\u001b[B' : '\u001b[A');
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('cursor=workflow.isolation');
      });
      // Saves run in key order, so a save of the locked row lands before this one.
      ui.stdin.write(' ');
      await vi.waitFor(() => {
        expect(configStore.get().config?.workflow.isolation).toBe('staged-copy');
      });

      expect(configStore.get().config?.validation.endChecks).toBe(false);
      expect(configStore.get().config?.workflow.review).toBe('task');
      expect(configStore.get().config?.reviewer).toBe('none');
      ui.unmount();
    },
  );

  it('keeps a locked row and its value with no notice while the help shows the reason', async () => {
    const config = makeConfig({ reviewer: 'none', validation: { endChecks: true } });
    seed(config);
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });
    const before = JSON.stringify(configStore.get().config);

    const ui = renderFeature(
      createElement(Harness, {
        config,
        items,
        initialKey: 'validation.endChecks',
        activated: [],
        showDescription: true,
      }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    ui.stdin.write('\r');
    await tick(30);

    expect(JSON.stringify(configStore.get().config)).toBe(before);
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('names the reason in a notice while the help is hidden and keeps the value', async () => {
    const config = makeConfig({ reviewer: 'none', validation: { endChecks: true } });
    seed(config);
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });
    const before = JSON.stringify(configStore.get().config);
    const reason = 'Read-only while REVIEW is None: no review runs.';

    const ui = renderFeature(
      createElement(Harness, {
        config,
        items,
        initialKey: 'validation.endChecks',
        activated: [],
        showDescription: false,
      }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({ message: reason, isError: true });
    });
    ui.stdin.write('\r');
    await tick(30);

    expect(feedbackStore.get()).toEqual({ message: reason, isError: true });
    expect(JSON.stringify(configStore.get().config)).toBe(before);
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
        initialKey: 'workflow.compactionFormat',
        activated: [],
      }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(feedbackStore.get()).toEqual({
        message:
          'Saved Compaction format · freeform to .splitbrief/config.yaml · Added .splitbrief/ to .gitignore',
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

  const END_CHECKS_KEY = 'validation.endChecks';
  const TIMING_LINE = 'End-of-run checks · off applies at the next run or Resume';
  const SAVED_LINE = 'Saved End-of-run checks · off to .splitbrief/config.yaml';

  function openLocalRoute(config: Config): void {
    const prepared = makePreparedExecution({
      projectDir,
      sessionId: 'sess-settings-save',
      feature: 'settings save',
      config,
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: prepared.session.ref }),
      execution: { kind: 'local', prepared },
    });
  }

  function checkTools(origin: PreparationOrigin): void {
    preparationStore.submit({
      origin,
      stage: CHECKING_TOOLS_STAGE,
      prepare: () => new Promise(() => {}),
      onPrepared: () => {},
    });
  }

  /** The config document exists before the measured save, so the ignore rule is already added. */
  async function seedSavedConfig(config: Config): Promise<Config> {
    configStore.__testReset({ projectDir, config });
    await configStore.save(config);
    feedbackStore.reset();
    return configStore.get().config ?? config;
  }

  async function toggleEndChecks(config: Config, message: string): Promise<void> {
    const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, cliTools: [] });
    const ui = renderFeature(
      createElement(Harness, { config, items, initialKey: END_CHECKS_KEY, activated: [] }),
    );
    await flushEffects();
    ui.stdin.write(' ');
    await vi.waitFor(() => {
      expect(feedbackStore.get().message).not.toBeNull();
    });
    expect(feedbackStore.get()).toEqual({ message, isError: false });
    ui.unmount();
  }

  const timingStates: ReadonlyArray<readonly [string, () => void]> = [
    [
      'running',
      () => {
        lifecycleStore.__testReset({ status: 'running' });
      },
    ],
    [
      'paused',
      () => {
        lifecycleStore.__testReset({ status: 'paused' });
      },
    ],
    [
      'halted',
      () => {
        lifecycleStore.__testReset({ status: 'running' });
        runViewStore.__testReset({
          halt: { issue: makeRecoveryIssue(), at: { kind: 'review', cycle: 0 } },
        });
      },
    ],
  ];

  it.each(timingStates)(
    'says when the setting applies while the run is %s',
    async (_state, setRow) => {
      const config = makeConfig();
      seed(config);
      openLocalRoute(config);
      setRow();

      await toggleEndChecks(config, TIMING_LINE);
    },
  );

  const savedLineStates: ReadonlyArray<readonly [string, (config: Config) => void]> = [
    [
      'the run is complete',
      (config) => {
        openLocalRoute(config);
        lifecycleStore.__testReset({ status: 'complete' });
      },
    ],
    [
      'a stop ended the run',
      (config) => {
        openLocalRoute(config);
        lifecycleStore.__testReset({ status: 'cancelled' });
        stopStore.end();
      },
    ],
    ['the route is home', () => routerStore.init({ screen: 'home' })],
    [
      'End run is requested at a halt',
      (config) => {
        openLocalRoute(config);
        lifecycleStore.__testReset({ status: 'running' });
        runViewStore.__testReset({
          halt: { issue: makeRecoveryIssue(), at: { kind: 'review', cycle: 0 } },
        });
        stopStore.request('end-run');
        markCancellationRequested();
      },
    ],
  ];

  it.each(savedLineStates)('keeps the saved line when %s', async (_state, setRow) => {
    const config = await seedSavedConfig(makeConfig());
    setRow(config);

    await toggleEndChecks(config, SAVED_LINE);
  });

  it('says a setting saved during a stopped call applies at the next run or Resume', async () => {
    const config = makeConfig();
    seed(config);
    openLocalRoute(config);
    lifecycleStore.__testReset({ status: 'paused' });
    stopStore.request('stop-now');
    stopStore.park('mid-brief', 'T001', () => {});

    await toggleEndChecks(config, TIMING_LINE);
  });

  const checkStates: ReadonlyArray<readonly [string, () => void]> = [
    [
      'a start on the home route',
      () => {
        routerStore.init({ screen: 'home' });
        checkTools('start');
      },
    ],
    [
      'a Resume of the run at rest',
      () => {
        routerStore.init({
          screen: 'workflow',
          run: makeRunRecord(),
          execution: { kind: 'at-rest' },
        });
        checkTools('continue');
      },
    ],
  ];

  it.each(checkStates)(
    'says when the setting applies while %s checks its tools',
    async (_state, setRow) => {
      const config = makeConfig();
      seed(config);
      setRow();

      await toggleEndChecks(config, TIMING_LINE);
    },
  );
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
