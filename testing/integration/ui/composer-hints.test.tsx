import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { getTerminalCellWidth } from '../../../src/utils/display-text.js';
import { getTheme } from '../../../src/components/theme.js';
import {
  compactComposerHints,
  composerHintZoneRects,
  computeComposerHintBudget,
} from '../../../src/components/composer/hint-zones.js';
import { Composer } from '../../../src/components/composer/composer.js';
import { hitTopmostZone, _resetMouseZones } from '../../../src/lib/terminal/mouse-zones.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';
import { prepareWorkflowExecution } from '#testing/helpers/workflow-screen.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

// A unique directory per run: session preparation allocates the session directory and refuses to
// reallocate one, so a fixed path would fail every run after the first.
const PROJECT_DIR = createTempDir('composer-hints-project');

const WORKFLOW_ROUTE = {
  screen: 'workflow',
  execution: {
    kind: 'local',
    prepared: prepareWorkflowExecution({
      projectDir: PROJECT_DIR,
      feature: 'demo',
      sessionId: 'composer-hints-session',
    }),
  },
} as const;

afterAll(() => {
  cleanupTempDir(PROJECT_DIR);
});

const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

function colorOpen(color: string): string {
  const ui = render(<Text color={color}>x</Text>);
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  const prefix = frame.slice(0, frame.indexOf('x'));
  if (!prefix) throw new Error(`no color prefix rendered for ${color}`);
  return prefix;
}

function ansiRunEnclosing(frame: string, literal: string): string {
  const index = frame.indexOf(literal);
  if (index < 0) throw new Error(`expected frame to contain ${literal}`);
  const before = frame.slice(0, index);
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const runs = [...before.matchAll(ansiPattern)].map((match) => match[0]);
  return runs.at(-1) ?? '';
}

function expectFrameUsesThemeColor(raw: string, color: string, literal: string): void {
  const prefix = colorOpen(color);
  expect(ansiRunEnclosing(raw, literal)).toBe(prefix);
}

describe('composer in-box footer hints', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders override keys and the cost token inside the rounded box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: 'Ctrl+D diff', cost: '$0.03', costTone: 'text' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+D diff');
    expect(frame).not.toContain('tab');
    expect(frame).toContain('$0.03');
    ui.unmount();
  });

  it('renders warning-toned cost beside override keys in question mode', async () => {
    const cost = '$0.41';
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: '',
      boxHints: { keys: 'Ctrl+D diff', cost, costTone: 'warning' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(cost);
    expectFrameUsesThemeColor(frame, getTheme().warning, cost);

    ui.unmount();
  });
});

describe('composer integration: in-box hint click zones fire store actions', () => {
  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    routerStore.init(WORKFLOW_ROUTE);
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: false });
  });

  it('clicking the cost hint opens cost-drilldown', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: 80 }),
    );
    const rects = composerHintZoneRects({ boxLeft: 1, boxWidth: 80, hintRow: 18, display });
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!costRect) throw new Error('expected cost hint zone to be present');

    const costZone = hitTopmostZone(costRect.left, costRect.top);
    expect(costZone?.id).toBe('composer-hint-cost');
    costZone?.onClick?.();
    await flushEffects();
    expect(overlayStore.get().active).toBe('cost-drilldown');

    ui.unmount();
  });

  it('aligns the cost zone with the flush inputPaddingX=0 workflow composer hint', async () => {
    const cost = '$0.41';
    const ui = renderFeature(
      <Box flexDirection="column" height={20} justifyContent="flex-end" width={80}>
        <Composer
          commands={COMMANDS}
          currentScreen="workflow"
          mode="normal"
          hint=""
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
          boxHints={{ keys: 'Ctrl+G', cost }}
          inputPaddingX={0}
        />
      </Box>,
    );

    await flushEffects();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const hintRowIndex = lines.findIndex((line) => line.includes(cost));
    if (hintRowIndex < 0) throw new Error('expected cost hint text in the rendered frame');
    const hintLine = lines[hintRowIndex];
    if (hintLine === undefined) throw new Error('expected cost hint row in the rendered frame');
    const costIndex = hintLine.indexOf(cost);
    if (costIndex < 0) throw new Error('expected cost hint column in the rendered frame');
    const actualColumn = getTerminalCellWidth(hintLine.slice(0, costIndex)) + 1;
    const hintRow = terminalSizeStore.get().rows - 2;

    expect(hitTopmostZone(actualColumn, hintRow)?.id).toBe('composer-hint-cost');
    expect(hitTopmostZone(actualColumn - 1, hintRow)?.id).not.toBe('composer-hint-cost');

    ui.unmount();
  });

  it('registers no cost zone when the cost is compacted away (no phantom hotspot)', async () => {
    terminalSizeStore.__testReset({ cols: 36, rows: 20, isSmall: false });
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: 36 }),
    );
    expect(display.cost).toBeUndefined();
    const rects = composerHintZoneRects({ boxLeft: 1, boxWidth: 36, hintRow: 18, display });
    expect(rects).toEqual([]);
    expect(hitTopmostZone(34, 18)).toBeUndefined();

    ui.unmount();
  });
});

describe('composer review-column hint zones register against the inset box', () => {
  const REVIEW_WIDTH = 50;
  const REVIEW_LEFT_OFFSET = 12;

  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    routerStore.init(WORKFLOW_ROUTE);
    terminalSizeStore.__testReset({ cols: 120, rows: 20, isSmall: false });
  });

  it('shifts the cost zone by boxLeftOffset so a review-column click lands on the box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
      width: REVIEW_WIDTH,
      boxLeftOffset: REVIEW_LEFT_OFFSET,
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: REVIEW_WIDTH }),
    );
    const rects = composerHintZoneRects({
      boxLeft: 1 + REVIEW_LEFT_OFFSET,
      boxWidth: REVIEW_WIDTH,
      hintRow: 18,
      display,
    });
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!costRect) throw new Error('expected inset cost hint zone to be present');

    expect(costRect.left).toBeGreaterThan(REVIEW_LEFT_OFFSET);
    expect(hitTopmostZone(costRect.left, costRect.top)?.id).toBe('composer-hint-cost');
    expect(hitTopmostZone(costRect.left - REVIEW_LEFT_OFFSET, 18)).toBeUndefined();

    ui.unmount();
  });

  it('registers nothing for a width-constrained composer when boxLeftOffset is unknown', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
      width: REVIEW_WIDTH,
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: REVIEW_WIDTH }),
    );
    const rects = composerHintZoneRects({
      boxLeft: 1 + REVIEW_LEFT_OFFSET,
      boxWidth: REVIEW_WIDTH,
      hintRow: 18,
      display,
    });
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!costRect) throw new Error('expected a cost rect for the probe');
    expect(hitTopmostZone(costRect.left, costRect.top)).toBeUndefined();

    ui.unmount();
  });
});
