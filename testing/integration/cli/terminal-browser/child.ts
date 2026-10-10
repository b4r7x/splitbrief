import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { AppProps } from '../../../../src/app/root.js';
import type { ClipboardImageResult } from '../../../../src/core/attachments/clipboard-image.js';
import { readSgrMouse } from '../../../../src/lib/terminal/filtered-stdin/mouse.js';

type FixtureMode = 'off' | 'tracking';
type ChildMode = FixtureMode | 'composer';

interface ChildState {
  readonly mode: ChildMode;
  readonly ready: boolean;
  readonly stopped: boolean;
  readonly mouseEvents: number;
  readonly wheelEvents: number;
  readonly scrollOffset: number;
  readonly streamUpdates?: number;
  readonly stopRequests?: number;
  readonly submitted?: { readonly text: string; readonly images: number } | undefined;
}

const [modeArg, artifactArg] = process.argv.slice(2);
if (!isChildMode(modeArg) || artifactArg === undefined || !isAbsolute(artifactArg)) {
  throw new Error('terminal-browser child needs mode and an absolute artifact directory');
}

const mode = modeArg;
const artifactDir = resolve(artifactArg);
mkdirSync(artifactDir, { recursive: true });
const statePath = join(artifactDir, `${mode}-state.json`);
const inputPath = join(artifactDir, `${mode}-input.ndjson`);
let state: ChildState = {
  mode,
  ready: false,
  stopped: false,
  mouseEvents: 0,
  wheelEvents: 0,
  scrollOffset: 0,
};
let pending = Buffer.alloc(0);
let stopped = false;
let closeComposer: (() => void) | undefined;
const rawBefore = process.stdin.isRaw;
const modesOff = '\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1007l';
const ascii = 'COPY-ME-ASCII-Alpha 123';
const multiline = ['COPY-ME-MULTI-FIRST', 'COPY-ME-MULTI-SECOND-λ漢字', 'COPY-ME-MULTI-LAST'].join(
  '\n',
);
const unicode = 'COPY-ME-UNICODE-Zażółć 日本語 😀 👩‍💻 q́';

function isChildMode(value: string | undefined): value is ChildMode {
  return value === 'off' || value === 'tracking' || value === 'composer';
}

