import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ReactElement, useState } from 'react';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { renderThroughFilteredStdin } from '#testing/helpers/filtered-stdin-harness.js';
import { deliverSteps, type InputStep } from '#testing/helpers/input-steps.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { wireAppMouse } from '../../../app/mouse.js';
import { glyph } from '../../../lib/glyphs.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { TwoColumnPicker } from './picker.js';

interface Tool {
  id: string;
  displayName: string;
}
interface Row {
  id: string;
  displayName: string;
}

const VIEWPORT = { cols: 120, rows: 40 };

const TOOLS: Tool[] = [
  { id: 'alpha', displayName: 'Alpha' },
  { id: 'gamma', displayName: 'Gamma' },
  { id: 'delta', displayName: 'Delta' },
  { id: 'beta', displayName: 'Beta' },
];

// Eight rows and the launcher make nine: neither 61 nor 201 steps wrap back onto the row that one
// step gives, so a burst that loses its steps cannot land on the expected row by chance.
const ALPHA_ROWS = ['auto', 'effort', 'family', 'custom:mine', 'a-1', 'a-2', 'a-3', 'a-4'];
const FAMILY_CHILDREN = ['family-1', 'family-2'];
const ROWS_OF: Record<string, string[]> = { gamma: ['auto', 'g-1', 'g-2'], beta: ['b-1'] };
const LEVELS = ['low', 'medium', 'high'];

const ESC = '\u001B';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const ENTER = '\r';
const SPACE = ' ';
const BACKSPACE = '\u007f';
const CTRL_D = '\u0004';
const PROMPT = glyph('prompt', 'unicode');

/** The parent of the real seat picker: the model rows follow the tool through its own state. */
function Harness({ log, column }: { log: string[]; column: 'left' | 'right' }) {
  const [tool, setTool] = useState('alpha');
  const [level, setLevel] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [deleted, setDeleted] = useState<string[]>([]);
  const ids =
    tool === 'alpha'
      ? ALPHA_ROWS.filter((id) => !deleted.includes(id)).flatMap((id) =>
          id === 'family' && expanded ? [id, ...FAMILY_CHILDREN] : [id],
        )
      : (ROWS_OF[tool] ?? []);
  const rows = ids.map((id) => ({
    id,
    displayName: id === 'effort' ? `effort ${LEVELS[level]}` : id,
  }));
  return (
    <TwoColumnPicker<Tool, Row>
      title="Picker"
      initialColumn={column}
      leftProps={{
        items: TOOLS,
        getKey: (t) => t.id,
        isDisabled: (t) => t.id === 'beta',
        terminalPane: (t) =>
          t.id === 'delta' ? { label: 'Ready', verb: 'use', lines: [] } : undefined,
        rowModel: (t, { isCursor, isContext }) => ({
          name: `${isCursor ? '>' : isContext ? '*' : ' '}${t.displayName}`,
        }),
      }}
      rightProps={{
        items: rows,
        getKey: (row) => row.id,
        rowModel: (row, { isCursor }) => ({ name: `${isCursor ? '>' : ' '}${row.displayName}` }),
        onLeftChange: (t) => setTool(t.id),
        isExpanded: tool === 'alpha' && expanded,
        activationOf: (row) => {
          if (row.id !== 'family') return 'confirm';
          return expanded ? 'collapse' : 'expand';
        },
        onExpand: (row) => {
          log.push(`expand ${row.id}`);
          setExpanded(true);
        },
        onCollapse: () => {
          log.push('collapse');
          setExpanded(false);
        },
        onCycle: (row) => {
          if (row.id !== 'effort') return 'none';
          log.push('cycle effort');
          setLevel((current) => (current + 1) % LEVELS.length);
          return 'stepped';
        },
        customRow: {
          appliesTo: (t) => t.id === 'alpha' || t.id === 'gamma',
          onSelect: (t) => log.push(`custom ${t.id}`),
          isCustom: (row) => row.id.startsWith('custom:'),
          onDelete: (row) => {
            log.push(`delete ${row.id}`);
            setDeleted((current) => [...current, row.id]);
          },
        },
      }}
      onConfirm={(t, row) => log.push(`confirm ${t.id}:${row?.displayName ?? 'none'}`)}
      onCancel={() => log.push('cancel')}
      onRefresh={() => log.push('refresh')}
    />
  );
}

