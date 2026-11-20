import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { expectCli } from '#testing/helpers/config-narrowing.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { PINNED_CLAUDE_CODE_OPTIONS } from '#testing/helpers/factories/model-cache.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import {
  type FilteredStdinHarness,
  renderThroughFilteredStdin,
} from '#testing/helpers/filtered-stdin-harness.js';
import { deliverSteps, type InputStep } from '#testing/helpers/input-steps.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { deriveCrewRows } from '../../core/crew/rows.js';
import type { Config } from '../../core/schemas/config.js';
import { crewActivate } from '../../features/crew/rows.js';
import {
  defaultPickerEffectDeps,
  type PickerEffectDeps,
} from '../../features/runners/picker/use-actions.js';
import { glyph } from '../../lib/glyphs.js';
import { wireAppMouse } from '../mouse.js';
import { _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { type ConfigSaveResult, configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/discovery/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { ToolModelPicker } from './runners.js';

const VIEWPORT = { cols: 120, rows: 36 };

const CONFIG = makeConfig({
  planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
});

const SAVED: ConfigSaveResult = {
  kind: 'saved',
  ok: true,
  revision: {
    rawSha256: 'runners-input-order',
    fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
  },
  ignoreRuleAdded: false,
};

const ESC = '\u001B';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const ENTER = '\r';

const ON_EFFORT = '▌ └─ effort max';
const ON_SONNET = '▌ Sonnet 5.5 claude-sonnet-5-5 ▾';
const TO_SONNET = [UP, UP];

interface Case {
  id: string;
  name: string;
  /** Steps that reach the start state; they always run with a render after each one. */
  setup?: InputStep[];
  /** Text a cursor line shows at the start, so a wrong setup fails here and not as a mismatch. */
  start: string;
  steps: InputStep[];
}

const mounted: Array<() => void> = [];

function unmountAll() {
  while (mounted.length > 0) mounted.pop()?.();
  _resetMouseZones();
}

// A notice row in its bar form opens on the same bar, so a row that ends on the closing bar is not a cursor.
const cursorLines = (ui: FilteredStdinHarness) =>
  stripAnsiStyles(ui.lastFrame() ?? '')
    .split('\n')
    .filter((line) => line.includes(glyph('liveBar')) && !line.includes(glyph('noticeBarEnd')))
    .map((line) => line.replace(/\s+/g, ' ').trim());

function savedSeat({ planner }: Config) {
  const { tool, model, effort } = expectCli(planner);
  return { tool, model, effort };
}

async function run(row: Case, delivery: 'steady' | 'burst') {
  resetAllStores();
  modelCacheStore.__testSetClaudeCodeModelOptions(PINNED_CLAUDE_CODE_OPTIONS);
  _resetMouseZones();
  terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
  configStore.__testReset({ projectDir: '/tmp/project', config: CONFIG });
  detectionStore.setDetection({
    providers: [],
    cliTools: [
      cliDetectionFor('ready', 'claude-code'),
      cliDetectionFor('ready', 'codex'),
      cliDetectionFor('ready', 'opencode'),
    ],
  });
  const plan = deriveCrewRows({ config: CONFIG }).find((crewRow) => crewRow.id === 'plan');
  if (plan === undefined) throw new Error('No plan seat row.');
  crewActivate({ target: { kind: 'crew', row: plan }, config: CONFIG });
  const saveConfig = vi.fn<PickerEffectDeps['saveConfig']>(async () => SAVED);
  const ui = renderThroughFilteredStdin(
    <ToolModelPicker
      slot="seat"
      role="planner"
      deps={{ ...defaultPickerEffectDeps, saveConfig }}
    />,
    VIEWPORT,
  );
  const disposeMouse = wireAppMouse(ui.filtered);
  mounted.push(() => {
    disposeMouse();
    ui.unmount();
  });
  await vi.waitFor(() => expect(cursorLines(ui).join('\n')).toContain(ON_EFFORT));
  await ui.settled();
  await deliverSteps(ui, VIEWPORT, row.setup ?? [], 'steady');
  expect(cursorLines(ui).join('\n')).toContain(row.start);

  await deliverSteps(ui, VIEWPORT, row.steps, delivery);
  // The save is a promise: two more turns let it settle after either delivery.
  await ui.settled();
  await ui.settled();

  const { view, expandedModelId, effortDraft } = pickerViewStore.get();
  const end = {
    saves: saveConfig.mock.calls.map(([config]) => savedSeat(config)),
    overlay: overlayStore.get().active,
    view: view.kind,
    cursor: cursorLines(ui),
    store: { expandedModelId, effortDraft },
  };
  unmountAll();
  return end;
}

type Snapshot = Awaited<ReturnType<typeof run>>;

const toolClick = (id: string) => ({ click: `runner-left:${id}` });
const rowClick = (tool: string, id: string) => ({ click: `runner-right:${tool}:${id}` });
const TOOL_WHEEL = { wheel: 'runner-left:claude-code' };
const MODEL_WHEEL = { wheel: 'runner-right:claude-code:model:auto' };

const TWINS: Case[] = [
  {
    id: 'RA01',
    name: '⏎ ⏎ on the collapsed sonnet row',
    setup: TO_SONNET,
    start: ON_SONNET,
    steps: [ENTER, ENTER],
  },
  {
    id: 'RA02',
    name: '⏎ ↑ ⏎ on the collapsed sonnet row',
    setup: TO_SONNET,
    start: ON_SONNET,
    steps: [ENTER, UP, ENTER],
  },
  {
    id: 'RA03',
    name: '← ⏎ from the collapsed sonnet row',
    setup: TO_SONNET,
    start: ON_SONNET,
    steps: [LEFT, ENTER],
  },
  { id: 'RA04', name: '← ⏎ from the effort row', start: ON_EFFORT, steps: [LEFT, ENTER] },
  {
    id: 'RA05',
    name: '← ↓ → ⏎ from the effort row',
    start: ON_EFFORT,
    steps: [LEFT, DOWN, RIGHT, ENTER],
  },
  { id: 'RA06', name: 'type haiku, ⏎', start: ON_EFFORT, steps: [...'haiku', ENTER] },
  { id: 'RA07', name: 'type opusplan, ⏎', start: ON_EFFORT, steps: [...'opusplan', ENTER] },
  { id: 'RA08', name: 'Esc ⏎ on the effort row', start: ON_EFFORT, steps: [ESC, ENTER] },
  {
    id: 'RA09',
    name: 'Esc ⏎ on the effort row of sonnet expanded by ⏎',
    setup: [...TO_SONNET, ENTER],
    start: '▌ └─ effort auto',
    steps: [ESC, ENTER],
  },
  {
    id: 'RA11',
    name: '⏎ Esc on a collapsed row with no expansion open',
    setup: [ESC],
    start: '▌ Fable 5.1 claude-fable-5-1 ▾',
    steps: [ENTER, ESC],
  },
  {
    id: 'RA12',
    name: '↓ onto a tool that is not available, → ⏎',
    setup: [LEFT, DOWN, DOWN],
    start: '▌ OpenCode CLI',
    steps: [DOWN, RIGHT, ENTER],
  },
  {
    id: 'RA15',
    name: 'click the Codex tool, ⏎ from the effort row',
    start: ON_EFFORT,
    steps: [toolClick('codex'), ENTER],
  },
  {
    id: 'RA16',
    name: 'click the Codex tool, ⏎ from the collapsed sonnet row',
    setup: TO_SONNET,
    start: ON_SONNET,
    steps: [toolClick('codex'), ENTER],
  },
  {
    id: 'RA17',
    name: 'wheel down on the tool list, ⏎ from the effort row',
    start: ON_EFFORT,
    steps: [TOOL_WHEEL, ENTER],
  },
  {
    id: 'RA18',
    name: 'wheel down on the tool list, ⏎ from the collapsed sonnet row',
    setup: TO_SONNET,
    start: ON_SONNET,
    steps: [TOOL_WHEEL, ENTER],
  },
];

const CLICKS: Array<
  Case & { expected: Partial<Snapshot>; deliveries?: Array<'steady' | 'burst'> }
> = [
  {
    id: 'RB01',
    name: 'wheel to the next tool, click the auto row drawn for Claude Code',
    start: ON_EFFORT,
    steps: [TOOL_WHEEL, rowClick('claude-code', 'model:auto')],
    expected: {
      saves: [],
      overlay: 'planner-picker',
      view: 'picker',
      cursor: expect.arrayContaining([expect.stringContaining('▌ OpenAI Codex')]),
    },
  },
  {
    id: 'RB02',
    name: 'click the Codex tool, click the auto row drawn for Claude Code',
    start: ON_EFFORT,
    steps: [toolClick('codex'), rowClick('claude-code', 'model:auto')],
    expected: {
      saves: [],
      overlay: 'planner-picker',
      view: 'picker',
      cursor: expect.arrayContaining([expect.stringContaining('▌ OpenAI Codex')]),
    },
  },
  {
    id: 'RB03',
    name: 'click the auto row, click the Codex tool',
    start: ON_EFFORT,
    steps: [rowClick('claude-code', 'model:auto'), toolClick('codex')],
    expected: {
      saves: [{ tool: 'claude-code', model: 'auto', effort: 'max' }],
      overlay: 'none',
    },
  },
  {
    id: 'RB04',
    name: '⏎ on the custom-model launcher of Codex, click a model row',
    setup: [toolClick('codex'), UP],
    start: '▌ + Add custom model…',
    steps: [ENTER, rowClick('codex', 'model:auto')],
    expected: { saves: [], overlay: 'planner-picker', view: 'custom-model' },
  },
  {
    id: 'RB05',
    name: 'click the Codex tool, click the custom-model launcher drawn for Claude Code',
    start: ON_EFFORT,
    steps: [toolClick('codex'), rowClick('claude-code', '__custom__')],
    expected: { saves: [], overlay: 'planner-picker', view: 'picker' },
  },
  {
    id: 'RB07',
    name: '⏎ on the effort row, 2 wheel steps down on the model list',
    start: ON_EFFORT,
    steps: [ENTER, MODEL_WHEEL, MODEL_WHEEL],
    expected: {
      saves: [{ tool: 'claude-code', model: 'opus', effort: 'max' }],
      overlay: 'none',
    },
  },
  {
    id: 'RB06',
    name: 'wheel to the next tool, click the sonnet row drawn for Claude Code',
    start: ON_EFFORT,
    steps: [TOOL_WHEEL, rowClick('claude-code', 'model:sonnet')],
    expected: {
      saves: [],
      overlay: 'planner-picker',
      view: 'picker',
      cursor: [expect.stringContaining('▌ OpenAI Codex CLI')],
      store: { expandedModelId: 'opus', effortDraft: null },
    },
  },
  {
    id: 'RA21',
    name: 'click a tool that is not available, ⏎',
    start: ON_EFFORT,
    steps: [toolClick('command-code'), ENTER],
    expected: {
      saves: [],
      overlay: 'planner-picker',
      view: 'picker',
      cursor: expect.arrayContaining([expect.stringContaining('▌ Command Code CLI')]),
    },
    deliveries: ['steady', 'burst'],
  },
];

describe('ToolModelPicker input order', () => {
  beforeEach(forceUnicodeGlyphs);

  afterEach(unmountAll);

  it.for(TWINS)('$id ends a burst as steady input: $name', async (row) => {
    const steady = await run(row, 'steady');
    const burst = await run(row, 'burst');
    expect(burst).toEqual(steady);
  });

  // A click after another step has no steady twin: it acts on the row that was drawn when the
  // burst began, or on nothing. A row whose click comes first runs steady too.
  it.for(CLICKS)('$id acts on the drawn row or on nothing: $name', async (row) => {
    for (const delivery of row.deliveries ?? ['burst']) {
      expect.soft(await run(row, delivery), delivery).toMatchObject(row.expected);
    }
  });
});
