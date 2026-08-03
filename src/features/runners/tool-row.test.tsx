import { beforeEach, describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import type { ModelOption } from './model-catalog/recency.js';
import { renderModelRow, renderToolRow } from './tool-row.js';

function pickerItem(
  item: Omit<PickerOption, 'modelCapability'> & { modelPolicy: PickerOption['modelPolicy'] },
): PickerOption {
  return {
    ...item,
    modelCapability: deriveModelCatalogCapability(item.modelPolicy),
  };
}

const readyPermissions = {
  directWrite: false,
  network: true,
  shell: false,
  automaticApproval: false,
  sandbox: 'none' as const,
};

describe('runner row grammar', () => {
  it('renders dim status suffixes without parens badges', async () => {
    const unavailable = pickerItem({
      id: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'api',
      roles: ['implementer'],
      modelPolicy: 'per-call',
      billing: 'api-metered',
      permissions: readyPermissions,
      status: { state: 'unavailable', remediation: 'Start DeepSeek and refresh detection.' },
      available: false,
    });
    const ui = renderFeature(
      renderToolRow({
        item: unavailable,
        isCursor: false,
        isSelected: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Unavailable');
    expect(frame).not.toContain('(Unavailable)');
    ui.unmount();
  });

  it('shows stable unavailable, auth, and mismatch semantics from status', async () => {
    const cases: Array<{ status: PickerOption['status']; label: string }> = [
      {
        status: { state: 'unauthenticated', remediation: 'Set API key.' },
        label: 'Auth required',
      },
      {
        status: { state: 'incompatible', remediation: 'Install tested version.' },
        label: 'Incompatible',
      },
      {
        status: { state: 'untrusted', remediation: 'Trust executable.' },
        label: 'Untrusted',
      },
    ];

    for (const { status, label } of cases) {
      const item = pickerItem({
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        roles: ['planner', 'implementer'],
        modelPolicy: 'optional',
        billing: 'subscription-included',
        permissions: { ...readyPermissions, directWrite: true, automaticApproval: true },
        status,
        available: false,
      });
      const ui = renderFeature(
        renderToolRow({
          item,
          isCursor: false,
          isSelected: false,
          maxWidth: 60,
          currentCommand: undefined,
          currentCommandKind: undefined,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('Codex');
      expect(frame).toContain(label);
      ui.unmount();
    }
  });

  it('keeps the current marker visible when the configured runner is not ready', async () => {
    const brokenCurrent = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'incompatible', remediation: 'Install tested version.' },
      available: false,
      isCurrent: true,
    });
    const ui = renderFeature(
      renderToolRow({
        item: brokenCurrent,
        isCursor: false,
        isSelected: false,
        maxWidth: 50,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    expect(ui.lastFrame() ?? '').toContain('Incompatible');
    ui.unmount();
  });

  it('renders a versioned tool with a bare dim version, no v-prefix or parens', async () => {
    const tool = pickerItem({
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      roles: ['planner', 'implementer'],
      modelPolicy: 'optional',
      billing: 'subscription-included',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
      version: '1.2.3',
    });
    const ui = renderFeature(
      renderToolRow({
        item: tool,
        isCursor: false,
        isSelected: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('1.2.3');
    expect(frame).not.toContain('(1.2.3)');
    expect(frame).not.toContain('v1.2.3');
    ui.unmount();
  });

  it('renders custom/default model suffixes without parens badges', async () => {
    const custom: ModelOption = { id: 'my-org/custom', isCustom: true };
    const bundledDefault: ModelOption = { id: 'gpt-5.4', isDefault: true };

    const customUi = renderFeature(
      renderModelRow({ item: custom, isCursor: false, maxWidth: 40, currentModel: undefined }),
    );
    await tick(20);
    const customFrame = customUi.lastFrame() ?? '';
    expect(customFrame).toContain('Custom');
    expect(customFrame).not.toContain('(Custom)');
    customUi.unmount();

    const defaultUi = renderFeature(
      renderModelRow({
        item: bundledDefault,
        isCursor: false,
        maxWidth: 40,
        currentModel: undefined,
      }),
    );
    await tick(20);
    const defaultFrame = defaultUi.lastFrame() ?? '';
    expect(defaultFrame).toContain('Default');
    expect(defaultFrame).not.toContain('(Default)');
    defaultUi.unmount();
  });

  it('marks a stale retained model without calling it detected', async () => {
    const ui = renderFeature(
      renderModelRow({
        item: {
          id: 'retained-model',
          membership: 'stale',
          isStale: true,
          isDetected: false,
        },
        isCursor: false,
        maxWidth: 60,
        currentModel: undefined,
      }),
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Stale');
    expect(frame).not.toContain('Detected');
    expect(frame).not.toContain('Confirmed');
    ui.unmount();
  });

  it('renders the Auto policy row as a bare label with no model metadata', async () => {
    const ui = renderFeature(
      renderModelRow({ item: { id: 'auto' }, isCursor: false, maxWidth: 40, currentModel: 'auto' }),
    );
    await tick(20);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Auto');
    expect(frame).not.toContain('Default');
    expect(frame).not.toContain('Custom');
    expect(frame).not.toContain('K');
    ui.unmount();
  });

  it('renders one add-custom-command launcher instead of per-kind add rows', async () => {
    const launcher = pickerItem({
      id: 'custom-command',
      displayName: 'Custom command',
      kind: 'custom-command',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const ui = renderFeature(
      renderToolRow({
        item: launcher,
        isCursor: false,
        isSelected: false,
        maxWidth: 40,
        currentCommand: undefined,
        currentCommandKind: undefined,
      }),
    );
    await tick();

    expect(ui.lastFrame()).toContain('+ Add custom command…');
    expect(ui.lastFrame()).not.toContain('Add shell command');
    expect(ui.lastFrame()).not.toContain('Add agent command');
    ui.unmount();
  });

  describe('merged provider rows', () => {
    beforeEach(() => {
      forceUnicodeGlyphs();
    });

    const MERGED: ModelOption = {
      id: 'github-copilot/gpt-5.6',
      contextLength: 128_000,
      variants: [
        { fullId: 'github-copilot/gpt-5.6', providerPrefix: 'github-copilot', tag: 'copilot' },
        { fullId: 'kilo/openrouter/gpt-5.6', providerPrefix: 'kilo/openrouter', tag: 'openrouter' },
      ],
    };

    it('signposts a multi-provider row with a provider count, no tags or glyphs', async () => {
      const ui = renderFeature(
        renderModelRow({ item: MERGED, isCursor: false, maxWidth: 60, currentModel: undefined }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('GPT-5.6');
      expect(frame).toContain('2 providers');
      expect(frame).not.toContain('copilot');
      expect(frame).not.toContain('●');
      expect(frame).not.toContain('○');
      ui.unmount();
    });

    it('renders a single-variant row without any provider annotation', async () => {
      const ui = renderFeature(
        renderModelRow({
          item: {
            id: 'openrouter/gemini-3-flash',
            variants: [
              {
                fullId: 'openrouter/gemini-3-flash',
                providerPrefix: 'openrouter',
                tag: 'openrouter',
              },
            ],
          },
          isCursor: false,
          maxWidth: 60,
          currentModel: undefined,
        }),
      );
      await tick(20);
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain('providers');
      expect(frame).not.toContain('openrouter');
      ui.unmount();
    });

    it('marks the row configured when any variant spelling matches the saved model', async () => {
      const ui = renderFeature(
        renderModelRow({
          item: MERGED,
          isCursor: false,
          maxWidth: 60,
          currentModel: 'kilo/openrouter/gpt-5.6',
        }),
      );
      await tick(20);
      expect(ui.lastFrame() ?? '').toContain('✓');
      ui.unmount();
    });
  });

  it('shows the configured command with its saved contract on the launcher row', async () => {
    const launcher = pickerItem({
      id: 'custom-command',
      displayName: 'Custom command',
      kind: 'custom-command',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });

    for (const [kind, contractWord] of [
      ['shell', 'output'],
      ['agent', 'direct'],
    ] as const) {
      const ui = renderFeature(
        renderToolRow({
          item: launcher,
          isCursor: false,
          isSelected: false,
          maxWidth: 40,
          currentCommand: 'my-tool --json',
          currentCommandKind: kind,
        }),
      );
      await tick();
      expect(ui.lastFrame()).toContain(`${contractWord} · my-tool --json`);
      ui.unmount();
    }
  });
});
