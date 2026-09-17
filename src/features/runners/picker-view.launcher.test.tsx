import { beforeEach, describe, expect, it } from 'vitest';
import { pickerCatalog } from '#testing/helpers/runner-picker.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { PickerView } from './picker-view.js';
import { CUSTOM_COMMAND_PANE_LINES } from './picker-format.js';
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

/** Every line the card promises, minus the two blanks that carry no words. */
const PANE_SENTENCES = CUSTOM_COMMAND_PANE_LINES.filter((line) => line !== '');

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

function makeActions(log?: string[]): PickerActions {
  const record = (name: string) => log?.push(name);
  return {
    confirm: async (selection, model) => {
      record(`confirm:${selection.id}:${model?.id ?? 'null'}`);
    },
    confirmProviderSelection: async () => {
      record('confirmProviderSelection');
    },
    confirmAuthMethod: async () => {
      record('confirmAuthMethod');
    },
    leftChange: () => {},
    deleteRight: async () => {
      record('deleteRight');
    },
    chooseContract: () => {
      record('chooseContract');
    },
    customCommand: async () => {
      record('customCommand');
    },
    customModel: async () => {
      record('customModel');
    },
    openCustomModel: () => {
      record('openCustomModel');
    },
    closeOverlay: () => {},
    browseCatalog: () => {
      record('browseCatalog');
    },
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

  it('states the action, both contracts, both steps and the save rule', async () => {
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
    for (const line of PANE_SENTENCES) expect(frame).toContain(line);
    // The seat is the picker's title, not a second line inside the card.
    expect(frame).toContain('PLAN · tool, model, effort');
    expect(frame).not.toMatch(/planner seat|plan seat/);
    ui.unmount();
  });

  // The row under the cursor is where a configured command is spelled; the card beside it says
  // what the row does, and says it the same way whether or not one is configured.
  it.each([
    { state: 'configured', command: './scripts/plan.sh', rowLabel: 'output · ./scripts/plan.sh' },
    { state: 'unset', command: undefined, rowLabel: '+ Add custom command…' },
  ])('keeps the $state command on its row and out of the card', async ({ command, rowLabel }) => {
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
      ...(command === undefined ? {} : { currentCommand: command, currentCommandKind: 'shell' }),
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions()} />,
    );
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(rowLabel);
    expect(frame).not.toContain('Current:');
    if (command !== undefined) expect(frame.split(command).length - 1).toBe(1);
    for (const line of PANE_SENTENCES) expect(frame).toContain(line);
    ui.unmount();
  });

  it('confirms the launcher into the contract choice and saves nothing on the way', async () => {
    const calls: string[] = [];
    const codexTool = cliTool('codex', 'OpenAI Codex CLI');
    const catalog: PickerCatalog = pickerCatalog({
      browseCatalog: false,
      items: [codexTool, launcher],
      rightModels: [],
      currentItem: codexTool,
      selectedItemId: codexTool.id,
      initialLeftIdx: 0,
      roleLabel: 'Planner',
      modelCounts: zeroCounts,
    });

    const ui = renderFeature(
      <PickerView role="planner" catalog={catalog} actions={makeActions(calls)} />,
    );
    await flushEffects();

    ui.stdin.write('\u001B[B'); // onto the launcher row: landing on it commits nothing
    await flushEffects();
    expect(ui.lastFrame() ?? '').toContain('Custom command');
    expect(calls).toEqual([]);

    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    // The launcher's confirm carries no model: it opens the contract choice, it does not save.
    expect(calls).toEqual(['confirm:custom-command:null']);
    ui.unmount();
  });

  // The pane is a fixed-height card that truncates instead of wrapping, so the copy has to survive
  // the narrowest width and the shortest height the picker renders at. 100 cols is where the card
  // crosses into wrapping — the one width that could spend two rows on one line without saying so.
  it.each([
    { cols: 60, rows: 18 },
    { cols: 80, rows: 24 },
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
    // Every sentence whole, including the last one — nothing cut on the right, nothing dropped
    // off the bottom — and each of them on exactly one row.
    for (const line of PANE_SENTENCES) {
      expect(frame, `${line} at ${cols}x${rows}`).toContain(line);
      expect(frame.split(line).length - 1, `${line} at ${cols}x${rows}`).toBe(1);
    }
    ui.unmount();
  });
});
