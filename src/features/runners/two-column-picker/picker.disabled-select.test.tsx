import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { useLayoutEffect, useState } from 'react';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, type RenderFeatureResult } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { TwoColumnPicker } from './picker.js';

interface Tool {
  id: string;
  displayName: string;
  disabled?: boolean;
  pane?: boolean;
}
interface Model {
  id: string;
}

const TOOLS: Tool[] = [
  { id: 'alpha', displayName: 'Alpha' },
  { id: 'beta', displayName: 'Beta', disabled: true },
  { id: 'gamma', displayName: 'Gamma' },
  { id: 'delta', displayName: 'Delta', pane: true },
];

const VIEWPORT = { cols: 100, rows: 24 };
const ESC = '\u001B';
const ARROW_DOWN = `${ESC}[B`;
const ARROW_LEFT = `${ESC}[D`;
const ENTER = '\r';

interface PickerOptions {
  onConfirm?: ((left: Tool, right: Model | null) => void) | undefined;
  onLeftChange?: ((item: Tool) => void) | undefined;
  onCancel?: (() => void) | undefined;
  initialColumn?: 'left' | 'right' | undefined;
  initialIndex?: number | undefined;
  isDisabled?: ((tool: Tool) => boolean) | undefined;
}

function picker(options: PickerOptions) {
  return (
    <TwoColumnPicker<Tool, Model>
      title="Picker"
      initialColumn={options.initialColumn}
      leftProps={{
        items: TOOLS,
        getKey: (t) => t.id,
        isDisabled: options.isDisabled ?? ((t) => !!t.disabled),
        terminalPane: (t) => (t.pane ? { label: 'Ready', verb: 'use', lines: [] } : undefined),
        initialIndex: options.initialIndex,
        renderRow: (t, { isCursor, isSelected, isContext }) => (
          <Text>{`${isCursor ? '>' : isContext ? '*' : ' '}${isSelected ? '+' : ' '}${t.displayName}`}</Text>
        ),
      }}
      rightProps={{
        items: [{ id: 'model-1' }],
        getKey: (m) => m.id,
        renderRow: (m) => <Text>{m.id}</Text>,
        ...(options.onLeftChange ? { onLeftChange: options.onLeftChange } : {}),
      }}
      onConfirm={options.onConfirm ?? (() => {})}
      onCancel={options.onCancel ?? (() => {})}
    />
  );
}

function renderPicker(options: PickerOptions) {
  return renderFeature(picker(options), VIEWPORT);
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
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('alpha');
    });
    await flushEffects();

    ui.stdin.write(ARROW_DOWN); // -> beta (disabled)
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('beta');
    });
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

  it('offers only the keys that act on a disabled row', async () => {
    const leftChanges: string[] = [];
    const ui = renderPicker({
      onLeftChange: (item) => {
        leftChanges.push(item.id);
      },
    });
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('alpha');
    });
    await flushEffects();
    expect(ui.lastFrame()).toContain('←→ column · ↑↓ select · ⏎ confirm · esc cancel');

    ui.stdin.write(ARROW_DOWN); // -> beta (disabled)
    await vi.waitFor(() => {
      expect(leftChanges.at(-1)).toBe('beta');
    });
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('↑↓ select · esc cancel');
    expect(frame).not.toContain('←→ column');
    expect(frame).not.toContain('⏎ confirm');
    ui.unmount();
  });
});

