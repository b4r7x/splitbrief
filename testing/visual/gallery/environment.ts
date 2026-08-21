import type { Viewport } from '../contracts/geometry.js';
import { ViewportSchema } from '../contracts/geometry.js';
import {
  DeterminismEnvelopeSchema,
  TerminalProfileSchema,
  type DeterminismEnvelope,
  type TerminalProfile,
} from '../contracts/manifest-fields.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';

const FIXED_CLOCK = '2026-01-01T00:00:00.000Z';
const RANDOM_SEED = 'splitbrief-visual-v1';
const TERMINAL_PROFILES = TerminalProfileSchema.options;

const PROFILE_ENVIRONMENT = {
  'unicode-color': {
    locale: 'en_US.UTF-8',
    determinismLocale: 'en-US',
    term: 'xterm-256color',
    colorLevel: 3,
    colorterm: 'truecolor',
    forceColor: '3',
    noColor: undefined,
    isTTY: true,
  },
  'unicode-mono': {
    locale: 'en_US.UTF-8',
    determinismLocale: 'en-US',
    term: 'xterm-256color',
    colorLevel: 0,
    colorterm: 'truecolor',
    forceColor: '0',
    noColor: '1',
    isTTY: true,
  },
  'ascii-mono': {
    locale: 'C',
    determinismLocale: 'C',
    term: 'dumb',
    colorLevel: 0,
    colorterm: undefined,
    forceColor: '0',
    noColor: '1',
    isTTY: true,
  },
} as const satisfies Record<
  TerminalProfile,
  Readonly<{
    locale: string;
    determinismLocale: string;
    term: string;
    colorLevel: 0 | 3;
    colorterm: string | undefined;
    forceColor: string;
    noColor: string | undefined;
    isTTY: boolean;
  }>
>;

const ENVIRONMENT_KEYS = [
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'FORCE_HYPERLINK',
  'NO_COLOR',
  'SPLITBRIEF_VISUAL_MOTION',
] as const;

type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];

export interface CaptureEnvironmentOptions {
  readonly viewport: Viewport;
  readonly profile?: string | undefined;
}

export interface CaptureEnvironmentScope {
  readonly determinism: DeterminismEnvelope;
  readonly restore: () => void;
}

export function enterCaptureEnvironment(
  options: CaptureEnvironmentOptions,
): CaptureEnvironmentScope {
  const viewport = ViewportSchema.parse(options.viewport);
  const profile = resolveTerminalProfile(options.profile);
  const profileEnvironment = PROFILE_ENVIRONMENT[profile];
  const savedEnvironment = snapshotEnvironment();
  const savedTerminalSize = terminalSizeStore.get();
  const savedDateNow = Date.now;
  const savedRandom = Math.random;
  const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    Date.now = savedDateNow;
    Math.random = savedRandom;
    restoreEnvironment(savedEnvironment);
    restoreProperty(process.stdout, 'columns', savedColumns);
    restoreProperty(process.stdout, 'rows', savedRows);
    restoreProperty(process.stdout, 'isTTY', savedIsTTY);
    terminalSizeStore.__testReset(savedTerminalSize);
  };

  try {
    applyEnvironment(profileEnvironment);
    setProperty(process.stdout, 'columns', viewport.cols);
    setProperty(process.stdout, 'rows', viewport.rows);
    setProperty(process.stdout, 'isTTY', profileEnvironment.isTTY);
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

  const parsedDeterminism = DeterminismEnvelopeSchema.parse({
    timezone: 'UTC',
    locale: profileEnvironment.determinismLocale,
    term: profileEnvironment.term,
    colorLevel: profileEnvironment.colorLevel,
    hyperlinks: false,
    motion: false,
    clock: FIXED_CLOCK,
    randomSeed: RANDOM_SEED,
    profile,
  });

  return { determinism: parsedDeterminism, restore };
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
  return new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
}

function applyEnvironment(profile: (typeof PROFILE_ENVIRONMENT)[TerminalProfile]): void {
  const values: Readonly<Record<EnvironmentKey, string | undefined>> = {
    TZ: 'UTC',
    LANG: profile.locale,
    LC_ALL: profile.locale,
    LC_CTYPE: profile.locale,
    TERM: profile.term,
    COLORTERM: profile.colorterm,
    FORCE_COLOR: profile.forceColor,
    FORCE_HYPERLINK: '0',
    NO_COLOR: profile.noColor,
    SPLITBRIEF_VISUAL_MOTION: '0',
  };
  for (const key of ENVIRONMENT_KEYS) {
    const value = values[key];
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

function setProperty(target: object, key: string, value: unknown): void {
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
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
}

function resolveTerminalProfile(value: string | undefined): TerminalProfile {
  const profile = value ?? TERMINAL_PROFILES[0];
  const parsed = TerminalProfileSchema.safeParse(profile);
  if (parsed.success) return parsed.data;
  throw new Error(
    `Unknown terminal profile "${profile}". Available profiles: ${TERMINAL_PROFILES.join(', ')}.`,
  );
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
