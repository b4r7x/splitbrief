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

const longCommand = './scripts/plan-with-a-really-long-name.sh --json';

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
    confirm: async () => {},
    confirmProviderSelection: async () => {},
    leftChange: () => {},
    deleteRight: async () => {},
    chooseContract: () => {},
    customCommand: async () => {},
    customModel: async () => {},
    openCustomModel: () => {},
    closeOverlay: () => {},
    browseCatalog: () => {},
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
      browseCatalog: false,
      items: [codexTool, claudeTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 2,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
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

  it('states both contracts in the launcher row vocabulary', async () => {
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 1,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Run your own command in the planner seat.');
    expect(frame).toContain('output · reads stdout');
    expect(frame).toContain('direct · writes files');
    expect(frame).toContain('⏎ picks the contract, then the command.');
    expect(frame).toContain('Nothing is saved until you confirm.');
    ui.unmount();
  });

  it('leads the pane with the command already configured for the seat', async () => {
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 1,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
      currentCommand: './scripts/plan.sh',
      currentCommandKind: 'shell',
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Current: ./scripts/plan.sh');
    expect(frame).toContain('output');
    ui.unmount();
  });

  it('omits the current-command line when the seat has no custom command', async () => {
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 1,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
      currentCommand: undefined,
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    expect(ui.lastFrame() ?? '').not.toContain('Current:');
    ui.unmount();
  });

  // The pane is a fixed-height card, so the copy has to survive the narrowest
  // width and the shortest height the picker renders at, and 100 cols is where the
  // card starts wrapping — the one width that can spend two rows on one sentence.
  it.each([
    { cols: 60, rows: 18 },
    { cols: 100, rows: 18 },
    { cols: 120, rows: 20 },
  ])('keeps the whole launcher card on screen at $cols x $rows', async ({ cols, rows }) => {
    terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 80 });
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 1,
      roleLabel: 'Implementer',
      modelCounts: zeroCounts,
      currentCommand: longCommand,
      currentCommandKind: 'agent',
    });

    const ui = renderFeature(
      <PickerView role="implementer" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('output · reads stdout');
    expect(frame).toContain('direct · writes files');
    // The last line of the card proves no row was dropped off the bottom.
    expect(frame).toContain('Nothing is saved');
    // The command is elided to what the card line has left, never wrapped onto a row.
    expect(frame).toContain('Current: ./scripts/pla');
    expect(frame).not.toContain(`Current: ${longCommand}`);
    ui.unmount();
  });
});
