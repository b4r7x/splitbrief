import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { Text, type RenderOptions } from 'ink';
import XtermHeadless from '@xterm/headless';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { pickerCatalog, realPickerOption } from '#testing/helpers/runner-picker.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { renderApp } from '../../../src/cli/render/app.js';
import {
  cycleOptionAxis,
  mergeOptionFamilies,
  optionAxesOf,
  type OptionAxisName,
} from '../../../src/features/runners/model-catalog/option-axis.js';
import type { ModelOption } from '../../../src/features/runners/model-catalog/recency.js';
import { buildRightRows } from '../../../src/features/runners/model-catalog/rows.js';
import { PickerView } from '../../../src/features/runners/picker-view.js';
import type { PickerActions } from '../../../src/features/runners/use-picker-actions.js';
import { pickerViewStore } from '../../../src/stores/ui/picker-view.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

// Ink drops every redraw when `is-in-ci` reports a CI environment, and that module
// reads the environment while it loads — earlier than any hook can reach.
const ambientCi = vi.hoisted(() => {
  const saved = {
    ci: process.env['CI'],
    continuousIntegration: process.env['CONTINUOUS_INTEGRATION'],
  };
  delete process.env['CI'];
  delete process.env['CONTINUOUS_INTEGRATION'];
  return saved;
});

afterAll(() => {
  if (ambientCi.ci !== undefined) process.env['CI'] = ambientCi.ci;
  if (ambientCi.continuousIntegration !== undefined) {
    process.env['CONTINUOUS_INTEGRATION'] = ambientCi.continuousIntegration;
  }
});

const inkProbe = vi.hoisted(() => {
  const options: RenderOptions[] = [];
  return {
    options,
    mount: undefined as typeof import('ink').render | undefined,
    record: (seatOptions: RenderOptions) => {
      options.push(seatOptions);
      return {
        rerender: () => {},
        unmount: () => {},
        waitUntilExit: () => Promise.resolve(),
        cleanup: () => {},
        clear: () => {},
      };
    },
  };
});

// `renderApp` reaches Ink through this, so the option sets the matrix replays are the
// ones the app asks for rather than a copy of them. The probe records and refuses to
// mount; the matrix mounts through `inkProbe.mount`, Ink's own `render`.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  inkProbe.mount = actual.render;
  return {
    ...actual,
    render: (_node: unknown, options: RenderOptions) => inkProbe.record(options),
  };
});

// `fullscreen-ink` is loaded natively out of node_modules, so the `ink` mock above cannot
// reach the `render` it imports; without this stand-in the fullscreen probe mounts for real,
// fails, and `renderApp` quietly hands back its inline fallback instead. The library does
// one thing with the options it is given — forwards them to Ink — and so does this.
vi.mock('fullscreen-ink', () => ({
  withFullScreen: (_node: unknown, options: RenderOptions) => ({
    instance: inkProbe.record(options),
    start: () => Promise.resolve(),
    waitUntilExit: () => Promise.resolve(),
  }),
}));

/** The terminal the frames are painted into; a `layoutRows` below it leaves a short frame. */
const STDOUT_ROWS = 40;

/** Effort × speed × thinking over one family, the shape an expanded picker row draws. */
function optionFamilyFixture(): ModelOption {
  const [family, ...rest] = mergeOptionFamilies(
    ['high', 'medium'].flatMap((effort) =>
      ['', '-fast'].flatMap((speed) =>
        ['', '-thinking'].map((thinking) => ({
          id: `claude-sonnet-5-${effort}${speed}${thinking}`,
          membership: 'confirmed' as const,
          contextLength: 200_000,
        })),
      ),
    ),
  );
  if (family === undefined || rest.length > 0) {
    throw new Error(`the fixture ids merged into ${rest.length + 1} rows, wanted one family`);
  }
  return family;
}

const FAMILY = optionFamilyFixture();
const VARIANTS = FAMILY.variants ?? [];
const CYCLES: readonly OptionAxisName[] = ['effort', 'thinking', 'speed'];
const FIRST_DRAFT = 'claude-sonnet-5-high';
const LAST_DRAFT = CYCLES.reduce((draft, axis) => {
  const next = cycleOptionAxis(VARIANTS, draft, axis);
  if (next === undefined) throw new Error(`fixture cannot cycle ${axis} from ${draft}`);
  return next;
}, FIRST_DRAFT);

const actions: PickerActions = {
  confirm: async () => {},
  confirmProviderVariant: async () => {},
  leftChange: () => {},
  deleteRight: async () => {},
  chooseContract: () => {},
  customCommand: async () => {},
  customModel: async () => {},
  openCustomModel: () => {},
  openProviderAuth: () => {},
  submitProviderKey: async () => {},
  closeOverlay: () => {},
};

