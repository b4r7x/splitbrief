import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { TwoColumnPicker } from './picker.js';

interface Tool {
  id: string;
  displayName: string;
  disabled?: boolean;
}
interface Model {
  id: string;
}

const TOOLS: Tool[] = [
  { id: 'alpha', displayName: 'Alpha' },
  { id: 'beta', displayName: 'Beta', disabled: true },
];

const ARROW_DOWN = '\u001B[B';
const ENTER = '\r';

function renderPicker(handlers: {
  onConfirm?: ((left: Tool, right: Model | null) => void) | undefined;
  onLeftChange?: ((item: Tool) => void) | undefined;
}) {
  return renderFeature(
    <TwoColumnPicker<Tool, Model>
      title="Picker"
      leftProps={{
        items: TOOLS,
        getKey: (t) => t.id,
        isDisabled: (t) => !!t.disabled,
        renderRow: (t) => <Text>{t.displayName}</Text>,
      }}
      rightProps={{
        items: [{ id: 'model-1' }],
        getKey: (m) => m.id,
        renderRow: (m) => <Text>{m.id}</Text>,
        ...(handlers.onLeftChange ? { onLeftChange: handlers.onLeftChange } : {}),
      }}
      onConfirm={handlers.onConfirm ?? (() => {})}
      onCancel={() => {}}
    />,
  );
}

describe('TwoColumnPicker Enter on a disabled left row', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  it('neither confirms nor advances to the model column', async () => {
    const confirms: string[] = [];
    const leftChanges: string[] = [];
    const ui = renderPicker({
      onConfirm: (left) => {
        confirms.push(left.id);
      },
      onLeftChange: (item) => {
        leftChanges.push(item.id);
      },
    });
    await vi.waitFor(
      () => {
        expect(leftChanges.at(-1)).toBe('alpha');
      },
      { timeout: 5_000 },
    );
    await flushEffects();

    ui.stdin.write(ARROW_DOWN); // -> beta (disabled)
    await vi.waitFor(
      () => {
        expect(leftChanges.at(-1)).toBe('beta');
      },
      { timeout: 5_000 },
    );
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

    expect(confirms).toEqual([]);
    // The cursor stayed in the tool column: another Enter still confirms nothing.
    ui.stdin.write(ENTER);
    await flushEffects();
    expect(confirms).toEqual([]);
    ui.unmount();
  });
});
