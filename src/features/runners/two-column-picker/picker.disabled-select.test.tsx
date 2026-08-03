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
  onDisabledSelect?: ((item: Tool) => void) | undefined;
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
      onDisabledSelect={handlers.onDisabledSelect}
    />,
  );
}

describe('TwoColumnPicker onDisabledSelect', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  it('fires onDisabledSelect instead of onConfirm on Enter on a disabled left row', async () => {
    const confirms: string[] = [];
    const disabledSelects: string[] = [];
    const leftChanges: string[] = [];
    const ui = renderPicker({
      onConfirm: (left) => {
        confirms.push(left.id);
      },
      onDisabledSelect: (item) => {
        disabledSelects.push(item.id);
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
    await vi.waitFor(
      () => {
        expect(disabledSelects).toEqual(['beta']);
      },
      { timeout: 5_000 },
    );

    expect(confirms).toEqual([]);
    ui.unmount();
  });

  it('does not fire onDisabledSelect for Enter on an enabled row or in the right column', async () => {
    const confirms: string[] = [];
    const disabledSelects: string[] = [];
    const leftChanges: string[] = [];
    const ui = renderPicker({
      onConfirm: (left, right) => {
        confirms.push(`${left.id}:${right?.id ?? 'none'}`);
      },
      onDisabledSelect: (item) => {
        disabledSelects.push(item.id);
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

    ui.stdin.write(ENTER); // enabled alpha -> focus right
    await flushEffects();
    ui.stdin.write(ENTER); // right column -> confirm
    await vi.waitFor(
      () => {
        expect(confirms).toEqual(['alpha:model-1']);
      },
      { timeout: 5_000 },
    );
    expect(disabledSelects).toEqual([]);
    ui.unmount();
  });
});