/** Rebuilds the rows from the store on every render, the way `usePickerCatalog` does. */
function LivePicker() {
  const expandedModelId = pickerViewStore.use((s) => s.expandedModelId);
  const optionDraftId = pickerViewStore.use((s) => s.optionDraftId);
  const tool = realPickerOption('planner', 'claude-code');
  const rightRows = buildRightRows({
    models: [FAMILY],
    expandedModelId,
    providerAuth: undefined,
    hasOracle: false,
    catalogLane: 'ready',
    persistedModel: undefined,
    customModels: [],
    optionDraftId,
  });
  return createElement(PickerView, {
    role: 'planner',
    actions,
    catalog: pickerCatalog({
      items: [tool],
      currentItem: tool,
      selectedItemId: tool.id,
      rightModels: [FAMILY],
      rightRows,
      roleLabel: 'Planner',
      modelCounts: { confirmed: 1, stale: 0, suggestions: 0, bundled: 0, custom: 0 },
      focusModels: true,
    }),
  });
}

function ttyStream(cols: number, rows: number = STDOUT_ROWS) {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: cols,
    rows,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  });
  return { writes, stream: stream as unknown as NodeJS.WriteStream };
}

function ttyStdin(): NodeJS.ReadStream {
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    read: (): string | null => null,
    setEncoding: (): void => {},
    setRawMode: (): void => {},
    resume: (): void => {},
    pause: (): void => {},
    ref: (): void => {},
    unref: (): void => {},
  });
  return stream as unknown as NodeJS.ReadStream;
}

/** The probe runs the app's own terminal setup and teardown, which write escapes straight
 * to the process stdout; none of them belong in the terminal running the suite. */
function silenceRealStdout(): () => void {
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((_chunk, encoding?: unknown, callback?: unknown) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      return true;
    });
  return () => spy.mockRestore();
}

/** The two render seats a real run can take: `--no-fullscreen` and piped stdout take the first. */
type RenderPath = 'inline' | 'fullscreen';

async function renderOptionsFor(path: RenderPath): Promise<RenderOptions> {
  inkProbe.options.length = 0;
  const unmount = new AbortController();
  unmount.abort();
  const restoreStdout = silenceRealStdout();
  try {
    await renderApp(createElement(Text, null, 'probe'), {
      fullscreen: path === 'fullscreen',
      unmountSignal: unmount.signal,
    });
  } finally {
    restoreStdout();
  }
  // Exactly one: a fullscreen mount that fails falls back to the inline seat, and a second
  // capture would silently turn the fullscreen rows into more inline rows.
  const [options, ...extra] = inkProbe.options;
  if (options === undefined || extra.length > 0) {
    throw new Error(`the ${path} path reached ${inkProbe.options.length} render seats, wanted 1`);
  }
  return options;
}

function seed(draft: string, cols: number, layoutRows: number): void {
  terminalSizeStore.__testReset({ cols, rows: layoutRows, isSmall: cols < 120 });
  pickerViewStore.expand(FAMILY.id, draft);
}

function mountPicker(options: RenderOptions, cols: number, rows: number = STDOUT_ROWS) {
  const mount = inkProbe.mount;
  if (mount === undefined) throw new Error('the ink module mock never captured Ink render');
  const stdout = ttyStream(cols, rows);
  const instance = mount(createElement(LivePicker), {
    ...options,
    stdout: stdout.stream,
    stderr: ttyStream(cols, rows).stream,
    stdin: ttyStdin(),
    patchConsole: false,
  });
  return { instance, writes: stdout.writes, stream: stdout.stream };
}

/**
 * Ink throttles at `maxFps`, so a frame lands on a timer rather than on the store write, and
 * it splits one frame over several writes — the synchronized-output brackets, the cursor
 * escape, the frame — after an initial write that is not a frame at all when the kitty
 * protocol is enabled. A chunk count is therefore not a frame boundary, and neither is a
 * silence shorter than the throttle interval Ink holds a trailing-edge frame for; a longer
 * one is. Nothing arrives at all under CI, or when a draft change leaves the frame
 * byte-identical, and this fails by name rather than replaying the wrong screen.
 */
async function settleWrites(
  writes: readonly string[],
  baseline: number,
  options: RenderOptions,
): Promise<void> {
  const quiet = Math.ceil(1000 / (options.maxFps ?? 30)) + 10;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const seen = writes.length;
    await new Promise((resolve) => setTimeout(resolve, quiet));
    if (writes.length === seen && seen > baseline) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `stdout stalled at ${writes.length} writes, wanted more than ${baseline}: Ink writes ` +
          'nothing under CI, and nothing when the frame it would write is unchanged',
      );
    }
  }
}

async function replayScreen(ansi: string, cols: number, rows: number): Promise<string[]> {
  // `convertEol` stands in for a tty's ONLCR; without it every line staircases.
  const terminal = new XtermHeadless.Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
    disableStdin: true,
    logLevel: 'off',
    scrollback: 0,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(ansi, resolve));
    return Array.from({ length: rows }, (_, y) =>
      (terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').trimEnd(),
    );
  } finally {
    terminal.dispose();
  }
}