interface Case {
  id: string;
  name: string;
  column: 'left' | 'right';
  /** Steps that reach the start state; they always run with a render after each one. */
  setup?: InputStep[];
  /** Text the start frame shows, so a wrong setup fails here and not as a twin mismatch. */
  start: string;
  steps: InputStep[];
}

interface Snapshot {
  log: string[];
  frame: string;
}

const mounted: Array<() => void> = [];

function unmountAll() {
  while (mounted.length > 0) mounted.pop()?.();
  _resetMouseZones();
}

/** The picker under the input bridge, with the clicks and wheel steps routed as the app routes them. */
function mount(element: ReactElement) {
  const ui = renderThroughFilteredStdin(element, VIEWPORT);
  const disposeMouse = wireAppMouse(ui.filtered);
  mounted.push(() => {
    disposeMouse();
    ui.unmount();
  });
  return ui;
}

async function run(
  row: Case,
  delivery: 'steady' | 'burst',
): Promise<{ start: Snapshot; end: Snapshot }> {
  const log: string[] = [];
  const ui = mount(<Harness log={log} column={row.column} />);
  await ui.settled();
  await deliverSteps(ui, VIEWPORT, row.setup ?? [], 'steady');
  const start = { log: [...log], frame: stripAnsiStyles(ui.lastFrame() ?? '') };
  expect(start.frame).toContain(row.start);

  await deliverSteps(ui, VIEWPORT, row.steps, delivery);
  const end = { log: log.slice(start.log.length), frame: stripAnsiStyles(ui.lastFrame() ?? '') };
  unmountAll();
  return { start, end };
}

const R = 'right';
const L = 'left';
const toolClick = (id: string) => ({ click: `runner-left:${id}` });
const rowClick = (id: string, tool = 'alpha') => ({ click: `runner-right:${tool}:${id}` });
const OPEN_FAMILY = [DOWN, DOWN, ENTER];

