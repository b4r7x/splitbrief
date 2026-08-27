import { beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { inheritPlannerOption, type PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelVariant } from './model-catalog/recency.js';
import type { RightRow } from './model-catalog/rows.js';
import { PickerView } from './picker-view.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

const RIGHT = '\u001B[C';

const zeroCounts = { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 };

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

function cliTool(id: string, displayName: string): PickerOption {
  return {
    id,
    displayName,
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional', false),
    billing: 'subscription-included',
    permissions: readyPermissions,
    status: { state: 'ready', remediation: null },
    available: true,
    providerDependent: true,
  };
}

function makeCatalog(input: {
  items: PickerOption[];
  currentItem: PickerOption;
  rightRows?: RightRow[];
  roleLabel?: string;
  hasOracle?: boolean;
}): PickerCatalog {
  return {
    items: input.items,
    rightRows: input.rightRows ?? [],
    currentItem: input.currentItem,
    selectedItemId: input.currentItem.id,
    initialLeftIdx: 0,
    initialRightIndex: 0,
    resolveRightIndex: () => 0,
    focusModels: false,
    roleLabel: input.roleLabel ?? 'Reviewer',
    plannerIdentity: 'Claude Code CLI · Claude Sonnet 4',
    currentModel: undefined,
    persistedModel: undefined,
    modelCounts: zeroCounts,
    catalogDiagnostic: undefined,
    catalogLane: 'ready',
    providerAuth: { kind: 'read', facts: [] },
    hasOracle: input.hasOracle ?? false,
    currentCommand: undefined,
    currentCommandKind: undefined,
    customModels: [],
    discovery: { cold: false, refreshing: false },
    setCurrentItem: () => {},
  };
}

function makeActions(): PickerActions {
  return {
    confirm: async () => {},
    confirmProviderVariant: async () => {},
    leftChange: () => {},
    deleteRight: async () => {},
    chooseContract: () => {},
    customCommand: async () => {},
    customModel: async () => {},
    openCustomModel: () => {},
    openProviderAuth: () => {},
    submitProviderKey: async () => {},
    closeOverlay: () => {},
  };
}

function frameText(ui: ReturnType<typeof renderFeature>): string {
  return stripAnsiStyles(ui.lastFrame() ?? '');
}

describe('PickerView terminal panes', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } }),
    });
    detectionStore.setDetection({
      providers: [],
      cliTools: [cliDetectionFor('ready', 'claude-code')],
    });
  });

  it('answers the inherit row with the planner it will actually run', async () => {
    // The card's posture line is a frame row, so the planner it borrows from is
    // the real catalog option, not a fixture that could disagree with it.
    const planner = realPickerOption('planner', 'claude-code');
    const inherit = inheritPlannerOption({ planner, isCurrent: true });
    const ui = renderFeature(
      <PickerView
        role="reviewer"
        catalog={makeCatalog({ items: [inherit, planner], currentItem: inherit })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    const frame = frameText(ui);

    expect(frame).toContain("Planner's setup");
    expect(frame).toContain('Claude Code CLI · Claude Sonnet 4');
    expect(frame).toContain('subscription · Network · Shell');
    const hintRow = frame.split('\n').find((row) => row.includes('↑↓ select')) ?? '';
    expect(hintRow.trim().startsWith('↑↓ select')).toBe(true);
    expect(hintRow).toContain("use planner's setup");
    ui.unmount();
  });

  it('confirms the sole configured route of a two-route model without expanding', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variants: ModelVariant[] = [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model = { id: 'gpt-5.6', variants };
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    const catalog = makeCatalog({
      items: [kilo],
      currentItem: kilo,
      rightRows: [{ kind: 'model', model, provenance: 'Detected', section: '', expanded: false }],
      roleLabel: 'Planner',
      hasOracle: true,
    });
    // Only `openai` has a credential, so exactly one of the two routes is usable.
    catalog.providerAuth = { kind: 'read', facts: [{ provider: 'openai', source: 'oauth' }] };
    const ui = renderFeature(<PickerView role="planner" catalog={catalog} actions={actions} />);
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(confirmed).toEqual(['openai/gpt-5.6']);
    expect(pickerViewStore.get().expandedModelId).toBeNull();
    ui.unmount();
  });

  it('expands a two-route model when no route is configured', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variants: ModelVariant[] = [
      { fullId: 'openai/gpt-5.6', providerPrefix: 'openai', tag: 'openai' },
      { fullId: 'opencode-go/gpt-5.6', providerPrefix: 'opencode-go', tag: 'opencode-go' },
    ];
    const model = { id: 'gpt-5.6', variants };
    const confirmed: string[] = [];
    const actions = makeActions();
    actions.confirmProviderVariant = async (fullId: string) => {
      confirmed.push(fullId);
    };
    const ui = renderFeature(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [kilo],
          currentItem: kilo,
          rightRows: [
            { kind: 'model', model, provenance: 'Detected', section: '', expanded: false },
          ],
          roleLabel: 'Planner',
          hasOracle: true,
        })}
        actions={actions}
      />,
    );
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(pickerViewStore.get().expandedModelId).toBe('gpt-5.6');
    expect(confirmed).toEqual([]);
    ui.unmount();
  });

  it('leads the preview with the command that unblocks an unsigned route', async () => {
    const kilo = cliTool('kilo-code', 'Kilo Code CLI');
    const variant: ModelVariant = {
      fullId: 'openrouter/gemini-3-flash',
      providerPrefix: 'openrouter',
      tag: 'openrouter',
    };
    const model = { id: 'openrouter/gemini-3-flash', variants: [variant] };
    const rows: RightRow[] = [
      { kind: 'model', model, provenance: 'Detected', section: '', expanded: true },
      { kind: 'route', model, variant, tagWidth: 10, auth: { kind: 'needs-sign-in' } },
    ];
    const ui = renderFeature(
      <PickerView
        role="planner"
        catalog={makeCatalog({
          items: [kilo],
          currentItem: kilo,
          rightRows: rows,
          roleLabel: 'Planner',
          hasOracle: true,
        })}
        actions={makeActions()}
      />,
    );
    await flushEffects();
    ui.stdin.write(RIGHT);
    await flushEffects();

    expect(frameText(ui)).toContain('sign in: kilo auth login openrouter');
    ui.unmount();
  });
});
