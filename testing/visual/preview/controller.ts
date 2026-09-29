import type { ScenarioDefinition } from '../contracts/catalog.js';
import {
  PASTE_END_BYTES,
  PASTE_START_BYTES,
} from '../../../src/lib/terminal/filtered-stdin/paste.js';
import { formatViewport, ViewportSchema, type Viewport } from '../contracts/geometry.js';
import {
  createFixtureSession,
  type FixtureSession,
  type FixtureSessionInput,
} from '../gallery/fixture-session.js';
import { flushEffects } from '#testing/helpers/ink.js';

export type PreviewSession = FixtureSession;

export type PreviewShortcut = 'back' | 'reset' | 'viewport' | 'quit';

interface PreviewStateBase {
  readonly scenarios: readonly ScenarioDefinition[];
  readonly scenarioIndex: number;
  readonly viewportIndex: number;
  readonly hostViewport: Viewport;
  readonly message: string | null;
}

export type PreviewState =
  | (PreviewStateBase & { readonly kind: 'chooser' })
  | (PreviewStateBase & { readonly kind: 'loading' })
  | (PreviewStateBase & { readonly kind: 'preview'; readonly session: PreviewSession });

export interface PreviewControllerOptions {
  readonly scenarios: readonly ScenarioDefinition[];
  readonly hostViewport: Viewport;
  readonly forward: (input: Buffer) => void;
  readonly createSession?: ((input: FixtureSessionInput) => Promise<PreviewSession>) | undefined;
  readonly onQuit?: (() => void) | undefined;
}

