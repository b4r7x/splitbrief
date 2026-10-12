import type { LiveCrew } from '../helpers/live-harness.js';
import { resolveReleaseMatrixSeat } from './matrix.js';

export type FixtureRow = Readonly<{
  id: string;
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
    id: 'fixture-claude-cmd-codex',
    fixture: 'add-endpoint',
    feature: FIXTURE_FEATURE,
    expectedBriefs: { min: 1, max: 3 },
    plan: 'claude-code',
    build: 'command-code',
    review: 'codex',
    timeoutMs: 900_000,
  },
];

export function resolveFixtureRowSeats(row: FixtureRow): LiveCrew {
  return {
    plan: resolveReleaseMatrixSeat(row.plan),
    build: resolveReleaseMatrixSeat(row.build),
    review: resolveReleaseMatrixSeat(row.review),
  };
}