const TWINS: Case[] = [
  {
    id: 'A01',
    name: '↑ ⏎ from a lower row',
    column: R,
    setup: [UP, UP],
    start: '>a-4',
    steps: [UP, ENTER],
  },
  {
    id: 'A02',
    name: '↑ ⏎ onto delta',
    column: L,
    setup: [DOWN, DOWN, DOWN],
    start: '>Beta',
    steps: [UP, ENTER],
  },
  { id: 'A03', name: '↑ ↑ in the model column', column: R, start: '>auto', steps: [UP, UP] },
  { id: 'A04', name: '↓ ↓ in the tool column', column: L, start: '>Alpha', steps: [DOWN, DOWN] },
  {
    id: 'A05',
    name: '↑ space onto the stepping row',
    column: R,
    setup: [DOWN, DOWN],
    start: '>family',
    steps: [UP, SPACE],
  },
  {
    id: 'A06',
    name: '↑ ctrl+d onto the custom row',
    column: R,
    setup: [DOWN, DOWN, DOWN, DOWN],
    start: '>a-1',
    steps: [UP, CTRL_D],
  },
  {
    id: 'A07',
    name: 'a tool query that leaves one tool, ⏎',
    column: L,
    start: '>Alpha',
    steps: ['d', ENTER],
  },
  {
    id: 'A08',
    name: 'a model query that leaves one row, ⏎',
    column: R,
    start: '>auto',
    steps: ['3', ENTER],
  },
  {
    id: 'A09',
    name: 'a model query that leaves the stepping row first, space',
    column: R,
    start: '>auto',
    steps: ['f', SPACE],
  },
  {
    id: 'A10',
    name: '⌫ ⏎ on a model query',
    column: R,
    setup: ['3'],
    start: `${PROMPT} 3`,
    steps: [BACKSPACE, ENTER],
  },
  {
    id: 'A11',
    name: 'Esc ⏎ on a model query',
    column: R,
    setup: ['3'],
    start: `${PROMPT} 3`,
    steps: [ESC, ENTER],
  },
  {
    id: 'A12',
    name: '⌫ ↓ on a model query that hides every row',
    column: R,
    setup: ['z'],
    start: `${PROMPT} z`,
    steps: [BACKSPACE, DOWN],
  },
  {
    id: 'A13',
    name: '⌫ ↓ on a tool query that hides every tool',
    column: L,
    setup: ['z'],
    start: `${PROMPT} z`,
    steps: [BACKSPACE, DOWN],
  },
  {
    id: 'A14',
    name: '⌫ space on a one-character model query',
    column: R,
    setup: ['3'],
    start: `${PROMPT} 3`,
    steps: [BACKSPACE, SPACE],
  },
  { id: 'A15', name: 'a model query character, Esc', column: R, start: '>auto', steps: ['3', ESC] },
  { id: 'A16', name: '← ⏎', column: R, start: '>auto', steps: [LEFT, ENTER] },
  { id: 'A17', name: '← ↓ → ⏎', column: R, start: '>auto', steps: [LEFT, DOWN, RIGHT, ENTER] },
  {
    id: 'A18',
    name: '↓ → ⏎ onto the disabled tool',
    column: L,
    setup: [DOWN, DOWN],
    start: '>Delta',
    steps: [DOWN, RIGHT, ENTER],
  },
  {
    id: 'A19',
    name: '↓ ⏎ onto the disabled tool',
    column: L,
    setup: [DOWN, DOWN],
    start: '>Delta',
    steps: [DOWN, ENTER],
  },
  {
    id: 'A20',
    name: '→ ⏎ from the tool column',
    column: L,
    start: '>Alpha',
    steps: [RIGHT, ENTER],
  },
  {
    id: 'A21',
    name: '⏎ ⏎ from the tool column',
    column: L,
    start: '>Alpha',
    steps: [ENTER, ENTER],
  },
  {
    id: 'A22',
    name: '⏎ ↓ ⏎ on the collapsed row',
    column: R,
    setup: [DOWN, DOWN],
    start: '>family',
    steps: [ENTER, DOWN, ENTER],
  },
  {
    id: 'A23',
    name: '⏎ ↑ ⏎ on the collapsed row',
    column: R,
    setup: [DOWN, DOWN],
    start: '>family',
    steps: [ENTER, UP, ENTER],
  },
  {
    id: 'A24',
    name: '⏎ ⏎ on the collapsed row',
    column: R,
    setup: [DOWN, DOWN],
    start: '>family',
    steps: [ENTER, ENTER],
  },
  {
    id: 'A25',
    name: 'a model query character, ⏎ on an open child row',
    column: R,
    setup: OPEN_FAMILY,
    start: '>family-1',
    steps: ['1', ENTER],
  },
  {
    id: 'A26',
    name: 'Esc ⏎ in the open expansion',
    column: R,
    setup: OPEN_FAMILY,
    start: '>family-1',
    steps: [ESC, ENTER],
  },
  {
    id: 'A28',
    name: 'ctrl+d ⏎ on the custom row',
    column: R,
    setup: [DOWN, DOWN, DOWN],
    start: '>custom:mine',
    steps: [CTRL_D, ENTER],
  },
  {
    id: 'A29',
    name: '⏎ ↓ ⏎ in the model column',
    column: R,
    start: '>auto',
    steps: [ENTER, DOWN, ENTER],
  },
  { id: 'A30', name: '↑ ⏎ onto the launcher', column: R, start: '>auto', steps: [UP, ENTER] },
  {
    id: 'A32',
    name: 'click gamma, ⏎',
    column: R,
    start: '>auto',
    steps: [toolClick('gamma'), ENTER],
  },
  {
    id: 'A34',
    name: 'click gamma, ctrl+d from the custom row',
    column: R,
    setup: [DOWN, DOWN, DOWN],
    start: '>custom:mine',
    steps: [toolClick('gamma'), CTRL_D],
  },
  {
    id: 'A35',
    name: 'click the current tool, ⏎',
    column: R,
    setup: [UP, UP],
    start: '>a-4',
    steps: [toolClick('alpha'), ENTER],
  },
  {
    id: 'A36',
    name: 'wheel down on the tool list, ⏎',
    column: R,
    start: '>auto',
    steps: [{ wheel: 'runner-left:alpha' }, ENTER],
  },
  {
    id: 'A37',
    name: 'click a model row, ⏎',
    column: R,
    start: '>auto',
    steps: [rowClick('a-2'), ENTER],
  },
  {
    id: 'A38',
    name: 'click the stepping row, ⏎',
    column: R,
    start: '>auto',
    steps: [rowClick('effort'), ENTER],
  },
  {
    id: 'A39',
    name: 'click the collapsed row, ↓, ⏎',
    column: R,
    start: '>auto',
    steps: [rowClick('family'), DOWN, ENTER],
  },
  {
    id: 'A40',
    name: 'click delta, ⏎',
    column: L,
    start: '>Alpha',
    steps: [toolClick('delta'), ENTER],
  },
  {
    id: 'A43',
    name: '↓ → ⏎ onto delta',
    column: L,
    setup: [DOWN],
    start: '>Gamma',
    steps: [DOWN, RIGHT, ENTER],
  },
  {
    id: 'A44',
    name: 'click the launcher, ⏎',
    column: R,
    start: '>auto',
    steps: [rowClick('__custom__'), ENTER],
  },
  {
    id: 'A45',
    name: 'wheel down on the model list, ⏎',
    column: R,
    start: '>auto',
    steps: [{ wheel: 'runner-right:alpha:auto' }, ENTER],
  },
  {
    id: 'A46',
    name: 'click the open row, ⏎',
    column: R,
    setup: OPEN_FAMILY,
    start: '>family-1',
    steps: [rowClick('family'), ENTER],
  },
  {
    id: 'A48',
    name: 'click gamma, space from the stepping row',
    column: R,
    setup: [DOWN],
    start: '>effort low',
    steps: [toolClick('gamma'), SPACE],
  },
  {
    id: 'A49',
    name: 'a model query that leaves the custom row first, ctrl+d',
    column: R,
    start: '>auto',
    steps: ['c', CTRL_D],
  },
  {
    id: 'A50',
    name: 'a model query that leaves a plain row first, ctrl+d from the custom row',
    column: R,
    setup: [DOWN, DOWN, DOWN],
    start: '>custom:mine',
    steps: ['3', CTRL_D],
  },
  {
    id: 'A51',
    name: 'a tool query from delta that leaves one tool with a model list, ⏎',
    column: L,
    setup: [DOWN, DOWN],
    start: '>Delta',
    steps: ['g', ENTER],
  },
];

