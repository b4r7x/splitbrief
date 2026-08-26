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
import { overlayWidth } from '../../../core/navigation/overlay-rect.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
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

const BACKSPACE = '\u007f';

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
    await vi.waitFor(
      () => {
        expect(leftChanges.at(-1)).toBe('alpha');
      },
      { timeout: 5_000 },
    );
    await flushEffects();

    ui.stdin.write('\u001B[B'); // down -> 'beta' (disabled)
    await vi.waitFor(
      () => {
        expect(leftChanges.at(-1)).toBe('beta');
      },
      { timeout: 5_000 },
    );
    await flushEffects();

    ui.stdin.write('\r'); // Enter on disabled - no-op
    await flushEffects();
    ui.stdin.write('\u001B[B'); // down -> 'gamma'; reaching it proves the Enter above was processed
    await vi.waitFor(
      () => {
        expect(leftChanges.at(-1)).toBe('gamma');
        expect(ui.lastFrame()).toContain('Gamma');
      },
      { timeout: 5_000 },
    );
    expect(confirms).toEqual([]);
    ui.unmount();
  });

  it('typing a left filter emits onLeftChange so right models track the filtered tool', async () => {
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
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    }
    const ui = renderFeature(<Consumer />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('g');
    await flushEffects();

    expect(ui.lastFrame()).toContain('gamma-1');
    expect(ui.lastFrame()).not.toContain('alpha-1');
    ui.unmount();
  });

  it('re-sorting the left list under the cursor re-emits onLeftChange and confirms the visible pair', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    function Consumer() {
      const [tools, setTools] = useState(TOOLS);
      const [leftId, setLeftId] = useState('alpha');
      return (
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: tools,
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
          onRefresh={() => {
            setTools(TOOLS.toReversed());
          }}
        />
      );
    }
    const ui = renderFeature(<Consumer />);
    await flushEffects();
    expect(ui.lastFrame()).toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('\u0012'); // ctrl+r - refresh re-sorts the tools under the cursor
    await flushEffects();

    expect(ui.lastFrame()).toContain('gamma-1');
    expect(ui.lastFrame()).not.toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('\r'); // Enter left -> focus right
    await flushEffects();
    ui.stdin.write('\r'); // Enter right -> confirm
    await tick(20);

    expect(confirms).toEqual([{ l: 'gamma', r: 'g-1' }]);
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

    await flushEffects();
    ui.stdin.write('\r'); // Enter left -> focus right
    await flushEffects();
    ui.stdin.write('\r'); // Enter right -> confirm
    await tick(20);

    expect(confirms).toEqual([{ l: 'alpha', r: 'a-1' }]);
    ui.unmount();
  });

  it('resets the right cursor to the destination left item, falling back to the default', async () => {
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
            // Only alpha resolves an index; every other destination takes the default.
            resolveInitialIndex: (left) => (left?.id === 'alpha' ? 1 : undefined),
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

    // Down to gamma (beta is disabled but still navigable), back up to alpha:
    // each move resets the right cursor through resolveInitialIndex.
    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(confirms).toEqual([{ l: 'gamma', r: 'g-1' }]);

    await flushEffects();
    ui.stdin.write('\u001B[D');
    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(confirms.at(-1)).toEqual({ l: 'alpha', r: 'a-2' });
    ui.unmount();
  });

  it.each([
    { branch: 'printable input', keys: ['al'] },
    { branch: 'backspace', keys: ['alz', BACKSPACE] },
  ])('resolves the right cursor for the left item a $branch filter lands on', async ({ keys }) => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    function Consumer() {
      const [leftId, setLeftId] = useState('gamma');
      return (
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: TOOLS,
            getKey: (t) => t.id,
            isDisabled: (t) => !!t.disabled,
            initialIndex: 2,
            renderRow: (t) => <Text>{t.displayName}</Text>,
          }}
          rightProps={{
            items: MODELS_BY_TOOL[leftId] ?? [],
            getKey: (m) => m.id,
            renderRow: (m) => <Text>{m.displayName}</Text>,
            resolveInitialIndex: (left) => (left?.id === 'alpha' ? 1 : undefined),
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

    for (const keystroke of keys) {
      await flushEffects();
      ui.stdin.write(keystroke);
      await flushEffects();
    }
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(confirms).toEqual([{ l: 'alpha', r: 'a-2' }]);
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
    await flushEffects();

    ui.stdin.write('\u001B[C'); // right with no left item
    await flushEffects();
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
    await flushEffects();

    ui.stdin.write('\u001B'); // Escape - ignored while the overlay is on top
    await tick(20);
    expect(cancelled).toBe(0);

    overlayStore.close();
    await flushEffects();

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

  it.each(['planner-picker', 'implementer-picker', 'reviewer-picker'] as const)(
    'handles keys while the %s overlay is the active overlay',
    async (overlay) => {
      overlayStore.open(overlay);
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
      await flushEffects();

      ui.stdin.write('\u001B'); // Escape - active because the picker's own overlay is topmost
      await tick(20);
      expect(cancelled).toBe(1);
      ui.unmount();
    },
  );

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
    await flushEffects();

    ui.stdin.write('\r');
    await tick(20);

    expect(confirms).toEqual([]);
    ui.unmount();
  });
  it.each([
    { cols: 120, rows: 40, left: 3, right: 41, visible: 30, custom: false },
    { cols: 60, rows: 18, left: 3, right: 41, visible: 8, custom: false },
    { cols: 120, rows: 40, left: 9, right: 9, visible: 9, custom: false },
    { cols: 120, rows: 40, left: 3, right: 9, visible: 9, custom: true },
  ])(
    'shows $visible list rows at $cols x $rows with $left left and $right right slots (custom row: $custom)',
    async ({ cols, rows, left, right, visible, custom }) => {
      const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
      terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
      const tools: Tool[] = Array.from({ length: left }, (_, i) => ({
        id: `tool-${i}`,
        displayName: `Tool ${i}`,
      }));
      const models: Model[] = Array.from({ length: right }, (_, i) => ({
        id: `model-${i}`,
        displayName: `Model ${i}`,
      }));
      const ui = renderFeature(
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: tools,
            getKey: (t) => t.id,
            renderRow: (t) => <Text>{t.displayName}</Text>,
          }}
          rightProps={{
            items: models,
            getKey: (m) => m.id,
            renderRow: (m) => <Text>{m.displayName}</Text>,
            ...(custom ? { customRow: { onSelect: () => {} } } : {}),
          }}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
        { cols, rows },
      );
      await tick(20);

      const lines = (ui.lastFrame() ?? '').split('\n');
      expect(lines.filter((line) => /\bModel \d+\b/.test(line))).toHaveLength(visible);
      ui.unmount();
    },
  );

  it('keeps the 63-cell hint on one row at 60 columns', async () => {
    const { terminalSizeStore } = await import('../../../stores/ui/terminal-size.js');
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
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
        onCancel={() => {}}
        onRefresh={() => {}}
      />,
      { cols: 60, rows: 18 },
    );
    await tick(20);

    const lines = (ui.lastFrame() ?? '').split('\n');
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
    let start = end;
    while (start > 0 && (lines[start - 1] ?? '').trim() !== '') start -= 1;
    const hintRows = lines.slice(start, end);
    expect(hintRows).toHaveLength(1);
    expect(getTerminalCellWidth((hintRows[0] ?? '').trim())).toBeLessThanOrEqual(
      overlayWidth({ cols: 60, density: 'wide' }),
    );
    ui.unmount();
  });
});