describe('TwoColumnPicker model column on a tool with no model list', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  const frameOf = (ui: RenderFeatureResult) => stripAnsiStyles(ui.lastFrame());

  function record() {
    const log = { confirms: [] as string[], cancels: 0, leftChanges: [] as string[] };
    const handlers: PickerOptions = {
      onConfirm: (left, right) => log.confirms.push(`${left.id}:${right?.id ?? 'none'}`),
      onCancel: () => {
        log.cancels += 1;
      },
      onLeftChange: (item) => log.leftChanges.push(item.id),
    };
    return { log, handlers };
  }

  async function open(options: PickerOptions, landsOn: string) {
    const { log, handlers } = record();
    const ui = renderPicker({ ...handlers, ...options });
    await vi.waitFor(() => expect(log.leftChanges.at(-1)).toBe(landsOn));
    await flushEffects();
    return { ui, log, handlers };
  }

  async function press(ui: RenderFeatureResult, keys: string[]) {
    for (const key of keys) {
      ui.stdin.write(key);
      await flushEffects();
    }
  }

  async function clickTool(id: string) {
    const click = collectClickableZones(VIEWPORT).get(`runner-left:${id}`);
    if (click === undefined) throw new Error(`no click zone runner-left:${id}`);
    click();
    await flushEffects();
  }

  /** The frames that ← and ↓ onto Beta give from the model column, then one frame per key after. */
  async function keyboardFrames(after: string[]) {
    const { ui } = await open({ initialColumn: 'right' }, 'alpha');
    await press(ui, [ARROW_LEFT, ARROW_DOWN]);
    const frames = [frameOf(ui)];
    for (const key of after) {
      await press(ui, [key]);
      frames.push(frameOf(ui));
    }
    ui.unmount();
    _resetMouseZones();
    return frames;
  }

  it('a click on the disabled tool, then ⏎, confirms nothing and draws what ← ↓ draw', async () => {
    const [onBeta] = await keyboardFrames([]);
    const { ui, log } = await open({ initialColumn: 'right' }, 'alpha');

    await clickTool('beta');
    await press(ui, [ENTER]);

    expect(onBeta).toContain('> Beta');
    expect(log.confirms).toEqual([]);
    expect(frameOf(ui)).toBe(onBeta);
    ui.unmount();
  });

  it('a click on the disabled tool, then ↓, moves the tool cursor to the next tool', async () => {
    const [, onGamma] = await keyboardFrames([ARROW_DOWN]);
    const { ui, log } = await open({ initialColumn: 'right' }, 'alpha');

    await clickTool('beta');
    await press(ui, [ARROW_DOWN]);

    expect(onGamma).toContain('> Gamma');
    expect(log.leftChanges.at(-1)).toBe('gamma');
    expect(frameOf(ui)).toBe(onGamma);
    ui.unmount();
  });

  it('a click on the disabled tool, then a letter and Esc, act on the tool query on the screen', async () => {
    const [, typed, cleared] = await keyboardFrames(['b', ESC]);
    const { ui, log } = await open({ initialColumn: 'right' }, 'alpha');

    await clickTool('beta');
    await press(ui, ['b']);
    expect(frameOf(ui)).toBe(typed);
    // The first Esc clears the query the letter put in the tool column; the second cancels.
    await press(ui, [ESC]);
    expect(frameOf(ui)).toBe(cleared);
    expect(log.cancels).toBe(0);
    await press(ui, [ESC]);

    expect(log.cancels).toBe(1);
    ui.unmount();
  });

  it('confirms nothing on ⏎ after the parent disables the tool under the model column', async () => {
    const { ui, log, handlers } = await open({ initialColumn: 'right' }, 'alpha');

    ui.rerender(
      picker({
        ...handlers,
        initialColumn: 'right',
        isDisabled: (t) => t.id === 'alpha' || !!t.disabled,
      }),
    );
    await flushEffects();
    await press(ui, [ENTER]);

    expect(log.confirms).toEqual([]);
    ui.unmount();
  });

  it('opens on a disabled tool with the keys in the tool list', async () => {
    const [onBeta] = await keyboardFrames([]);
    const { ui, log } = await open({ initialColumn: 'right', initialIndex: 1 }, 'beta');

    await press(ui, [ENTER]);

    expect(log.confirms).toEqual([]);
    expect(frameOf(ui)).toBe(onBeta);
    ui.unmount();
  });

  it('opens on a tool with a pane with the keys in the tool list, so ⏎ confirms the tool alone', async () => {
    const { ui, log } = await open({ initialColumn: 'right', initialIndex: 3 }, 'delta');

    await press(ui, [ENTER]);

    expect(log.confirms).toEqual(['delta:none']);
    ui.unmount();
  });
});