const CLICKS: Array<
  Case & { log: string[]; shows: string; deliveries?: Array<'steady' | 'burst'> }
> = [
  {
    id: 'B01',
    name: 'a tool query that removes gamma, click gamma',
    column: L,
    start: '>Alpha',
    steps: ['l', toolClick('gamma')],
    log: [],
    shows: `${PROMPT} l`,
  },
  {
    id: 'B02',
    name: 'a tool query that moves delta up, click delta',
    column: L,
    start: '>Alpha',
    steps: ['l', toolClick('delta')],
    log: ['confirm delta:none'],
    shows: '>Delta',
  },
  {
    id: 'B03',
    name: 'a model query that removes the clicked row, click it',
    column: R,
    start: '>auto',
    steps: ['3', rowClick('a-1')],
    log: [],
    shows: '>a-3',
  },
  {
    id: 'B04',
    name: 'a model query that moves the clicked row up, click it',
    column: R,
    start: '>auto',
    steps: ['3', rowClick('a-3')],
    log: ['confirm alpha:a-3'],
    shows: '>a-3',
  },
  {
    id: 'B05',
    name: 'wheel to gamma, click the auto row drawn for alpha',
    column: R,
    start: '>auto',
    steps: [{ wheel: 'runner-left:alpha' }, rowClick('auto')],
    log: [],
    shows: '>Gamma',
  },
  {
    id: 'B06',
    name: 'click gamma, click the auto row drawn for alpha',
    column: R,
    start: '>auto',
    steps: [toolClick('gamma'), rowClick('auto')],
    log: [],
    shows: '*Gamma',
  },
  {
    id: 'B07',
    name: '↓ to gamma, click the auto row drawn for alpha',
    column: L,
    start: '>Alpha',
    steps: [DOWN, rowClick('auto')],
    log: [],
    shows: '>Gamma',
  },
  {
    id: 'B08',
    name: 'click gamma, click the launcher drawn for alpha',
    column: R,
    start: '>auto',
    steps: [toolClick('gamma'), rowClick('__custom__')],
    log: [],
    shows: '*Gamma',
  },
  {
    id: 'B09',
    name: 'click the auto row, click gamma',
    column: R,
    start: '>auto',
    steps: [rowClick('auto'), toolClick('gamma')],
    log: ['confirm alpha:auto'],
    shows: '*Gamma',
  },
  {
    id: 'B10',
    name: '⏎, then 2 wheel steps down on the model list',
    column: R,
    start: '>auto',
    steps: [ENTER, { wheel: 'runner-right:alpha:auto' }, { wheel: 'runner-right:alpha:auto' }],
    log: ['confirm alpha:auto'],
    shows: '>family',
  },
  {
    id: 'A47',
    name: 'click the disabled tool, ⏎',
    column: R,
    start: '>auto',
    steps: [toolClick('beta'), ENTER],
    log: [],
    shows: '>Beta',
    deliveries: ['steady', 'burst'],
  },
];

