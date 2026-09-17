import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointDefinitionSchema, ScenarioDefinitionSchema } from '../contracts/catalog.js';
import { viewport, type Viewport } from '../contracts/geometry.js';
import {
  createPreviewController,
  type PreviewController,
  type PreviewSession,
} from './controller.js';

const WIDE = viewport({ cols: 120, rows: 40 });
const COMPACT = viewport({ cols: 80, rows: 24 });
const HOST = viewport({ cols: 160, rows: 45 });
const HOST_RESIZED = viewport({ cols: 140, rows: 40 });
const TOO_SMALL = viewport({ cols: 70, rows: 20 });

function scenario(id: string, viewports: readonly Viewport[]) {
  return ScenarioDefinitionSchema.parse({
    id,
    title: id,
    surface: { kind: 'screen', screen: 'home' },
    fixtureVersion: 2,
    viewports,
    checkpoints: [
      {
        id: 'ready',
        title: 'Ready',
        kind: 'ready',
        marker: 'ready',
        timeoutMs: 1_000,
      },
    ],
    elements: [],
  });
}

interface FakeSessionRecord {
  readonly input: { readonly scenario: string; readonly viewport: Viewport };
  readonly session: PreviewSession;
  readonly disposed: number;
  readonly resized: Viewport[];
}

function makeSession(input: {
  readonly scenario: string;
  readonly viewport: Viewport;
}): FakeSessionRecord {
  const resized: Viewport[] = [];
  let disposed = 0;
  const session: PreviewSession = {
    scenario: scenario(input.scenario, [WIDE, COMPACT]),
    checkpoint: CheckpointDefinitionSchema.parse({
      id: 'ready',
      title: 'Ready',
      kind: 'ready',
      marker: 'ready',
      timeoutMs: 1_000,
    }),
    props: {},
    activate: async () => {},
    resize: (next) => {
      resized.push(next);
      return next;
    },
    dispose: async () => {
      disposed += 1;
    },
  };
  return {
    input,
    session,
    resized,
    get disposed() {
      return disposed;
    },
  };
}

function setup(hostViewport: Viewport = WIDE) {
  const scenarios = [
    scenario('home-empty', [WIDE, COMPACT]),
    scenario('runner-picker', [WIDE, COMPACT]),
  ];
  const forwarded: Buffer[] = [];
  const sessions: FakeSessionRecord[] = [];
  let quitCount = 0;
  const controller = createPreviewController({
    scenarios,
    hostViewport,
    forward: (input) => forwarded.push(Buffer.from(input)),
    createSession: async (input) => {
      const record = makeSession({
        scenario: input.scenario.id,
        viewport: input.viewport,
      });
      sessions.push(record);
      return record.session;
    },
    onQuit: () => {
      quitCount += 1;
    },
  });
  return {
    controller,
    forwarded,
    sessions,
    get quitCount() {
      return quitCount;
    },
  };
}

const activeControllers: PreviewController[] = [];

afterEach(async () => {
  for (const controller of activeControllers.splice(0)) await controller.dispose();
});

