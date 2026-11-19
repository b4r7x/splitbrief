import { Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { TwoColumnPicker } from './picker.js';
import type { TerminalPane } from './types.js';

const viewport = { cols: 80, rows: 18 };
const tools = [
  { id: 'alpha', displayName: 'Alpha' },
  { id: 'beta', displayName: 'Beta' },
];
const models = [{ id: 'opal' }, { id: 'onyx' }];

function resize(cols: number) {
  terminalSizeStore.__testReset({ ...viewport, cols, isSmall: true });
}

function mount(
  options: {
    cols?: number;
    initial?: 'left' | 'right';
    pane?: TerminalPane;
    empty?: boolean;
    expanded?: boolean;
  } = {},
) {
  const cancel = vi.fn();
  const collapse = vi.fn();
  const confirm = vi.fn();
  resize(options.cols ?? 79);
  const ui = renderFeature(
    <TwoColumnPicker
      title="PLAN"
      initialColumn={options.initial}
      leftProps={{
        label: 'Tools',
        items: tools,
        getKey: (tool) => tool.id,
        isDisabled: (tool) => tool.id === 'alpha' && options.pane !== undefined,
        terminalPane: (tool) => (tool.id === 'alpha' ? options.pane : undefined),
        renderRow: (tool) => <Text>{tool.displayName}</Text>,
      }}
      rightProps={{
        label: 'Models',
        isExpanded: options.expanded,
        onCollapse: collapse,
        items: options.empty ? [] : models,
        getKey: (model) => model.id,
        placeholder: <Text>Refresh the model catalog.</Text>,
        renderRow: (model, { isCursor }) => (
          <Text>
            {isCursor ? '▌ ' : ''}
            {model.id}
          </Text>
        ),
      }}
      onCancel={cancel}
      onConfirm={confirm}
    />,
    viewport,
  );
  const frame = () => ui.lastFrame() ?? '';
  const send = async (key: string) => {
    ui.stdin.write(key);
    await flushEffects();
  };
  return { ui, cancel, confirm, collapse, frame, send };
}

describe('single-pane tool picker', () => {
  beforeEach(() => {
    resetAllStores();
    forceUnicodeGlyphs();
    _resetMouseZones();
  });

  it('marks only the focused filter and keeps both queries visible at 80 columns', async () => {
    const { ui, frame, send } = mount({ cols: 80 });
    try {
      await flushEffects();
      await send('alp');
      const toolsFilter = frame()
        .split('\n')
        .find((line) => line.includes('› alp'));
      expect(toolsFilter).toContain('  Type to filter');
      expect(toolsFilter).not.toContain('› Type to filter');
      await send('\u001b[C');
      await send('on');
      const modelsFilter = frame()
        .split('\n')
        .find((line) => line.includes('› on'));
      expect(modelsFilter).toContain('  alp');
      expect(modelsFilter).not.toContain('› alp');
      await send('\u001b[D');
      const toolsAgain = frame()
        .split('\n')
        .find((line) => line.includes('› alp'));
      expect(toolsAgain).toContain('  on');
      expect(toolsAgain).not.toContain('› on');
    } finally {
      ui.unmount();
    }
  });

  it('shows one list at 79, both at 80, and keeps the active model and query on resize', async () => {
    const { ui, frame, send } = mount();
    try {
      await flushEffects();
      expect(frame()).not.toContain('opal');
      await send('\u001b[C');
      await send('on');
      expect(frame()).toContain('▌ onyx');
      expect(frame()).toContain('Models · Alpha');
      expect(frame()).not.toContain('Beta');
      resize(80);
      await flushEffects();
      expect(frame()).toContain('Beta');
      expect(frame()).toContain('▌ onyx');
      resize(79);
      await flushEffects();
      expect(frame()).not.toContain('Beta');
      expect(frame()).toContain('▌ onyx');
    } finally {
      ui.unmount();
    }
  });

  it('returns from a deep model link after clearing the filter and exposes the same return target to the mouse', async () => {
    const { ui, frame, send, cancel } = mount({ initial: 'right' });
    const zones = () => collectClickableZones(viewport);
    try {
      await flushEffects();
      expect(frame()).toContain('Models · Alpha');
      expect([...zones().keys()].some((id) => id.startsWith('runner-left:'))).toBe(false);
      await send('on');
      await send('\u001b');
      expect(frame()).toContain('opal');
      await send('\u001b');
      expect(frame()).toContain('Beta');
      expect(cancel).not.toHaveBeenCalled();
      await send('\u001b[C');
      const back = zones().get('runner-back:alpha');
      expect(back).toBeDefined();
      back?.();
      await flushEffects();
      expect(frame()).toContain('Beta');
      expect([...zones().keys()].some((id) => id.startsWith('runner-right:'))).toBe(false);
      await send('\u001b');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      ui.unmount();
    }
  });

  it('keeps a hidden model expansion when navigating back and lets Escape close Tools', async () => {
    const { ui, send, frame, cancel, collapse } = mount({ initial: 'right', expanded: true });
    try {
      await flushEffects();
      expect(frame()).toContain('esc collapse');
      await send('\u001b[D');
      expect(frame()).toContain('Beta');
      expect(frame()).toContain('esc cancel');
      await send('\u001b');
      expect(cancel).toHaveBeenCalledOnce();
      expect(collapse).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  it('keeps the diagnostic beneath Tools and preserves disabled Enter at 60×18', async () => {
    const pane = {
      label: 'Unavailable',
      lines: [
        'Install Alpha, then refresh.',
        '',
        'Saved choice:',
        { whole: 'Alpha · saved-model' },
      ],
    };
    const { ui, frame, send, confirm } = mount({ cols: 60, initial: 'right', pane });
    try {
      await flushEffects();
      expect(
        frame()
          .split('\n')
          .find((line) => line.includes('Unavailable')),
      ).not.toContain('Tools');
      expect(frame()).toContain('Install Alpha, then refresh.');
      expect(frame()).toContain('Alpha · saved-model');
      await send('\u001b[C');
      await send('\r');
      expect(confirm).not.toHaveBeenCalled();
      expect(frame()).toContain('Unavailable');
      expect(frame().split('\n')).toHaveLength(18);
    } finally {
      ui.unmount();
    }
  });

  it('shows empty catalog guidance together with Tools without mounting a model list', async () => {
    const { ui, frame, send } = mount({ cols: 60, empty: true });
    try {
      await flushEffects();
      expect(frame()).toContain('Refresh the model catalog.');
      expect(frame().match(/Type to filter/g)).toHaveLength(1);
      await send('\u001b[C');
      expect(frame()).toContain('Beta');
    } finally {
      ui.unmount();
    }
  });
});