export interface PreviewController {
  readonly getState: () => PreviewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly attachInput: (source: NodeJS.ReadableStream) => () => void;
  readonly forwardToPreview: (input: string) => void;
  /** The scripted-key form: forwards one key, then yields until the view has applied it. */
  readonly pressToPreview: (input: string) => Promise<void>;
  readonly handleInput: (input: Buffer | string) => void;
  readonly flushInput: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly activateSelection: () => Promise<void>;
  readonly selectScenario: (scenario: number | string) => Promise<void>;
  readonly resetScenario: () => Promise<void>;
  readonly backToChooser: () => Promise<void>;
  readonly selectViewport: () => Promise<void>;
  readonly resizeHost: (viewport: Viewport) => Promise<void>;
  readonly waitForIdle: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

const CTRL_Q = 0x11;

const SHORTCUT_SEQUENCES: readonly Readonly<{ shortcut: PreviewShortcut; bytes: Buffer }>[] = [
  { shortcut: 'back', bytes: Buffer.from('\u001bOQ') },
  { shortcut: 'back', bytes: Buffer.from('\u001b[12~') },
  { shortcut: 'reset', bytes: Buffer.from('\u001b[15~') },
  { shortcut: 'viewport', bytes: Buffer.from('\u001b[17~') },
];

function fits(host: Viewport, declared: Viewport): boolean {
  return host.cols >= declared.cols && host.rows >= declared.rows;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedScenario(state: PreviewState): ScenarioDefinition | undefined {
  return state.scenarios[state.scenarioIndex];
}

function selectedViewport(state: PreviewState): Viewport | undefined {
  return selectedScenario(state)?.viewports[state.viewportIndex];
}

function viewportAt(scenario: ScenarioDefinition, index: number): Viewport {
  const viewport = scenario.viewports[index];
  if (viewport === undefined) throw new Error(`Scenario ${scenario.id} has no viewport ${index}`);
  return viewport;
}

function firstViewportThatFits(scenario: ScenarioDefinition, host: Viewport): number {
  const index = scenario.viewports.findIndex((candidate) => fits(host, candidate));
  return index === -1 ? 0 : index;
}

function sizeWarning(host: Viewport, declared: Viewport): string | null {
  return fits(host, declared)
    ? null
    : `Viewport ${formatViewport(declared)} needs a larger terminal (current ${formatViewport(host)}).`;
}

function nextIndex(index: number, length: number): number {
  return length === 0 ? 0 : (index + 1) % length;
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

function isPrefix(bytes: Buffer, sequence: Buffer): boolean {
  return bytes.length < sequence.length && sequence.subarray(0, bytes.length).equals(bytes);
}

function completeEscapeLength(bytes: Buffer): number | undefined {
  if (bytes.length < 2) return undefined;
  if (bytes[1] === 0x5b) {
    for (let index = 2; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte !== undefined && byte >= 0x40 && byte <= 0x7e) return index + 1;
    }
    return undefined;
  }
  if (bytes[1] === 0x4f) return bytes.length >= 3 ? 3 : undefined;
  if ([0x50, 0x58, 0x5d, 0x5e, 0x5f].includes(bytes[1] ?? -1)) {
    for (let index = 2; index < bytes.length; index += 1) {
      if (bytes[index] === 0x07) return index + 1;
      if (bytes[index] === 0x1b && bytes[index + 1] === 0x5c) return index + 2;
    }
    return undefined;
  }
  return 2;
}

function createInputFilter(options: {
  readonly forward: (input: Buffer) => void;
  readonly onShortcut: (shortcut: PreviewShortcut) => void;
}) {
  let pending = Buffer.alloc(0);
  let pasting = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const flush = () => {
    clearTimer();
    if (pending.length === 0 || pasting) return;
    const held = pending;
    pending = Buffer.alloc(0);
    options.forward(held);
  };

  const process = () => {
    while (pending.length > 0) {
      if (pasting) {
        const end = pending.indexOf(PASTE_END_BYTES);
        if (end >= 0) {
          options.forward(pending.subarray(0, end + PASTE_END_BYTES.length));
          pending = pending.subarray(end + PASTE_END_BYTES.length);
          pasting = false;
          continue;
        }
        let held = 0;
        for (let size = 1; size < PASTE_END_BYTES.length && size <= pending.length; size += 1) {
          if (isPrefix(pending.subarray(pending.length - size), PASTE_END_BYTES)) held = size;
        }
        const endOfText = pending.length - held;
        if (endOfText > 0) options.forward(pending.subarray(0, endOfText));
        pending = pending.subarray(endOfText);
        return;
      }
      let specialIndex = -1;
      for (let index = 0; index < pending.length; index += 1) {
        const byte = pending[index];
        if (byte === CTRL_Q || byte === 0x1b) {
          specialIndex = index;
          break;
        }
      }

      if (specialIndex === -1) {
        options.forward(pending);
        pending = Buffer.alloc(0);
        return;
      }
      if (specialIndex > 0) {
        options.forward(pending.subarray(0, specialIndex));
        pending = pending.subarray(specialIndex);
        continue;
      }

      if (pending[0] === CTRL_Q) {
        pending = pending.subarray(1);
        options.onShortcut('quit');
        continue;
      }

      if (startsWith(pending, PASTE_START_BYTES)) {
        options.forward(PASTE_START_BYTES);
        pending = pending.subarray(PASTE_START_BYTES.length);
        pasting = true;
        continue;
      }
      if (isPrefix(pending, PASTE_START_BYTES)) return;

      const exact = SHORTCUT_SEQUENCES.find(({ bytes }) => startsWith(pending, bytes));
      if (exact !== undefined) {
        pending = pending.subarray(exact.bytes.length);
        options.onShortcut(exact.shortcut);
        continue;
      }

      if (SHORTCUT_SEQUENCES.some(({ bytes }) => isPrefix(pending, bytes))) return;

      const escapeLength = completeEscapeLength(pending);
      if (escapeLength === undefined) return;
      options.forward(pending.subarray(0, escapeLength));
      pending = pending.subarray(escapeLength);
    }
  };

  return {
    push(input: Buffer | string): void {
      const chunk = typeof input === 'string' ? Buffer.from(input) : input;
      if (chunk.length === 0) return;
      clearTimer();
      pending = Buffer.concat([pending, chunk]);
      process();
      if (pending.length > 0 && !pasting) flushTimer = setTimeout(flush, 80);
    },
    flush,
    dispose(): void {
      clearTimer();
      pending = Buffer.alloc(0);
      pasting = false;
    },
  };
}

export function createPreviewController(options: PreviewControllerOptions): PreviewController {
  if (options.scenarios.length === 0) throw new Error('The visual catalog is empty');

  const hostViewport = ViewportSchema.parse(options.hostViewport);
  const firstScenario = options.scenarios[0];
  if (firstScenario === undefined) throw new Error('The visual catalog is empty');
  const initialViewportIndex = firstViewportThatFits(firstScenario, hostViewport);
  const initialViewport = viewportAt(firstScenario, initialViewportIndex);

  const listeners = new Set<() => void>();
  const createSession = options.createSession ?? ((input) => createFixtureSession(input));
  let state: PreviewState = {
    kind: 'chooser',
    scenarios: options.scenarios,
    scenarioIndex: 0,
    viewportIndex: initialViewportIndex,
    hostViewport,
    message: sizeWarning(hostViewport, initialViewport),
  };
  let currentSession: PreviewSession | undefined;
  let transitionTail: Promise<void> = Promise.resolve();
  let disposed = false;
  let quitRequested = false;
  let inputDetach: (() => void) | undefined;
  let controller: PreviewController;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const setState = (next: PreviewState) => {
    state = next;
    notify();
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = transitionTail.then(operation, operation);
    transitionTail = next.catch(() => {});
    return next;
  };

  const disposeCurrentSession = async () => {
    const session = currentSession;
    currentSession = undefined;
    if (session !== undefined) await session.dispose();
  };

  const showChooser = (message: string | null) => {
    setState({
      kind: 'chooser',
      scenarios: options.scenarios,
      scenarioIndex: state.scenarioIndex,
      viewportIndex: state.viewportIndex,
      hostViewport: state.hostViewport,
      message,
    });
  };

  const openScenario = (scenarioIndex: number, viewportIndex: number): Promise<void> =>
    enqueue(async () => {
      if (disposed) return;
      const scenario = options.scenarios[scenarioIndex];
      if (scenario === undefined) return;
      const declared = viewportAt(scenario, viewportIndex);
      const warning = sizeWarning(state.hostViewport, declared);
      if (warning !== null) {
        showChooser(warning);
        return;
      }

      setState({
        kind: 'loading',
        scenarios: options.scenarios,
        scenarioIndex,
        viewportIndex,
        hostViewport: state.hostViewport,
        message: null,
      });
      await disposeCurrentSession();

      try {
        const session = await createSession({ scenario, viewport: declared });
        if (disposed) {
          await session.dispose();
          return;
        }
        const currentWarning = sizeWarning(state.hostViewport, declared);
        if (currentWarning !== null) {
          await session.dispose();
          showChooser(currentWarning);
          return;
        }
        // The selected gallery viewport drives the App layout. The host only decides whether
        // that declared viewport fits; extra physical terminal cells remain unused.
        session.resize(declared);
        currentSession = session;
        setState({
          kind: 'preview',
          scenarios: options.scenarios,
          scenarioIndex,
          viewportIndex,
          hostViewport: state.hostViewport,
          message: null,
          session,
        });
      } catch (error) {
        await disposeCurrentSession();
        showChooser(`Could not open ${scenario.id}: ${errorMessage(error)}`);
      }
    });

  const selectScenario = (target: number | string): Promise<void> => {
    if (disposed) return Promise.resolve();
    const scenarioIndex =
      typeof target === 'number'
        ? target
        : options.scenarios.findIndex((scenario) => scenario.id === target);
    const scenario = options.scenarios[scenarioIndex];
    if (scenario === undefined) return Promise.resolve();
    const viewportIndex = firstViewportThatFits(scenario, state.hostViewport);
    const declared = viewportAt(scenario, viewportIndex);
    setState({
      kind: 'chooser',
      scenarios: options.scenarios,
      scenarioIndex,
      viewportIndex,
      hostViewport: state.hostViewport,
      message: sizeWarning(state.hostViewport, declared),
    });
    return openScenario(scenarioIndex, viewportIndex);
  };

  const backToChooser = (): Promise<void> =>
    enqueue(async () => {
      if (disposed) return;
      setState({ ...state, kind: 'loading', message: null });
      await disposeCurrentSession();
      showChooser(null);
    });

  const onShortcut = (shortcut: PreviewShortcut) => {
    if (shortcut === 'quit') {
      if (quitRequested || disposed) return;
      quitRequested = true;
      options.onQuit?.();
      return;
    }
    if (shortcut === 'back') {
      void backToChooser();
      return;
    }
    if (shortcut === 'reset') {
      void controller.resetScenario();
      return;
    }
    void controller.selectViewport();
  };

  const inputFilter = createInputFilter({ forward: options.forward, onShortcut });

  controller = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachInput: (source) => {
      inputDetach?.();
      const onData = (chunk: Buffer | string) => inputFilter.push(chunk);
      source.on('data', onData);
      inputDetach = () => {
        source.off('data', onData);
        inputFilter.flush();
        inputFilter.dispose();
        inputDetach = undefined;
      };
      return inputDetach;
    },
    forwardToPreview: (input) => {
      if (!disposed) options.forward(Buffer.from(input));
    },
    pressToPreview: async (input) => {
      if (disposed) return;
      options.forward(Buffer.from(input));
      // A preview owns no painted-frame probe, so settlement is the React turns the key
      // schedules: the same three `setImmediate` turns `flushEffects` gives a test key.
      await flushEffects();
    },
    handleInput: (input) => {
      if (!disposed) inputFilter.push(input);
    },
    flushInput: () => inputFilter.flush(),
    moveSelection: (delta) => {
      if (disposed || state.kind !== 'chooser') return;
      const count = state.scenarios.length;
      const scenarioIndex = (state.scenarioIndex + delta + count) % count;
      const scenario = state.scenarios[scenarioIndex];
      if (scenario === undefined) return;
      const viewportIndex = firstViewportThatFits(scenario, state.hostViewport);
      const declared = viewportAt(scenario, viewportIndex);
      setState({
        ...state,
        scenarioIndex,
        viewportIndex,
        message: sizeWarning(state.hostViewport, declared),
      });
    },
    activateSelection: () => openScenario(state.scenarioIndex, state.viewportIndex),
    selectScenario,
    resetScenario: () => {
      if (disposed) return Promise.resolve();
      return openScenario(state.scenarioIndex, state.viewportIndex);
    },
    backToChooser,
    selectViewport: () => {
      if (disposed) return Promise.resolve();
      const scenario = selectedScenario(state);
      if (scenario === undefined) return Promise.resolve();
      const viewportIndex = nextIndex(state.viewportIndex, scenario.viewports.length);
      const declared = viewportAt(scenario, viewportIndex);
      const message = sizeWarning(state.hostViewport, declared);
      if (state.kind === 'chooser') {
        setState({ ...state, viewportIndex, message });
        return Promise.resolve();
      }
      if (message !== null) {
        return enqueue(async () => {
          setState({ ...state, kind: 'loading', viewportIndex, message });
          await disposeCurrentSession();
          showChooser(message);
        });
      }
      return enqueue(async () => {
        if (state.kind !== 'preview') return;
        currentSession?.resize(declared);
        setState({ ...state, viewportIndex, message: null });
      });
    },
    resizeHost: (nextViewport) => {
      if (disposed) return Promise.resolve();
      const viewport = ViewportSchema.parse(nextViewport);
      const declared = selectedViewport(state);
      const message = declared === undefined ? null : sizeWarning(viewport, declared);
      if (state.kind === 'preview' && message !== null) {
        return enqueue(async () => {
          setState({ ...state, kind: 'loading', hostViewport: viewport, message });
          await disposeCurrentSession();
          showChooser(message);
        });
      }
      if (state.kind === 'preview' && currentSession !== undefined && declared !== undefined) {
        const session = currentSession;
        setState({ ...state, hostViewport: viewport, message });
        return new Promise<void>((resolve) => {
          queueMicrotask(() => {
            if (!disposed && state.kind === 'preview' && currentSession === session) {
              session.resize(declared);
            }
            resolve();
          });
        });
      }
      setState({ ...state, hostViewport: viewport, message });
      return Promise.resolve();
    },
    waitForIdle: () => transitionTail,
    dispose: () => {
      if (disposed) return transitionTail;
      disposed = true;
      inputDetach?.();
      return enqueue(async () => {
        await disposeCurrentSession();
        listeners.clear();
      });
    },
  };

  return controller;
}
