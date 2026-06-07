import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Text } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
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
  beforeEach(() => resetAllStores());

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

    ui.stdin.write('\u001B[B'); // ↓ → 'beta' (disabled)
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('beta');
    });

    ui.stdin.write('\r'); // Enter on disabled — no-op
    await tick(20);
    expect(confirms).toEqual([]);

    ui.stdin.write('\u001B[B'); // ↓ → 'gamma'
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
    await tick(20);
    expect(ui.lastFrame()).toContain('alpha-1');

    ui.stdin.write('\r'); // Enter left → focus right
    await tick(20);
    ui.stdin.write('\r'); // Enter right → confirm
    await tick(20);

    expect(confirms).toEqual([{ l: 'alpha', r: 'a-1' }]);
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

    ui.stdin.write('\u001B[C'); // → with no left item
    await tick(20);
    ui.stdin.write('\u001B'); // Escape
    await tick(20);

    expect(cancelled).toBe(1);
    ui.unmount();
  });
});