const TERMINAL_PANE = {
  label: "Planner's setup",
  verb: "use planner's setup",
  lines: [
    'The review seat runs whatever the planner runs.',
    '',
    'Claude Code CLI · Claude Sonnet 4',
    'subscription · Network · Shell',
    '',
    'Pick a tool on the left to give the review seat its own setup.',
  ],
};

const INHERIT: Tool = { id: 'inherit', displayName: 'Same as planner' };

/** Enough tools that the tool column outgrows the card and can be seen to. */
const MANY_TOOLS: Tool[] = Array.from({ length: 11 }, (_unused, i) => ({
  id: `tool-${i}`,
  displayName: `Tool ${i}`,
}));

describe('TwoColumnPicker terminal rows', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  function renderTerminal(opts: {
    onConfirm?: ((left: Tool, right: Model | null) => void) | undefined;
    onLeftChange?: ((left: Tool) => void) | undefined;
    cols?: number;
    rows?: number;
  }) {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;
    terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
    return renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Reviewer"
        leftProps={{
          items: [INHERIT, ...TOOLS, ...MANY_TOOLS],
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          terminalPane: (t) => (t.id === INHERIT.id ? TERMINAL_PANE : undefined),
          renderRow: (t, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
          ...(opts.onLeftChange ? { onLeftChange: opts.onLeftChange } : {}),
        }}
        onConfirm={opts.onConfirm ?? (() => {})}
        onCancel={() => {}}
        onRefresh={() => {}}
      />,
      { cols, rows },
    );
  }

  it('renders a content-hugging card instead of a filterable model column', async () => {
    const ui = renderTerminal({});
    await flushEffects();
    const frame = ui.lastFrame() ?? '';

    // The left column keeps its filter row; the card has none.
    expect(frame.split('Type to filter…').length - 1).toBe(1);
    for (const line of TERMINAL_PANE.lines.filter(Boolean)) {
      expect(frame).toContain(line.slice(0, 20));
    }
    expect(frame).toContain(TERMINAL_PANE.label);
    expect(frame).toContain(`⏎ ${TERMINAL_PANE.verb}`);

    // Card rows at 120 cols: top border + label + blank + 7 rendered rows (the
    // closing instruction wraps onto a second row) + bottom border = 11.
    const CARD_ROWS = 11;
    const lines = frame.split('\n');
    const opens = lines.findIndex((line) => line.includes('╭'));
    const cardClose = lines.findIndex((line) => line.includes('╯'));
    const lastClose = lines.map((line) => line.includes('╯')).lastIndexOf(true);
    expect(cardClose - opens + 1).toBe(CARD_ROWS);
    // Content-hugging: the tool column is still open when the card closes.
    expect(cardClose).toBeLessThan(lastClose);
    // The card never ragged-edges: its interior rows all close at one column.
    const closingColumns = new Set(
      lines.slice(opens + 1, cardClose).map((line) => [...line].lastIndexOf('│')),
    );
    expect(closingColumns.size).toBe(1);
    ui.unmount();
  });

  it.each([
    { cols: 80, rows: 24 },
    { cols: 60, rows: 18 },
  ])('truncates the card and keeps the hint on one row at $cols columns', async (viewport) => {
    const ui = renderTerminal(viewport);
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');

    // Still one filter row (the tool column's); the card never grows one.
    expect(frame.split('Type to filter…').length - 1).toBe(1);
    // The card's first content line no longer fits, so it is truncated, not wrapped.
    expect(frame).toContain('The review seat runs w');
    expect(frame).not.toContain(TERMINAL_PANE.lines[0]);

    const hintRows = lines.filter((line) => line.includes('↑↓ select'));
    expect(hintRows).toHaveLength(1);
    // Keys first: the terminal verb rides with them, never behind a wrap.
    expect((hintRows[0] ?? '').trim().startsWith(`↑↓ select · ⏎ ${TERMINAL_PANE.verb}`)).toBe(true);
    expect(getTerminalCellWidth((hintRows[0] ?? '').trim())).toBeLessThanOrEqual(viewport.cols - 2);
    ui.unmount();
  });

  it('confirms the terminal row on Enter and never hands focus to the card', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    const leftChanges: string[] = [];
    const ui = renderTerminal({
      onConfirm: (l, r) => {
        confirms.push({ l: l.id, r: r?.id ?? null });
      },
      onLeftChange: (t) => {
        leftChanges.push(t.id);
      },
    });
    await flushEffects();

    ui.stdin.write('\u001B[C'); // right arrow is inert on a terminal row
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual([{ l: 'inherit', r: null }]);

    // Focus never left the tool column: ↓ still moves the left cursor.
    ui.stdin.write('\u001B[B');
    await tick(20);
    expect(leftChanges.at(-1)).toBe('alpha');
    ui.unmount();
  });
});

