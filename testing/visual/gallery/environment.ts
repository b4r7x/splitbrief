import type { Viewport } from '../contracts/geometry.js';
import { ViewportSchema } from '../contracts/geometry.js';
import {
  DeterminismEnvelopeSchema,
  type DeterminismEnvelope,
} from '../contracts/manifest-fields.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

const FIXED_CLOCK = '2026-01-01T00:00:00.000Z';
const RANDOM_SEED = 'diptych-visual-v1';
const ENVIRONMENT_VALUES = {
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  FORCE_COLOR: '3',
  FORCE_HYPERLINK: '0',
  NO_COLOR: undefined,
  DIPTYCH_VISUAL_MOTION: '0',
} as const;

type EnvironmentKey = keyof typeof ENVIRONMENT_VALUES;

export interface CaptureEnvironmentOptions {
  readonly viewport: Viewport;
}

export interface CaptureEnvironmentScope {
  readonly determinism: DeterminismEnvelope;
  readonly restore: () => void;
}

export function enterCaptureEnvironment(
  options: CaptureEnvironmentOptions,
): CaptureEnvironmentScope {
  const viewport = ViewportSchema.parse(options.viewport);
  const savedEnvironment = snapshotEnvironment();
  const savedTerminalSize = terminalSizeStore.get();
  const savedDateNow = Date.now;
  const savedRandom = Math.random;
  const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    Date.now = savedDateNow;
    Math.random = savedRandom;
    restoreEnvironment(savedEnvironment);
    restoreProperty(process.stdout, 'columns', savedColumns);
    restoreProperty(process.stdout, 'rows', savedRows);
    terminalSizeStore.__testReset(savedTerminalSize);
  };

  try {
    applyEnvironment();
    setProperty(process.stdout, 'columns', viewport.cols);
    setProperty(process.stdout, 'rows', viewport.rows);
    terminalSizeStore.__testReset({
      ...viewport,
      isSmall: viewport.cols < 120,
    });
    Date.now = () => Date.parse(FIXED_CLOCK);
    Math.random = createSeededRandom(RANDOM_SEED);
  } catch (error) {
    restore();
    throw error;
  }

  return {
    determinism: DeterminismEnvelopeSchema.parse({
      timezone: 'UTC',
      locale: 'en-US',
      term: 'xterm-256color',
      colorLevel: 3,
      hyperlinks: false,
      motion: false,
      clock: FIXED_CLOCK,
      randomSeed: RANDOM_SEED,
    }),
    restore,
  };
}

export async function withCaptureEnvironment<T>(
  options: CaptureEnvironmentOptions,
  run: (scope: CaptureEnvironmentScope) => T | Promise<T>,
): Promise<T> {
  const scope = enterCaptureEnvironment(options);
  try {
    return await run(scope);
  } finally {
    scope.restore();
  }
}

export function inCaptureOrder<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return values
    .map((value, index) => ({ value, index, key: key(value) }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en') || left.index - right.index)
    .map(({ value }) => value);
}

function snapshotEnvironment(): ReadonlyMap<EnvironmentKey, string | undefined> {
  return new Map(
    (Object.keys(ENVIRONMENT_VALUES) as EnvironmentKey[]).map((key) => [key, process.env[key]]),
  );
}

function applyEnvironment(): void {
  for (const [key, value] of Object.entries(ENVIRONMENT_VALUES) as [
    EnvironmentKey,
    string | undefined,
  ][]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnvironment(saved: ReadonlyMap<EnvironmentKey, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setProperty(target: NodeJS.WriteStream, key: 'columns' | 'rows', value: number): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor !== undefined && !descriptor.configurable && !descriptor.writable) {
    throw new Error(`Cannot set deterministic stdout ${key}`);
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value,
  });
}

function restoreProperty(
  target: NodeJS.WriteStream,
  key: 'columns' | 'rows',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) delete target[key];
  else Object.defineProperty(target, key, descriptor);
}

function createSeededRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (const character of seed) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