describe('TwoColumnPicker model column when the parent reorders the tools', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  const BETA: Tool = { id: 'beta', displayName: 'Beta', disabled: true };
  const ALPHA: Tool = { id: 'alpha', displayName: 'Alpha' };
  const GAMMA: Tool = { id: 'gamma', displayName: 'Gamma' };
  const BEFORE = [BETA, ALPHA, GAMMA];
  const AFTER = [ALPHA, BETA, GAMMA];

  function reorderPicker(tools: Tool[], log: string[]) {
    return (
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        initialColumn="right"
        leftProps={{
          items: tools,
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          initialIndex: 1,
          renderRow: (t, { isCursor, isContext }) => (
            <Text>{`${isCursor ? '>' : isContext ? '*' : ' '}${t.displayName}`}</Text>
          ),
        }}
        rightProps={{
          items: [{ id: 'm-1' }, { id: 'm-2' }],
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.id}`}</Text>,
          onLeftChange: (t) => log.push(`left ${t.id}`),
        }}
        onConfirm={(left, right) => log.push(`confirm ${left.id}:${right?.id ?? 'none'}`)}
        onCancel={() => log.push('cancel')}
      />
    );
  }

  it('keeps the keys on the model column of the highlighted tool, so ↓ and ⏎ act on it', async () => {
    const log: string[] = [];
    const ui = renderFeature(reorderPicker(BEFORE, log), VIEWPORT);
    await vi.waitFor(() => expect(log).toEqual(['left alpha']));
    await flushEffects();
    const start = ui.frames.length;

    ui.rerender(reorderPicker(AFTER, log));
    await flushEffects();

    const reordered = ui.frames.slice(start).map(stripAnsiStyles);
    expect(reordered.length).toBeGreaterThan(0);
    expect(
      reordered.filter((frame) => !frame.includes('*Alpha') || !frame.includes('>m-1')),
    ).toEqual([]);
    ui.stdin.write(ARROW_DOWN);
    await vi.waitFor(() => expect(stripAnsiStyles(ui.lastFrame())).toContain('>m-2'));
    expect(stripAnsiStyles(ui.lastFrame())).toContain('*Alpha');
    ui.stdin.write(ENTER);
    await vi.waitFor(() => expect(log.at(-1)).toBe('confirm alpha:m-2'));

    expect(log).toEqual(['left alpha', 'confirm alpha:m-2']);
    ui.unmount();
  });

  /** The parent holds the tools in state, so a reorder and a key can land in one render. */
  function mountReorderParent(log: string[]) {
    let reorder: ((tools: Tool[]) => void) | undefined;
    const commits: { order: string; logAtRender: string[]; log: string[] }[] = [];
    function Parent() {
      const [tools, setTools] = useState(BEFORE);
      reorder = setTools;
      const logAtRender = [...log];
      useLayoutEffect(() => {
        commits.push({ order: tools.map((t) => t.id).join(','), logAtRender, log: [...log] });
      });
      return reorderPicker(tools, log);
    }
    const ui = renderFeature(<Parent />, VIEWPORT);
    return {
      ui,
      commits,
      reorder: (tools: Tool[]) => {
        if (reorder === undefined) throw new Error('the parent has not rendered');
        reorder(tools);
      },
    };
  }

  for (const order of ['reorder first', '⏎ first'] as const) {
    it(`confirms the highlighted tool on ⏎ that lands in the render of the reorder (${order})`, async () => {
      const log: string[] = [];
      const { ui, commits, reorder } = mountReorderParent(log);
      await vi.waitFor(() => expect(log).toEqual(['left alpha']));
      await flushEffects();
      const framesBefore = ui.frames.length;

      if (order === 'reorder first') {
        reorder(AFTER);
        ui.stdin.write(ENTER);
      } else {
        ui.stdin.write(ENTER);
        reorder(AFTER);
      }
      expect(ui.frames.length).toBe(framesBefore);
      await vi.waitFor(() =>
        expect(commits.some((c) => c.order === 'alpha,beta,gamma')).toBe(true),
      );
      await flushEffects();

      expect(commits.find((c) => c.order === 'alpha,beta,gamma')).toEqual({
        order: 'alpha,beta,gamma',
        logAtRender: ['left alpha'],
        log: ['left alpha', 'confirm alpha:m-1'],
      });
      expect(log).toEqual(['left alpha', 'confirm alpha:m-1']);
      ui.unmount();
    });
  }
});
