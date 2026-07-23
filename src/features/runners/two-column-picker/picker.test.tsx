import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { ListRow } from '../../../components/list-row.js';
import { glyph } from '../../../lib/glyphs.js';
import { TwoColumnPicker } from './picker.js';

interface Tool {
  id: string;
  displayName: string;
  disabled?: boolean;
}
interface Model {
  id: string;
  displayName: string;
}

const TOOLS: Tool[] = [
  { id: 'alpha', displayName: 'Alpha' },
  { id: 'beta', displayName: 'Beta', disabled: true },
  { id: 'gamma', displayName: 'Gamma' },
];

const MODELS_BY_TOOL: Record<string, Model[]> = {
  alpha: [
    { id: 'a-1', displayName: 'alpha-1' },
    { id: 'a-2', displayName: 'alpha-2' },
  ],
  gamma: [{ id: 'g-1', displayName: 'gamma-1' }],
};

describe('TwoColumnPicker', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  it('arrow nav emits onLeftChange; Enter on a disabled left is a no-op', async () => {
    const leftChanges: string[] = [];
    const confirms: string[] = [];
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
          onLeftChange: (t) => {
            leftChanges.push(t.id);
          },
        }}
        onConfirm={(l) => {
          confirms.push(l.id);
        }}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('alpha');
    });

    ui.stdin.write('\u001B[B'); // down -> 'beta' (disabled)
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('beta');
    });

    ui.stdin.write('\r'); // Enter on disabled - no-op
    await tick(20);
    expect(confirms).toEqual([]);

    ui.stdin.write('\u001B[B'); // down -> 'gamma'
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('gamma');
      expect(ui.lastFrame()).toContain('Gamma');
    });
    ui.unmount();
  });

  it('Enter on left moves focus right; right items derive from left; Enter on right confirms both', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    function Consumer() {
      const [leftId, setLeftId] = useState('alpha');
      return (
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: TOOLS,
            getKey: (t) => t.id,
            isDisabled: (t) => !!t.disabled,
            renderRow: (t) => <Text>{t.displayName}</Text>,
          }}
          rightProps={{
            items: MODELS_BY_TOOL[leftId] ?? [],
            getKey: (m) => m.id,
            renderRow: (m) => <Text>{m.displayName}</Text>,
            onLeftChange: (t) => {
              setLeftId(t.id);
            },
          }}
          onConfirm={(l, r) => {
            confirms.push({ l: l.id, r: r?.id ?? null });
          }}
          onCancel={() => {}}
        />
      );
    }
    const ui = renderFeature(<Consumer />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('alpha-1');

    ui.stdin.write('\r'); // Enter left -> focus right
    await flushEffects();
    ui.stdin.write('\r'); // Enter right -> confirm
    await tick(20);

    expect(confirms).toEqual([{ l: 'alpha', r: 'a-1' }]);
    ui.unmount();
  });

  it('clicking a left tool row selects it and emits onLeftChange (alternate trigger)', async () => {
    const leftChanges: string[] = [];
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
          onLeftChange: (t) => {
            leftChanges.push(t.id);
          },
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('alpha');
    });

    collectClickableZones({ cols: 140, rows: 40 }).get('runner-left:gamma')?.();
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('gamma');
    });
    ui.unmount();
  });

  it('clicking a right model row confirms the left+right pair (alternate trigger)', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={(l, r) => {
          confirms.push({ l: l.id, r: r?.id ?? null });
        }}
        onCancel={() => {}}
      />,
    );
    await tick(20);

    collectClickableZones({ cols: 140, rows: 40 }).get('runner-right:a-2')?.();
    await tick(20);

    expect(confirms).toEqual([{ l: 'alpha', r: 'a-2' }]);
    ui.unmount();
  });

  it('Escape fires onCancel; empty left blocks right-arrow focus switch', async () => {
    let cancelled = 0;
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: [],
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {
          cancelled++;
        }}
      />,
    );
    await tick(20);

    ui.stdin.write('\u001B[C'); // right with no left item
    await tick(20);
    ui.stdin.write('\u001B'); // Escape
    await tick(20);

    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('ignores keys while a foreign overlay is open, then handles them once it closes', async () => {
    overlayStore.open('help');
    let cancelled = 0;
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {
          cancelled++;
        }}
      />,
    );
    await tick(20);

    ui.stdin.write('\u001B'); // Escape - ignored while the overlay is on top
    await tick(20);
    expect(cancelled).toBe(0);

    overlayStore.close();
    await tick(20);

    ui.stdin.write('\u001B'); // Escape now reaches the picker and fires onCancel
    await tick(20);
    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('renders exactly one cursor glyph on the focused row', async () => {
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t, { isCursor }) => (
            <ListRow
              label={t.displayName}
              state={isCursor ? 'active' : 'default'}
              defaultLead="dot"
            />
          ),
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const liveBar = glyph('liveBar', 'unicode');
    const alphaLine = frame.split('\n').find((line) => line.includes('Alpha')) ?? '';
    expect(alphaLine).toContain(liveBar);
    expect(alphaLine.match(/▌/g)).toHaveLength(1);
    expect(alphaLine).not.toContain('▸');
    ui.unmount();
  });

  it('fills the panel with 20 list rows at 30 terminal rows', async () => {
    const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
    terminalSizeStore.__testReset({ cols: 140, rows: 30, isSmall: false });
    const items: Tool[] = Array.from({ length: 30 }, (_, i) => ({
      id: `tool-${i}`,
      displayName: `Tool ${i}`,
    }));
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items,
          getKey: (item) => item.id,
          renderRow: (item) => <Text>{item.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (item) => item.id,
          renderRow: (item) => <Text>{item.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    const renderedRows = frame.split('\n').filter((line) => /\bTool \d+\b/.test(line));
    expect(renderedRows).toHaveLength(20);
    expect(frame).toContain('Tool 19');
    expect(frame).not.toContain('Tool 20');
    ui.unmount();
  });

  it('renders one dim preview line resolving the focused item, and drops it at ≤50 cols', async () => {
    const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
    function picker() {
      return (
        <TwoColumnPicker<Tool, Model>
          title="picker"
          leftProps={{
            items: TOOLS,
            label: 'tools',
            getKey: (t) => t.id,
            renderRow: (t) => <Text>{t.displayName}</Text>,
          }}
          rightProps={{
            items: [],
            getKey: (m) => m.id,
            renderRow: (m) => <Text>{m.displayName}</Text>,
          }}
          onConfirm={() => {}}
          onCancel={() => {}}
          preview={(ctx) => `resolved: ${ctx.leftItem?.id ?? 'none'}`}
        />
      );
    }

    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    const wide = renderFeature(picker());
    await tick(20);
    expect(wide.lastFrame() ?? '').toContain('resolved: alpha');
    wide.unmount();

    terminalSizeStore.__testReset({ cols: 40, rows: 24, isSmall: true });
    const narrow = renderFeature(picker());
    await tick(20);
    expect(narrow.lastFrame() ?? '').not.toContain('resolved:');
    narrow.unmount();
  });

  it('strips OSC/CSI control bytes from the preview line (custom model id regression)', async () => {
    const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
    terminalSizeStore.__testReset({ cols: 140, rows: 40, isSmall: false });
    const esc = '\u001B';
    const bel = '\u0007';
    const hostile = `gpt${esc}]8;;http://evil.example${bel}-${esc}[31m4o`;
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="picker"
        leftProps={{
          items: TOOLS,
          label: 'tools',
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
        preview={() => `resolved: ${hostile}`}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('resolved: gpt-4o');
    expect(frame).not.toContain('evil.example');
    expect(frame).not.toContain(']8;;');
    expect(frame).not.toContain('[31m');
    ui.unmount();
  });

  it('shows the re-voiced empty placeholder and an in-card scrollbar on overflow', async () => {
    const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
    terminalSizeStore.__testReset({ cols: 100, rows: 20, isSmall: true });
    const many: Tool[] = Array.from({ length: 20 }, (_, i) => ({
      id: `tool-${i}`,
      displayName: `Tool ${i}`,
    }));
    const overflowing = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="picker"
        leftProps={{
          items: many,
          label: 'tools',
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick(20);
    // The plain "(i / N)" counter is replaced by the interior scrollbar thumb in the right gutter.
    expect(overflowing.lastFrame() ?? '').toContain(glyph('scrollThumb'));
    overflowing.unmount();

    const empty = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="picker"
        leftProps={{
          items: [],
          label: 'tools',
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick(20);
    expect(empty.lastFrame() ?? '').toContain('No tools match');
    empty.unmount();
  });

  it('handles keys while its own picker overlay is the active overlay', async () => {
    overlayStore.open('planner-picker');
    let cancelled = 0;
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: [],
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {
          cancelled++;
        }}
      />,
    );
    await tick(20);

    ui.stdin.write('\u001B'); // Escape - active because the picker's own overlay is topmost
    await tick(20);
    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('does not confirm a hidden tool on Enter when no list rows are visible', async () => {
    const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
    terminalSizeStore.__testReset({ cols: 80, rows: 4, isSmall: false });
    const confirms: string[] = [];
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={(tool) => {
          confirms.push(tool.id);
        }}
        onCancel={() => {}}
      />,
    );
    await tick(20);

    ui.stdin.write('\r');
    await tick(20);

    expect(confirms).toEqual([]);
    ui.unmount();
  });
});