/** Erase-display: Ink writes it only once a frame has filled the terminal. */
const CLEAR_TERMINAL = '\u001B[2J';

type RenderCase = {
  readonly name: string;
  readonly path: RenderPath;
  readonly cols: number;
  readonly layoutRows: number;
  /** Grows the terminal once the first frame is up, the way a live window resize does. */
  readonly grownRows?: number | undefined;
};

/** The terminal height the repaints are painted against, after any resize. */
const terminalRows = (spec: RenderCase): number => spec.grownRows ?? STDOUT_ROWS;

async function cycleEveryAxis(
  options: RenderOptions,
  spec: RenderCase,
): Promise<{ before: string[]; after: string[]; filledTerminal: boolean }> {
  const rows = terminalRows(spec);
  seed(FIRST_DRAFT, spec.cols, spec.layoutRows);
  // The live mount always starts at the unresized height, so a grown case's first frame is
  // written into a terminal it exactly fills.
  const { instance, writes, stream } = mountPicker(options, spec.cols, STDOUT_ROWS);
  try {
    await settleWrites(writes, 0, options);
    const before = await replayScreen(writes.join(''), spec.cols, rows);
    // A live resize reaches the writer this way: the grow leaves the previous frame's height
    // under the new terminal height, which keeps Ink out of the clearTerminal branch that
    // height had earned, and hands the writer the same frame in the other shape — a trailing
    // newline where the seeded one had none.
    if (spec.grownRows !== undefined) stream.rows = spec.grownRows;
    let draft = FIRST_DRAFT;
    for (const axis of CYCLES) {
      const next = cycleOptionAxis(VARIANTS, draft, axis);
      if (next === undefined) throw new Error(`cannot cycle ${axis} from ${draft}`);
      draft = next;
      const seen = writes.length;
      pickerViewStore.setOptionDraftId(draft);
      await settleWrites(writes, seen, options);
    }
    const ansi = writes.join('');
    return {
      before,
      after: await replayScreen(ansi, spec.cols, rows),
      filledTerminal: ansi.includes(CLEAR_TERMINAL),
    };
  } finally {
    instance.unmount();
  }
}

/** The same picker, mounted straight at the draft the cycles end on: one write, no diffing. */
async function mountAtLastDraft(options: RenderOptions, spec: RenderCase): Promise<string[]> {
  const rows = terminalRows(spec);
  seed(LAST_DRAFT, spec.cols, spec.layoutRows);
  const { instance, writes } = mountPicker(options, spec.cols, rows);
  try {
    await settleWrites(writes, 0, options);
    return await replayScreen(writes.join(''), spec.cols, rows);
  } finally {
    instance.unmount();
  }
}

/** A frame this short leaves the rows under it untouched, which is where the defect shows. */
const SHORT_ROWS = 28;

const CASES: readonly RenderCase[] = [
  { name: 'inline, 60 columns, short frame', path: 'inline', cols: 60, layoutRows: SHORT_ROWS },
  { name: 'inline, 72 columns, short frame', path: 'inline', cols: 72, layoutRows: SHORT_ROWS },
  { name: 'inline, 100 columns, short frame', path: 'inline', cols: 100, layoutRows: SHORT_ROWS },
  { name: 'inline, 140 columns, short frame', path: 'inline', cols: 140, layoutRows: SHORT_ROWS },
  { name: 'inline, frame fills the terminal', path: 'inline', cols: 100, layoutRows: STDOUT_ROWS },
  {
    name: 'inline, terminal grown under a filling frame',
    path: 'inline',
    cols: 100,
    layoutRows: STDOUT_ROWS,
    grownRows: 50,
  },
  { name: 'fullscreen, short frame', path: 'fullscreen', cols: 100, layoutRows: SHORT_ROWS },
  {
    name: 'fullscreen, frame fills the terminal',
    path: 'fullscreen',
    cols: 100,
    layoutRows: STDOUT_ROWS,
  },
];

describe('render path repaint', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
  });

  it('cycles the fixture family across all three option axes', () => {
    expect(optionAxesOf(VARIANTS).map((axis) => axis.axis)).toEqual([
      'effort',
      'speed',
      'thinking',
    ]);
    expect(LAST_DRAFT).toBe('claude-sonnet-5-medium-fast-thinking');
  });

  it.each(CASES)('leaves nothing of the old draft on screen: $name', async (spec) => {
    const options = await renderOptionsFor(spec.path);
    const live = await cycleEveryAxis(options, spec);
    const settled = await mountAtLastDraft(options, spec);

    // Ink hands a frame that fills the terminal to neither writer, so the short rows are the
    // ones under test and the filling rows are the control that pins the boundary. Reading it
    // off the emitted bytes keeps a case from drifting out of the regime its name claims.
    expect(live.filledTerminal).toBe(spec.layoutRows >= terminalRows(spec));
    expect(live.after).not.toEqual(live.before);
    expect(live.after).toEqual(settled);
  });
});
