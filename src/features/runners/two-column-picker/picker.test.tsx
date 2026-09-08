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
import { TwoColumnPicker, buildRightDisplay } from './picker.js';

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
    expect(alphaLine.split(liveBar).length - 1).toBe(1);
    expect(alphaLine).not.toContain('▸');
    ui.unmount();
  });

  it('shows dim liveBar on the previously-cursored left row while right column has active cursor, and returns to active on left arrow', async () => {
    const leftCalls: Array<{ id: string; isCursor: boolean; isSelected: boolean; state: string }> =
      [];
    const rightCalls: Array<{ id: string; isCursor: boolean; state: string }> = [];

    function Consumer() {
      const [leftId, setLeftId] = useState('alpha');
      return (
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: TOOLS,
            getKey: (t) => t.id,
            isDisabled: (t) => !!t.disabled,
            renderRow: (t, { isCursor, isSelected, isContext }) => {
              // The state comes from the meta the picker passes, never re-derived
              // here — a fixture that recomputes it cannot fail when the picker
              // stops forwarding the flag.
              const state = isCursor ? 'active' : isContext === true ? 'context' : 'default';
              leftCalls.push({ id: t.id, isCursor, isSelected, state });
              return <ListRow label={t.displayName} state={state} defaultLead="dot" />;
            },
          }}
          rightProps={{
            items: MODELS_BY_TOOL[leftId] ?? [],
            getKey: (m) => m.id,
            renderRow: (m, { isCursor }) => {
              const state = isCursor ? 'active' : 'default';
              rightCalls.push({ id: m.id, isCursor, state });
              return <ListRow label={m.displayName} state={state} defaultLead="dot" />;
            },
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

    const liveBar = glyph('liveBar', 'unicode');

    // Initial state: left column is active, 'Alpha' has active liveBar, 'alpha-1' is default
    let frame = ui.lastFrame() ?? '';
    expect(frame).toContain(`${liveBar} Alpha`);
    expect(frame).toContain('· alpha-1');
    expect(frame).not.toContain(`${liveBar} alpha-1`);
    expect(leftCalls.findLast((call) => call.id === 'alpha')).toEqual({
      id: 'alpha',
      isCursor: true,
      isSelected: false,
      state: 'active',
    });

    // Press right arrow into the models column
    ui.stdin.write('\u001B[C');
    await flushEffects();

    frame = ui.lastFrame() ?? '';
    // Previously-cursored left row still shows the liveBar glyph (dim variant: state 'context')
    expect(frame).toContain(`${liveBar} Alpha`);
    expect(leftCalls.findLast((call) => call.id === 'alpha')).toEqual({
      id: 'alpha',
      isCursor: false,
      isSelected: false,
      state: 'context',
    });

    // Right column shows its active cursor
    expect(frame).toContain(`${liveBar} alpha-1`);
    expect(frame).not.toContain('· alpha-1');

    // Press left arrow to return to the tools column
    ui.stdin.write('\u001B[D');
    await flushEffects();

    frame = ui.lastFrame() ?? '';
    // Left row returns to active-bar state and right row drops its cursor
    expect(frame).toContain(`${liveBar} Alpha`);
    expect(frame).toContain('· alpha-1');
    expect(frame).not.toContain(`${liveBar} alpha-1`);
    expect(leftCalls.findLast((call) => call.id === 'alpha')).toEqual({
      id: 'alpha',
      isCursor: true,
      isSelected: false,
      state: 'active',
    });

    ui.unmount();
  });

  it('fills the panel with 18 list rows at 30 terminal rows (capped by VISIBLE_ROWS_CAP)', async () => {
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
    expect(renderedRows).toHaveLength(18);
    expect(frame).toContain('Tool 17');
    expect(frame).not.toContain('Tool 18');
    ui.unmount();
  });

  it('renders one dim preview line resolving the focused item, and drops it at ≤50 cols', async () => {
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

  it('shows an overflow thumb and leaves a track beside the empty placeholder', async () => {
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
    const emptyFrame = empty.lastFrame() ?? '';
    expect(emptyFrame).toContain('No tools match');
    expect(emptyFrame).not.toContain(glyph('scrollThumb'));
    const placeholderLine =
      emptyFrame.split('\n').find((line) => line.includes('No tools match')) ?? '';
    expect(placeholderLine.endsWith(`${glyph('scrollTrack')} ${glyph('scrollTrack')}`)).toBe(false);
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
    { cols: 120, rows: 40, left: 3, right: 41, visible: 18, custom: false },
    { cols: 60, rows: 18, left: 3, right: 41, visible: 8, custom: false },
    { cols: 120, rows: 40, left: 9, right: 9, visible: 9, custom: false },
    { cols: 120, rows: 40, left: 3, right: 9, visible: 9, custom: true },
  ])(
    'shows $visible list rows at $cols x $rows with $left left and $right right slots (custom row: $custom)',
    async ({ cols, rows, left, right, visible, custom }) => {
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

  it('keeps the custom launcher naming its own verb while a row is expanded', async () => {
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
          isExpanded: true,
          expandedHint: () => undefined,
          customRow: { onSelect: () => {} },
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flushEffects();

    ui.stdin.write('\u001B[A'); // onto the pinned launcher
    await flushEffects();
    const hint = (ui.lastFrame() ?? '').split('\n').find((line) => line.includes('esc collapse'));

    expect(hint).toContain('⏎ add custom');
    expect(hint).not.toContain('choose route');
    ui.unmount();
  });

  it('keeps the expanded axis hint on one row at 60 columns', async () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: true });
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
          isExpanded: true,
          expandedHint: () => 'space cycle · ⏎ confirm',
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
    const hint = (hintRows[0] ?? '').trim();
    expect(getTerminalCellWidth(hint)).toBeLessThanOrEqual(
      overlayWidth({ cols: 60, density: 'wide' }),
    );
    // Truncation eats the tail, so both keys have to be written before the verbs.
    expect(hint).toContain('space cycle');
    expect(hint).toContain('⏎ confirm');
    ui.unmount();
  });

  it('yields byte-identical column-frame height when mounted with a 5-model tool vs a 40-model tool at the same terminal size', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const models5: Model[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m5-${i}`,
      displayName: `Model 5-${i}`,
    }));
    const models40: Model[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m40-${i}`,
      displayName: `Model 40-${i}`,
    }));

    function makePicker(models: Model[]) {
      return (
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: TOOLS,
            getKey: (t) => t.id,
            renderRow: (t) => <Text>{t.displayName}</Text>,
          }}
          rightProps={{
            items: models,
            getKey: (m) => m.id,
            renderRow: (m) => <Text>{m.displayName}</Text>,
          }}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );
    }

    const ui5 = renderFeature(makePicker(models5), { cols: 120, rows: 40 });
    await tick(20);
    const frame5 = ui5.lastFrame() ?? '';
    const lines5 = frame5.split('\n');
    ui5.unmount();

    const ui40 = renderFeature(makePicker(models40), { cols: 120, rows: 40 });
    await tick(20);
    const frame40 = ui40.lastFrame() ?? '';
    const lines40 = frame40.split('\n');
    ui40.unmount();

    expect(lines5).toHaveLength(lines40.length);

    const open5 = lines5.findIndex((line) => line.includes('╭'));
    const close5 = lines5.findIndex((line) => line.includes('╰'));
    const height5 = close5 - open5 + 1;

    const open40 = lines40.findIndex((line) => line.includes('╭'));
    const close40 = lines40.findIndex((line) => line.includes('╰'));
    const height40 = close40 - open40 + 1;

    expect(height5).toBe(22);
    expect(height40).toBe(22);
    expect(height5).toBe(height40);
  });

  it('occupies the same 2 rows for the preview region whether or not a preview exists across selection change', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const toolsWithPreview: Tool[] = [
      { id: 'with-prev', displayName: 'Tool With Preview' },
      { id: 'without-prev', displayName: 'Tool Without Preview' },
    ];

    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: toolsWithPreview,
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
        preview={(ctx) =>
          ctx.leftItem?.id === 'with-prev' ? 'Active preview text content' : undefined
        }
      />,
      { cols: 120, rows: 40 },
    );
    await flushEffects();

    const frameWith = ui.lastFrame() ?? '';
    expect(frameWith).toContain('Active preview text content');
    const linesWith = frameWith.split('\n');

    ui.stdin.write('\u001B[B');
    await flushEffects();

    const frameWithout = ui.lastFrame() ?? '';
    expect(frameWithout).not.toContain('Active preview text content');
    const linesWithout = frameWithout.split('\n');

    expect(linesWith).toHaveLength(linesWithout.length);

    const closeIdxWith = linesWith.findIndex((line) => line.includes('╰'));
    const hintIdxWith = linesWith.findIndex((line) => line.includes('←→ column'));
    const closeIdxWithout = linesWithout.findIndex((line) => line.includes('╰'));
    const hintIdxWithout = linesWithout.findIndex((line) => line.includes('←→ column'));

    expect(hintIdxWith - closeIdxWith).toBe(4);
    expect(hintIdxWithout - closeIdxWithout).toBe(4);
    expect(hintIdxWith - closeIdxWith).toBe(hintIdxWithout - closeIdxWithout);

    ui.unmount();
  });

  it('renders styled uppercase headers with leading horizontal rule and spacer rows, and skips them during cursor navigation', async () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
    const sectionedModels: Array<Model & { section: string }> = [
      { id: 'm-1', displayName: 'Model 1', section: 'First Section' },
      { id: 'm-2', displayName: 'Model 2', section: 'First Section' },
      { id: 'm-3', displayName: 'Model 3', section: 'Second Section' },
      { id: 'm-4', displayName: 'Model 4', section: 'Second Section' },
    ];
    const confirms: Array<{ l: string; r: string | null }> = [];

    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model & { section: string }>
        title="Picker"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: sectionedModels,
          getKey: (m) => m.id,
          section: { by: (m) => m.section },
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={(l, r) => {
          confirms.push({ l: l.id, r: r?.id ?? null });
        }}
        onCancel={() => {}}
      />,
      { cols: 120, rows: 40 },
    );
    await flushEffects();

    const rule = `${glyph('divider')}${glyph('divider')}`;
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(`${rule} FIRST SECTION`);
    expect(frame).toContain(`${rule} SECOND SECTION`);

    // Navigating down from Model 2 to Model 3 skips the spacer and header
    ui.stdin.write('\u001B[B'); // down to m-2
    await flushEffects();
    ui.stdin.write('\u001B[B'); // down to m-3 (skips spacer + header)
    await flushEffects();
    ui.stdin.write('\r'); // confirm
    await tick(20);

    expect(confirms).toEqual([{ l: 'alpha', r: 'm-3' }]);

    // Navigating up from Model 3 to Model 2 skips header and spacer
    ui.stdin.write('\u001B[A'); // up to m-2 (skips header + spacer)
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(confirms.at(-1)).toEqual({ l: 'alpha', r: 'm-2' });

    ui.unmount();
  });

  it('precedes the first section header with a spacer when a row already occupies a slot', () => {
    const withPreceding = buildRightDisplay([{ id: 'auto' }, { id: 'm-1' }], (item) => item.id, {
      by: (item) => (item.id === 'auto' ? '' : 'Catalog'),
    });
    expect(withPreceding.map((slot) => slot.kind)).toEqual(['row', 'spacer', 'header', 'row']);

    const headerFirst = buildRightDisplay([{ id: 'm-1' }], (item) => item.id, {
      by: () => 'Catalog',
    });
    expect(headerFirst.map((slot) => slot.kind)).toEqual(['header', 'row']);
  });

  it('keeps one header for a section an expansion interrupts', () => {
    const rows = [{ id: 'm-1' }, { id: 'm-1:route-a' }, { id: 'm-1:route-b' }, { id: 'm-2' }];
    const display = buildRightDisplay(rows, (item) => item.id, {
      by: (item) => (item.id.includes(':') ? '' : 'Custom'),
    });
    expect(display.map((slot) => slot.kind)).toEqual(['header', 'row', 'row', 'row', 'row']);
  });

  it('renders launcher without dot lead while non-cursor model row has dot lead', async () => {
    const DOT_LEAD = '· ';
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => (
            <ListRow
              label={m.displayName}
              state={isCursor ? 'active' : 'default'}
              defaultLead="dot"
            />
          ),
          customRow: { onSelect: () => {} },
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flushEffects();

    const lines = (ui.lastFrame() ?? '').split('\n');
    const launcherLine = lines.find((line) => line.includes('+ Add custom model…')) ?? '';
    const realModelLine = lines.find((line) => line.includes('alpha-2')) ?? '';

    const rightCell = (line: string) => line.split('│')[3]?.trimStart() ?? '';
    expect(rightCell(launcherLine).startsWith(DOT_LEAD)).toBe(false);
    expect(rightCell(realModelLine).startsWith(DOT_LEAD)).toBe(true);
    ui.unmount();
  });
});