describe('TwoColumnPicker input order', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ ...VIEWPORT, isSmall: false });
    // The picker lives in a seat picker overlay, which routes the wheel to its rows.
    overlayStore.open('planner-picker');
  });

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
      const { end } = await run(row, delivery);
      expect.soft(end.log, delivery).toEqual(row.log);
      expect.soft(end.frame, delivery).toContain(row.shows);
    }
  });

  it.for([
    { id: 'C01', count: 61 },
    { id: 'C02', count: 201 },
  ])('$id runs every key of a burst of $count ↓', async ({ count }) => {
    // The cursor starts on `auto` at index 1, behind the launcher, and ↓ wraps at the list end.
    const landsOn = ALPHA_ROWS[((1 + count) % (ALPHA_ROWS.length + 1)) - 1];
    const steps = Array.from({ length: count }, () => DOWN);
    const { end } = await run({ id: '', name: '', column: R, start: '>auto', steps }, 'burst');
    expect(end.frame).toContain(`>${landsOn}`);
  });

  // Each right column action meets the state that the action before it left: a cycle steps the
  // effort draft once, and the confirm after the collapse carries the last draft.
  const DRAFT_LOG = [
    'cycle effort',
    'cycle effort',
    'expand family',
    'collapse',
    'confirm alpha:effort high',
  ];

  it.for(['steady', 'burst'] as const)(
    'D01 runs a wheel step into the model column, two cycles, an open and an Esc close and ⏎ in order (%s)',
    async (delivery) => {
      const steps = [
        { wheel: 'runner-right:alpha:auto' },
        SPACE,
        SPACE,
        DOWN,
        ENTER,
        ESC,
        UP,
        ENTER,
      ];
      const { end } = await run(
        { id: 'D01', name: '', column: L, start: '>Alpha', steps },
        delivery,
      );
      expect(end.log).toEqual(DRAFT_LOG);
      expect(end.frame).toContain('>effort high');
    },
  );

  // A click on a right row takes the keys to the model column and puts the cursor on that row,
  // also when the row only steps its value.
  it.for(['steady', 'burst'] as const)(
    'D03 runs a click on a model row from the tool column, ⏎, two clicks on the stepping row and ⏎ in order (%s)',
    async (delivery) => {
      const steps = [rowClick('a-2'), ENTER, rowClick('effort'), rowClick('effort'), ENTER];
      const { end } = await run(
        { id: 'D03', name: '', column: L, start: '>Alpha', steps },
        delivery,
      );
      expect(end.log).toEqual([
        'confirm alpha:a-2',
        'confirm alpha:a-2',
        'cycle effort',
        'cycle effort',
        'confirm alpha:effort high',
      ]);
      expect(end.frame).toContain('>effort high');
    },
  );

  it('D02 runs → ↓ space → space ↓ ⏎ ↑ ⏎ ↑ ⏎ of one stdin read in order', async () => {
    const log: string[] = [];
    const ui = mount(<Harness log={log} column={L} />);
    await ui.settled();
    // Ink gives the plain text of one read as one input, so a key stands between the two spaces.
    const keys = [RIGHT, DOWN, SPACE, RIGHT, SPACE, DOWN, ENTER, UP, ENTER, UP, ENTER];
    ui.pressBytes(keys.join(''));
    await ui.settled();
    expect(log).toEqual(DRAFT_LOG);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('>effort high');
  });
});
