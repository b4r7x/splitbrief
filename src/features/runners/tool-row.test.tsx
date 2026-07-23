import { describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { renderModelRow, renderToolRow } from './tool-row.js';
import type { ModelOption, PickerOption } from './model-catalog.js';

describe('runner row grammar', () => {
  it('renders dim status suffixes without parens badges', async () => {
    const unavailable: PickerOption = {
      id: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'api',
      available: false,
      badge: 'API',
    };
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

  it('renders a versioned tool with a bare dim version, no v-prefix or parens', async () => {
    const tool: PickerOption = {
      id: 'claude-code',
      displayName: 'Claude Code',
      kind: 'cli',
      available: true,
      badge: 'CLI',
      version: '1.2.3',
    };
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
    const auto: ModelOption = { id: 'auto', isDefault: true };

    const customUi = renderFeature(
      renderModelRow({ item: custom, isCursor: false, maxWidth: 40, currentModel: undefined }),
    );
    await tick(20);
    const customFrame = customUi.lastFrame() ?? '';
    expect(customFrame).toContain('Custom');
    expect(customFrame).not.toContain('(Custom)');
    customUi.unmount();

    const autoUi = renderFeature(
      renderModelRow({ item: auto, isCursor: false, maxWidth: 40, currentModel: undefined }),
    );
    await tick(20);
    const autoFrame = autoUi.lastFrame() ?? '';
    expect(autoFrame).toContain('Default');
    expect(autoFrame).not.toContain('(auto)');
    autoUi.unmount();
  });

  it('renders distinct add-shell and add-agent labels', async () => {
    const shell: PickerOption = {
      id: 'shell',
      displayName: 'Shell',
      kind: 'shell',
      available: true,
      badge: 'Custom',
    };
    const agent: PickerOption = {
      id: 'agent',
      displayName: 'Agent',
      kind: 'agent',
      available: true,
      badge: 'Custom',
    };
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
