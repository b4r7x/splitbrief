import type { LiveSeat } from '../helpers/live-harness.js';
import { resolveReleaseMatrixSeat } from './matrix.js';

export type FixtureMode = 'quick' | 'standard';

export type FixtureRow = Readonly<{
  id: string;
  mode: FixtureMode;
  fixture: 'add-endpoint';
  feature: string;
  expectedBriefs: Readonly<{ min: number; max: number }>;
  plan: string;
  build: string;
  review: string;
  timeoutMs: number;
}>;

const FIXTURE_FEATURE =
  'Add a GET /api/health endpoint that returns { status: "ok", uptime: process.uptime() } and a node:test case for it in test/server.test.mjs';

export const FIXTURE_ROWS: readonly FixtureRow[] = [
  {
    id: 'fixture-quick-claude-cmd-codex',
    mode: 'quick',
    fixture: 'add-endpoint',
    feature: FIXTURE_FEATURE,
    expectedBriefs: { min: 1, max: 3 },
    plan: 'claude-code',
    build: 'command-code',
    review: 'codex',
    timeoutMs: 300_000,
  },
  {
    id: 'fixture-standard-claude-cmd-codex',
    mode: 'standard',
    fixture: 'add-endpoint',
    feature: FIXTURE_FEATURE,
    expectedBriefs: { min: 1, max: 3 },
    plan: 'claude-code',
    build: 'command-code',
    review: 'codex',
    timeoutMs: 900_000,
  },
];

export type FixtureRowSeats = Readonly<{ plan: LiveSeat; build: LiveSeat; review: LiveSeat }>;

export function resolveFixtureRowSeats(row: FixtureRow): FixtureRowSeats {
  return {
    plan: resolveReleaseMatrixSeat(row.plan),
    build: resolveReleaseMatrixSeat(row.build),
    review: resolveReleaseMatrixSeat(row.review),
  };
}
