import { describe, expect, it } from 'vitest';
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

  it('renders distinct add-shell and add-agent labels', async () => {
    const shell = pickerItem({
      id: 'shell',
      displayName: 'Shell',
      kind: 'shell',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const agent = pickerItem({
      id: 'agent',
      displayName: 'Agent',
      kind: 'agent',
      roles: ['planner', 'implementer'],
      modelPolicy: 'none',
      billing: 'unknown',
      permissions: readyPermissions,
      status: { state: 'ready', remediation: null },
      available: true,
    });
    const ui = renderFeature(
      <>
        {renderToolRow({
          item: shell,
          isCursor: false,
          isSelected: false,
          maxWidth: 40,
          currentCommand: undefined,
          currentCommandKind: undefined,
        })}
        {renderToolRow({
          item: agent,
          isCursor: false,
          isSelected: false,
          maxWidth: 40,
          currentCommand: undefined,
          currentCommandKind: undefined,
        })}
      </>,
    );
    await tick();

    expect(ui.lastFrame()).toContain('+ Add shell command…');
    expect(ui.lastFrame()).toContain('+ Add agent command…');
    ui.unmount();
  });
});