describe('preview controller', () => {
  it('selects a scenario, streams ordinary input, resets, changes viewport, returns, and quits', async () => {
    const fixture = setup();
    activeControllers.push(fixture.controller);
    const source = new PassThrough();
    const detach = fixture.controller.attachInput(source);

    fixture.controller.moveSelection(1);
    await fixture.controller.activateSelection();
    await fixture.controller.waitForIdle();

    expect(fixture.controller.getState()).toMatchObject({
      kind: 'preview',
      scenarioIndex: 1,
      viewportIndex: 0,
      hostViewport: WIDE,
    });
    expect(fixture.sessions).toHaveLength(1);

    source.write('r');
    expect(Buffer.concat(fixture.forwarded).toString()).toBe('r');

    source.write(Buffer.from('\u001b[15~'));
    await fixture.controller.waitForIdle();
    expect(fixture.sessions).toHaveLength(2);
    expect(fixture.sessions[0]?.disposed).toBe(1);
    expect(fixture.controller.getState().kind).toBe('preview');

    source.write(Buffer.from('\u001b[17~'));
    await fixture.controller.waitForIdle();
    expect(fixture.controller.getState()).toMatchObject({
      kind: 'preview',
      viewportIndex: 1,
      hostViewport: WIDE,
    });
    expect(fixture.sessions[1]?.resized).toEqual([WIDE, COMPACT]);

    source.write(Buffer.from('\u001b'));
    source.write(Buffer.from('OQ'));
    await fixture.controller.waitForIdle();
    expect(fixture.controller.getState().kind).toBe('chooser');
    expect(fixture.sessions[1]?.disposed).toBe(1);

    source.write(Buffer.from('\u0011'));
    expect(fixture.quitCount).toBe(1);
    expect(Buffer.concat(fixture.forwarded).toString()).toBe('r');
    detach();
  });

  it('shows a fit warning and keeps the actual host size when a resize cannot fit the selected viewport', async () => {
    const fixture = setup();
    activeControllers.push(fixture.controller);

    await fixture.controller.activateSelection();
    await fixture.controller.waitForIdle();
    await fixture.controller.resizeHost(COMPACT);
    await fixture.controller.waitForIdle();

    expect(fixture.controller.getState()).toMatchObject({
      kind: 'chooser',
      hostViewport: COMPACT,
      viewportIndex: 0,
    });
    expect(fixture.controller.getState().message).toContain('120x40');
    expect(fixture.sessions[0]?.disposed).toBe(1);
  });

  it('keeps the selected child viewport when the physical host resizes within its bounds', async () => {
    const fixture = setup(HOST);
    activeControllers.push(fixture.controller);

    await fixture.controller.activateSelection();
    await fixture.controller.waitForIdle();
    expect(fixture.sessions[0]?.resized).toEqual([WIDE]);

    await fixture.controller.selectViewport();
    await fixture.controller.waitForIdle();
    expect(fixture.controller.getState()).toMatchObject({
      kind: 'preview',
      viewportIndex: 1,
      hostViewport: HOST,
    });
    expect(fixture.sessions[0]?.resized.at(-1)).toEqual(COMPACT);

    await fixture.controller.resizeHost(HOST_RESIZED);
    await fixture.controller.waitForIdle();
    expect(fixture.controller.getState()).toMatchObject({
      kind: 'preview',
      viewportIndex: 1,
      hostViewport: HOST_RESIZED,
    });
    expect(fixture.sessions[0]?.resized.at(-1)).toEqual(COMPACT);

    await fixture.controller.resizeHost(TOO_SMALL);
    await fixture.controller.waitForIdle();
    expect(fixture.controller.getState()).toMatchObject({
      kind: 'chooser',
      hostViewport: TOO_SMALL,
      viewportIndex: 1,
    });
    expect(fixture.sessions[0]?.disposed).toBe(1);
  });

  it('forwards UTF-8, paste, and mouse input as intact streams around preview shortcuts', () => {
    const fixture = setup();
    activeControllers.push(fixture.controller);
    const source = new PassThrough();
    const detach = fixture.controller.attachInput(source);
    const text = Buffer.from('typed 😀 text', 'utf8');
    const mouse = Buffer.from('\u001b[<64;10;20M');
    const paste = Buffer.from('\u001b[200~pasted\ntext\u001b[201~');

    source.write(Buffer.concat([text, mouse, paste]));
    source.write(Buffer.from([0xf0, 0x9f]));
    source.write(Buffer.from([0x98, 0x80]));
    fixture.controller.flushInput();

    expect(Buffer.concat(fixture.forwarded)).toEqual(
      Buffer.concat([text, mouse, paste, Buffer.from('😀', 'utf8')]),
    );
    expect(fixture.forwarded).toContainEqual(text);
    expect(fixture.forwarded).toContainEqual(mouse);
    expect(fixture.forwarded).toContainEqual(Buffer.from('\u001b[200~'));
    detach();
  });

  it('forwards pasted shortcuts literally at every byte split, then handles a real shortcut', async () => {
    const fixture = setup();
    activeControllers.push(fixture.controller);
    await fixture.controller.activateSelection();
    const paste = Buffer.from(
      '\u001b[200~r😀\u0011\u001bOQ\u001b[12~\u001b[15~\u001b[17~\n\u001b[201~',
    );
    for (let split = 1; split < paste.length; split += 1) {
      fixture.forwarded.length = 0;
      fixture.controller.handleInput(paste.subarray(0, split));
      fixture.controller.handleInput(paste.subarray(split));
      await fixture.controller.waitForIdle();
      expect(Buffer.concat(fixture.forwarded)).toEqual(paste);
      expect(fixture.quitCount).toBe(0);
      expect(fixture.sessions).toHaveLength(1);
      expect(fixture.controller.getState().kind).toBe('preview');
    }
    fixture.controller.handleInput('\u0011');
    expect(fixture.quitCount).toBe(1);
  });
});
