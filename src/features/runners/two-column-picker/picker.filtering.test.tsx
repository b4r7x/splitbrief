import { beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { filterByFields } from '../../../components/pickers/filtering.js';
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

const ALPHA_MODELS: Model[] = [
  { id: 'a-1', displayName: 'alpha-1' },
  { id: 'a-2', displayName: 'alpha-2' },
];

const BACKSPACE = '\u007f';
const ESC = '\u001B';
const DOWN = '\u001B[B';

const LAUNCHER: Tool = { id: 'add-custom', displayName: '+ Add custom command…' };

function launcherPicker(opts: {
  initialIndex: number;
  onConfirm?: (left: Tool, right: Model | null) => void;
}) {
  return (
    <TwoColumnPicker<Tool, Model>
      title="Picker"
      leftProps={{
        items: [...TOOLS, LAUNCHER],
        getKey: (t) => t.id,
        isDisabled: (t) => !!t.disabled,
        isSpecial: (t) => t.id === LAUNCHER.id,
        filterBy: (t, query) =>
          t.id === LAUNCHER.id || filterByFields(t, query, ['id', 'displayName']),
        initialIndex: opts.initialIndex,
        renderRow: (t, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>,
      }}
      rightProps={{
        items: [],
        getKey: (m) => m.id,
        renderRow: (m) => <Text>{m.displayName}</Text>,
      }}
      onConfirm={opts.onConfirm ?? (() => {})}
      onCancel={() => {}}
    />
  );
}

function customRowPicker(opts: {
  onConfirm?: (left: Tool, right: Model | null) => void;
  onCancel?: () => void;
  onCustomSelect?: (left: Tool) => void;
}) {
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
        items: ALPHA_MODELS,
        getKey: (m) => m.id,
        renderRow: (m) => <Text>{m.displayName}</Text>,
        customRow: { onSelect: opts.onCustomSelect ?? (() => {}) },
      }}
      onConfirm={opts.onConfirm ?? (() => {})}
      onCancel={opts.onCancel ?? (() => {})}
    />
  );
}

describe('TwoColumnPicker type-anywhere filtering', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  it('narrows continuously as each character is typed, then confirms with zero arrow presses', async () => {
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
            renderRow: (t, { isCursor }) => (
              <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>
            ),
          }}
          rightProps={{
            items: leftId === 'alpha' ? ALPHA_MODELS : [],
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

    ui.stdin.write('a'); // matches Alpha, Beta, Gamma
    await flushEffects();
    expect(ui.lastFrame()).toContain('Beta');

    await flushEffects();
    ui.stdin.write('l'); // 'al' narrows to Alpha with no arrow press in between
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('>Alpha');
    expect(frame).not.toContain('Beta');
    expect(frame).not.toContain('Gamma');

    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual([{ l: 'alpha', r: 'a-1' }]);
    ui.unmount();
  });

  it('typing while the cursor sits on the launcher row filters the list above it', async () => {
    const ui = renderFeature(launcherPicker({ initialIndex: 3 }));
    await flushEffects();
    expect(ui.lastFrame()).toContain('>+ Add custom command…');

    await flushEffects();
    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('l');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('>Alpha');
    expect(frame).not.toContain('Gamma');
    expect(frame).toContain('+ Add custom command…');
    ui.unmount();
  });

  it('keeps the launcher visible and confirmable under a non-matching query', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    const ui = renderFeature(
      launcherPicker({
        initialIndex: 0,
        onConfirm: (l, r) => {
          confirms.push({ l: l.id, r: r?.id ?? null });
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('z');
    await flushEffects();
    ui.stdin.write('z');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Alpha');
    expect(frame).toContain('>+ Add custom command…');

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual([{ l: 'add-custom', r: null }]);
    ui.unmount();
  });

  it('backspace widens the match set', async () => {
    const ui = renderFeature(customRowPicker({}));
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('l');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('Beta');

    await flushEffects();
    ui.stdin.write(BACKSPACE);
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Beta');
    expect(frame).toContain('Gamma');
    ui.unmount();
  });

  it('Escape clears a non-empty left filter; the next Escape cancels', async () => {
    let cancelled = 0;
    const ui = renderFeature(
      customRowPicker({
        onCancel: () => {
          cancelled++;
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('l');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('Beta');

    await flushEffects();
    ui.stdin.write(ESC);
    await flushEffects();
    expect(cancelled).toBe(0);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Beta');
    expect(frame).toContain('Gamma');

    await flushEffects();
    ui.stdin.write(ESC);
    await tick(20);
    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('typing in the right column lands on the first match past the custom row and Enter confirms it', async () => {
    const confirms: Array<string | null> = [];
    const ui = renderFeature(
      customRowPicker({
        onConfirm: (_l, r) => {
          confirms.push(r?.id ?? null);
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('\r'); // focus right on the first model past the custom row
    await flushEffects();
    ui.stdin.write('2'); // only a-2 matches
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('+ Add custom model…');
    expect(frame).not.toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual(['a-2']);
    ui.unmount();
  });

  it('a right query with no matches falls back onto the custom row; Escape clears it before cancelling', async () => {
    let cancelled = 0;
    const opened: string[] = [];
    const ui = renderFeature(
      customRowPicker({
        onCancel: () => {
          cancelled++;
        },
        onCustomSelect: (l) => {
          opened.push(l.id);
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('z');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('\r'); // Enter on the custom row opens the custom-model flow
    await flushEffects();
    expect(opened).toEqual(['alpha']);

    await flushEffects();
    ui.stdin.write(ESC); // clears the query instead of cancelling
    await flushEffects();
    expect(cancelled).toBe(0);
    expect(ui.lastFrame()).toContain('alpha-1');

    await flushEffects();
    ui.stdin.write(ESC);
    await tick(20);
    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('down-arrow reaches the last model past the custom row', async () => {
    const confirms: Array<string | null> = [];
    const ui = renderFeature(
      customRowPicker({
        onConfirm: (_l, r) => {
          confirms.push(r?.id ?? null);
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('\r'); // focus right on a-1
    await flushEffects();
    ui.stdin.write(DOWN); // a-2, past the end of the filterable items
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(confirms).toEqual(['a-2']);
    ui.unmount();
  });
});
