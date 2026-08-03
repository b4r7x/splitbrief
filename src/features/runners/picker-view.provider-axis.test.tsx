import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import type { CliProviderAuthFact } from '../../core/discovery/detection.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelOption } from './model-catalog/recency.js';
import { PickerView } from './picker-view.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

vi.mock('../../engine/detection/store-publication.js', () => ({
  refreshDetectionForCurrentConfig: vi.fn(async () => ({})),
}));

const ENTER = '\r';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';

const KILO_FACTS: readonly CliProviderAuthFact[] = [
  { provider: 'GitHub Copilot', source: 'oauth' },
  { provider: 'Alibaba Coding Plan', source: 'api' },
];

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

const zeroCounts = { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 };

function cliTool(id: string, displayName: string, providerDependent: boolean): PickerOption {
  return {
    id,
    displayName,
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional', false),
    billing: 'provider-dependent',
    permissions: readyPermissions,
    status: { state: 'ready', remediation: null },
    available: true,
    ...(providerDependent ? { providerDependent: true } : {}),
  };
}

const KILO_MODELS: ModelOption[] = [
  { id: 'github-copilot/gpt-5.6', contextLength: 128_000, membership: 'confirmed' },
  { id: 'github-copilot/claude-opus-4.5', contextLength: 128_000, membership: 'confirmed' },
  { id: 'openrouter/gemini-3-flash', membership: 'confirmed' },
  { id: 'kilo/openrouter/free', membership: 'confirmed' },
];

function makeCatalog(tool: PickerOption, models: ModelOption[]): PickerCatalog {
  return {
    items: [tool],
    rightModels: models,
    currentItem: tool,
    selectedItemId: tool.id,
    initialLeftIdx: 0,
    focusModels: false,
    roleLabel: 'Planner',
    currentModel: undefined,
    persistedModel: undefined,
    discoveredModelCount: models.length,
    modelCounts: { ...zeroCounts, confirmed: models.length },
    catalogDiagnostic: undefined,
    currentCommand: undefined,
    currentCommandKind: undefined,
    customModels: [],
    discovery: { cold: false, refreshing: false },
    setCurrentItem: () => {},
  };
}

function makeActions(): PickerActions {
  return {
    confirm: () => {},
    confirmProviderVariant: async () => {},
    leftChange: () => {},
    deleteRight: () => {},
    chooseContract: () => {},
    customCommand: () => {},
    customModel: () => {},
    openCustomModel: () => {},
    openProviderAuth: () => {},
    submitProviderKey: async () => {},
    closeOverlay: () => {},
  };
}

function setKiloDetection(providerAuth?: readonly CliProviderAuthFact[]) {
  detectionStore.setDetection({
    providers: [],
    cliTools: [
      providerAuth === undefined
        ? cliDetectionFor('ready', 'kilo-code')
        : cliDetectionFor('ready', 'kilo-code', { providerAuth }),
    ],
  });
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('PickerView provider axis', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
  });

  it('keeps rows bare of per-provider tags and glyphs but surfaces stored credentials', async () => {
    setKiloDetection(KILO_FACTS);
    // The short display name keeps the bounded credential note inside the
    // preview's width budget; ordering itself is pinned in picker-format tests.
    const catalog = makeCatalog(cliTool('kilo-code', 'Kilo', true), KILO_MODELS);
    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = frameText(ui);
    const lines = frame.split('\n');
    const copilotLine = lines.find((line) => line.includes('GPT-5.6')) ?? '';
    expect(copilotLine).not.toContain('copilot');
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('○');
    // The Alibaba credential backs no enumerated model, so stored auth stays
    // visible as a count on the tool preview instead of vanishing.
    expect(frame).toContain('2 credentials stored');
    ui.unmount();
  });

  it('keeps a needs-signin model selectable and posts the remediation at confirm time', async () => {
    setKiloDetection(KILO_FACTS);
    const confirmed: Array<string | null> = [];
    const actions = makeActions();
    actions.confirm = (_selection, model) => {
      confirmed.push(model?.id ?? null);
    };
    const catalog = makeCatalog(cliTool('kilo-code', 'Kilo Code CLI', true), KILO_MODELS);
    const ui = renderFeature(<PickerView role="planner" catalog={catalog} actions={actions} />);
    await flushEffects();

    ui.stdin.write(RIGHT);
    await flushEffects();
    for (const key of [DOWN, DOWN]) {
      await flushEffects();
      ui.stdin.write(key);
      await flushEffects();
    }
    expect(frameText(ui)).toContain('openrouter needs sign-in · kilo auth login openrouter');

    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();
    expect(confirmed).toEqual(['openrouter/gemini-3-flash']);
    await vi.waitFor(() => {
      expect(feedbackStore.get().message).toBe(
        'Saved openrouter/gemini-3-flash · openrouter not signed in — run kilo auth login openrouter before start',
      );
    });
    ui.unmount();
  });

  it('speaks the gateway account vocabulary for the tool-gated free family', async () => {
    setKiloDetection(KILO_FACTS);
    const catalog = makeCatalog(cliTool('kilo-code', 'Kilo Code CLI', true), KILO_MODELS);
    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    ui.stdin.write(RIGHT);
    await flushEffects();
    for (const key of [DOWN, DOWN, DOWN]) {
      await flushEffects();
      ui.stdin.write(key);
      await flushEffects();
    }
    expect(frameText(ui)).toContain('requires a Kilo account: kilo auth login');
    ui.unmount();
  });

  it('claims nothing when the oracle could not be read and says how to retry', async () => {
    setKiloDetection(undefined);
    const catalog = makeCatalog(cliTool('kilo-code', 'Kilo Code CLI', true), KILO_MODELS);
    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    ui.stdin.write(RIGHT);
    await flushEffects();
    const frame = frameText(ui);
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('○');
    expect(frame).not.toContain('Auth required');
    expect(frame).toContain('auth state unknown — could not read kilo auth list · ctrl+r retry');
    ui.unmount();
  });

  it('renders every other tool byte-identical to today: no tags, no glyphs', async () => {
    setKiloDetection(KILO_FACTS);
    const catalog = makeCatalog(cliTool('codex', 'OpenAI Codex CLI', false), [
      { id: 'gpt-5.4', contextLength: 1_050_000, membership: 'confirmed' },
      { id: 'openai/gpt-5-codex', contextLength: 1_050_000, membership: 'confirmed' },
    ]);
    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    ui.stdin.write(RIGHT);
    await flushEffects();

    const frame = frameText(ui);
    expect(frame).not.toContain('●');
    expect(frame).not.toContain('○');
    expect(frame).not.toContain('@openai');
    expect(frame).not.toContain('⇥ pin provider');
    expect(frame).toContain('GPT-5.4');
    ui.unmount();
  });
});