function writeState(): void {
  writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state)}\n`, 'utf8');
  renameSync(`${statePath}.tmp`, statePath);
}

function record(kind: string, value: Record<string, unknown> = {}): void {
  appendFileSync(inputPath, `${JSON.stringify({ time: Date.now(), kind, ...value })}\n`, 'utf8');
}

function setReady(): void {
  state = { ...state, ready: true };
  writeState();
}

function recordInput(chunk: Buffer): void {
  record('input', { hex: chunk.toString('hex') });
  pending = Buffer.concat([pending, chunk]);
  while (pending.length > 0) {
    const read = readSgrMouse(pending);
    if (read?.kind === 'incomplete') return;
    if (read?.kind === 'complete') {
      pending = pending.subarray(read.length);
      if (read.event !== undefined) {
        const isWheel = read.event.type === 'wheel-up' || read.event.type === 'wheel-down';
        state = {
          ...state,
          mouseEvents: state.mouseEvents + 1,
          wheelEvents: state.wheelEvents + (isWheel ? 1 : 0),
        };
        record('mouse', { event: read.event });
        writeState();
      }
      continue;
    }
    if (pending[0] === 3 && mode === 'off') {
      stop();
      return;
    }
    pending = pending.subarray(1);
  }
}

function stop(): void {
  if (stopped) return;
  stopped = true;
  closeComposer?.();
  process.stdin.removeListener('data', recordInput);
  process.stdout.write(`${modesOff}\u001b[?2004l\u001b[?25h`);
  if (process.stdin.isTTY) process.stdin.setRawMode(rawBefore);
  process.stdin.pause();
  state = { ...state, stopped: true };
  writeState();
  record('stopped');
  process.exitCode = 0;
}

async function startComposer(): Promise<void> {
  const [
    { createElement, useEffect },
    { renderApp },
    { Composer },
    { configStore },
    { makeConfig },
    { terminalSizeStore },
    { attachmentsStore },
  ] = await Promise.all([
    import('react'),
    import('../../../../src/cli/render/app.js'),
    import('../../../../src/components/composer/composer.js'),
    import('../../../../src/stores/project/config.js'),
    import('../../../helpers/factories/config.js'),
    import('../../../../src/stores/ui/terminal-size.js'),
    import('../../../../src/stores/workflow/attachments.js'),
  ]);
  process.stdout.write(`${modesOff}\u001b[2J\u001b[H`);
  configStore.__testReset({
    config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    projectDir: artifactDir,
  });
  terminalSizeStore.__testReset({ cols: 120, rows: 32, isSmall: false });
  const abort = new AbortController();
  closeComposer = () => abort.abort();
  function FixtureComposer() {
    useEffect(setReady, []);
    return createElement(Composer, {
      commands: [],
      mode: 'normal',
      currentScreen: 'home',
      hint: 'Headless browser input',
      width: 116,
      listProjectFiles: async () => [],
      onRuntimeCommand: () => undefined,
      onSubmit: (submission) => {
        const text = submission.message.displayText;
        state = {
          ...state,
          submitted: { text, images: attachmentsStore.peek().length },
        };
        writeState();
        record('composer-submit', { text, images: attachmentsStore.peek().length });
        process.stdout.write('\r\nCOMPOSER_SUBMITTED\r\n');
      },
      readClipboardImage: async (): Promise<ClipboardImageResult> => ({
        ok: false,
        reason: 'unsupported-platform',
      }),
    });
  }
  await renderApp(createElement(FixtureComposer), {
    fullscreen: true,
    unmountSignal: abort.signal,
  });
}

function startFixture(): void {
  process.stdout.write(`${modesOff}\u001b[2J\u001b[H`);
  const lines = [
    ...Array.from({ length: 36 }, (_, index) => `PTY filler row ${String(index).padStart(2, '0')}`),
    ascii,
    ...multiline.split('\n'),
    unicode,
    'END-OF-FIXTURE',
  ];
  process.stdout.write(`${lines.map((line) => `${line}\r\n`).join('')}`);
  process.stdin.on('data', recordInput);
  setReady();
}

async function startTracking(): Promise<void> {
  const [
    { createElement, useEffect },
    { App },
    { renderApp },
    { createFixtureSession },
    { listVisualScenarios },
    { eventsStore },
    { conversationScrollStore },
    { _lifecycleInternal },
  ] = await Promise.all([
    import('react'),
    import('../../../../src/app/root.js'),
    import('../../../../src/cli/render/app.js'),
    import('../../../visual/gallery/fixture-session.js'),
    import('../../../visual/catalog.js'),
    import('../../../../src/stores/workflow/events.js'),
    import('../../../../src/stores/workflow/conversation-scroll.js'),
    import('../../../../src/stores/workflow/lifecycle.js'),
  ]);
  const scenario = listVisualScenarios().find(
    (candidate) => candidate.id === 'workflow-implementation',
  );
  const viewport = scenario?.viewports[0];
  if (scenario === undefined || viewport === undefined) throw new Error('Missing workflow fixture');
  const session = await createFixtureSession({ scenario, viewport });
  session.resize({ cols: process.stdout.columns, rows: process.stdout.rows });
  const abort = new AbortController();
  closeComposer = () => abort.abort();
  process.stdin.on('data', recordInput);

  function TrackingApp() {
    useEffect(() => {
      const now = Date.now();
      _lifecycleInternal.set((current) =>
        current.status !== 'running'
          ? current
          : {
              ...current,
              startedAt: now,
              phaseFirstSeenTs: { implementing: now },
              lastRunnerEventTs: now,
              attemptStartedTs: now,
            },
      );
      eventsStore.__testReset({
        events: [
          {
            type: 'planner_text',
            phase: 'planning',
            ts: 0,
            text: [
              ...Array.from(
                { length: 36 },
                (_, index) => `PTY transcript row ${String(index).padStart(2, '0')}`,
              ),
              ascii,
              multiline,
              unicode,
              'END-OF-FIXTURE',
            ].join('\n'),
          },
        ],
      });
      state = { ...state, ready: true };
      writeState();
      const streamRequest = join(artifactDir, 'stream-request');
      const timer = setInterval(() => {
        if (!existsSync(streamRequest)) return;
        rmSync(streamRequest);
        const events = eventsStore
          .get()
          .events.map((event) =>
            event.type === 'planner_text'
              ? { ...event, text: event.text.replace('END-OF-FIXTURE', 'STREAM-UPDATE-VISIBLE') }
              : event,
          );
        eventsStore.__testReset({ events });
        state = { ...state, streamUpdates: 1 };
        writeState();
      }, 20);
      const unsubscribe = conversationScrollStore.subscribe(() => {
        state = { ...state, scrollOffset: conversationScrollStore.get().scrollOffset };
        writeState();
      });
      return () => {
        clearInterval(timer);
        unsubscribe();
      };
    }, []);
    const interactions = session.props.interactionDeps;
    if (interactions === undefined) throw new Error('Missing isolated interaction ports');
    return createElement<AppProps>(App, {
      ...session.props,
      interactionDeps: {
        ...interactions,
        keys: {
          ...interactions.keys,
          requestStopNow: () => {
            state = { ...state, stopRequests: (state.stopRequests ?? 0) + 1 };
            writeState();
            return interactions.keys.requestStopNow();
          },
        },
      },
    });
  }

  try {
    await renderApp(createElement(TrackingApp), { fullscreen: true, unmountSignal: abort.signal });
  } finally {
    await session.dispose();
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', (error) => {
  record('error', { message: error.message });
  stop();
  process.exitCode = 1;
});
writeState();
if (mode !== 'off')
  void (mode === 'composer' ? startComposer() : startTracking()).catch((error: unknown) => {
    record('error', { message: String(error) });
    stop();
    process.exitCode = 1;
  });
else startFixture();