describe('TwoColumnPicker expandable right rows', () => {
  interface Route extends Model {
    activation: 'confirm' | 'expand' | 'collapse';
  }
  const ROWS: Route[] = [
    { id: 'luna', displayName: 'GPT-5.6 Luna', activation: 'expand' },
    { id: 'solo', displayName: 'Solo Model', activation: 'confirm' },
  ];

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  function renderRows(opts: {
    expanded: boolean;
    onExpand?: ((row: Route) => void) | undefined;
    onCollapse?: (() => void) | undefined;
    onConfirm?: ((left: Tool, right: Route | null) => void) | undefined;
    onCancel?: (() => void) | undefined;
  }) {
    return renderFeature(
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: ROWS,
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
          activationOf: (m) => m.activation,
          isExpanded: opts.expanded,
          ...(opts.onExpand ? { onExpand: opts.onExpand } : {}),
          ...(opts.onCollapse ? { onCollapse: opts.onCollapse } : {}),
        }}
        onConfirm={opts.onConfirm ?? (() => {})}
        onCancel={opts.onCancel ?? (() => {})}
      />,
    );
  }

  // The routes reach the picker as props, so an owner that grows the list on
  // expand is the only fixture that can prove where the cursor lands.
  const REVEALED: Route[] = [
    { id: 'luna-openrouter', displayName: 'openrouter route', activation: 'confirm' },
    { id: 'luna-fireworks', displayName: 'fireworks route', activation: 'confirm' },
  ];

  function LiveExpandingRows(props: {
    onExpand: (id: string) => void;
    onConfirm: (id: string) => void;
  }) {
    const [expanded, setExpanded] = useState(false);
    // `luna` is the last collapsed row: an index computed against the list the
    // keypress sees would clamp straight back onto it.
    const collapsed: Route[] = [
      { id: 'solo', displayName: 'Solo Model', activation: 'confirm' },
      { id: 'luna', displayName: 'GPT-5.6 Luna', activation: 'expand' },
    ];
    const rows = expanded ? [...collapsed, ...REVEALED] : collapsed;
    return (
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: rows,
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
          activationOf: (m) =>
            m.id === 'luna' && expanded ? 'collapse' : (m.activation as Route['activation']),
          isExpanded: expanded,
          onExpand: (row) => {
            props.onExpand(row.id);
            setExpanded(true);
          },
          onCollapse: () => setExpanded(false),
        }}
        onConfirm={(_l, r) => props.onConfirm(r?.id ?? 'none')}
        onCancel={() => {}}
      />
    );
  }

  it('expands a multi-route row instead of confirming it', async () => {
    const expanded: string[] = [];
    const confirms: string[] = [];
    const ui = renderFeature(
      <LiveExpandingRows
        onExpand={(id) => {
          expanded.push(id);
        }}
        onConfirm={(id) => {
          confirms.push(id);
        }}
      />,
    );
    await flushEffects();

    ui.stdin.write('\u001B[B'); // onto `luna`, the last row
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(expanded).toEqual(['luna']);
    expect(confirms).toEqual([]);
    // The cursor moved onto the first row the expansion revealed.
    expect(ui.lastFrame()).toContain('>openrouter route');
    ui.unmount();
  });

  it('confirms a row whose route is already decided, without expanding it', async () => {
    const confirms: string[] = [];
    const expanded: string[] = [];
    const ui = renderRows({
      expanded: false,
      onExpand: (row) => {
        expanded.push(row.id);
      },
      onConfirm: (_l, r) => {
        confirms.push(r?.id ?? 'none');
      },
    });
    await flushEffects();

    ui.stdin.write('\u001B[B');
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual(['solo']);
    expect(expanded).toEqual([]);
    ui.unmount();
  });

  it('collapses before cancelling on escape', async () => {
    const collapses: number[] = [];
    const cancels: number[] = [];
    const ui = renderRows({
      expanded: true,
      onCollapse: () => {
        collapses.push(1);
      },
      onCancel: () => {
        cancels.push(1);
      },
    });
    await flushEffects();

    ui.stdin.write('\u001B');
    await tick(20);
    expect(collapses).toHaveLength(1);
    expect(cancels).toHaveLength(0);
    ui.unmount();
  });
});
