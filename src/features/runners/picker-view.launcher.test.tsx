import { beforeEach, describe, expect, it } from 'vitest';
import { pickerCatalog } from '#testing/helpers/runner-picker.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { PickerView } from './picker-view.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { PickerCatalog } from './use-picker-catalog.js';
import type { PickerActions } from './use-picker-actions.js';

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

const zeroCounts = { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 };

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
  };
}

const launcher: PickerOption = {
  ...cliTool('custom-command', 'Custom command'),
  kind: 'custom-command',
};

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

describe('PickerView launcher filtering', () => {
  beforeEach(() => {
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    overlayStore.reset();
  });

  it('typing while the cursor is on the launcher row filters the tools and keeps the launcher', async () => {
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const claudeTool = cliTool('claude-code', 'Claude Code');
    const catalog: PickerCatalog = pickerCatalog({
      items: [codexTool, claudeTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 2,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      modelCounts: zeroCounts,
      catalogDiagnostic: undefined,
      currentCommand: undefined,
      currentCommandKind: undefined,
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();
    expect(ui.lastFrame()).toContain('+ Add custom command…');

    for (const ch of 'cla') {
      await flushEffects();
      ui.stdin.write(ch);
      await flushEffects();
    }

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Claude Code');
    expect(frame).not.toContain('OpenAI Codex CLI');
    expect(frame).toContain('+ Add custom command…');
    ui.unmount();
  });

  it('states both contracts on the launcher card while the row keeps the command', async () => {
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 1,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      modelCounts: zeroCounts,
      catalogDiagnostic: undefined,
      currentCommand: 'my-tool --json',
      currentCommandKind: 'shell',
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('output · my-tool --json'); // launcher row: contract word first
    // The launcher is a terminal row now: the card states what each contract
    // does, so the truth is never competing with the command for one line.
    expect(frame).toContain('OUTPUT · reads stdout');
    expect(frame).toContain('DIRECT · writes files');
    ui.unmount();
  });

  it('keeps the contract truth visible at 60 cols when the configured command is long', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 40, isSmall: true });
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 1,
      focusModels: false,
      roleLabel: 'Planner',
      currentModel: undefined,
      persistedModel: undefined,
      modelCounts: zeroCounts,
      catalogDiagnostic: undefined,
      currentCommand: 'my-ai-tool --format stream-json',
      currentCommandKind: 'agent',
      customModels: [],
      discovery: { cold: false, refreshing: false },
      setCurrentItem: () => {},
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('DIRECT · writes files');
    ui.unmount();
  });
});
