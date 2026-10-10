import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKPOINT_RESTORE_SAFETY } from '../../../snapshots/checkpoint-summary.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readBriefQuality, readCheckpoints, readPacketEvents, readReadiness } from './artifacts.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'review-packet-artifacts-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readCheckpoints', () => {
  it('surfaces checkpoint restore safety metadata on the review packet', async () => {
    const missing: string[] = [];
    const checkpoints = await readCheckpoints(tmp, 'sess-01', missing);

    expect(checkpoints.safety).toEqual(CHECKPOINT_RESTORE_SAFETY);
    expect(checkpoints.safety.excludedPaths).not.toBe(CHECKPOINT_RESTORE_SAFETY.excludedPaths);
    expect(missing).toContain('snapshots/run-ledger.json');
  });
});

describe('readBriefQuality', () => {
  it('reads a run without brief-quality.json as having nothing missing', () => {
    const missing: string[] = [];

    expect(readBriefQuality(tmp, 'sess-01', missing)).toBeNull();
    expect(missing).toEqual([]);
  });

  it("names an old run's malformed brief-quality.json as missing", () => {
    const dir = join(tmp, '.splitbrief', 'sessions', 'sess-01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'brief-quality.json'), '{"version":1}');
    const missing: string[] = [];

    expect(readBriefQuality(tmp, 'sess-01', missing)).toBeNull();
    expect(missing).toEqual(['brief-quality.json']);
  });
});

describe('packet recovery artifacts', () => {
  it('preserves the recovery headline and automatic switch evidence', async () => {
    const dir = join(tmp, '.splitbrief', 'sessions', 'sess-01');
    mkdirSync(dir, { recursive: true });
    const records = [
      {
        ts: '2026-10-10T12:57:09.795Z',
        kind: 'event',
        type: 'recovery_prompted',
        taskId: 'T001',
        phase: 'implementing',
        data: {
          issueId: 'rec_balance',
          reason: 'runner-usage-limit',
          headline: 'Balance spent on OpenCode CLI',
        },
      },
      {
        ts: '2026-10-10T12:57:12.126Z',
        kind: 'event',
        type: 'seat_switched',
        phase: 'implementing',
        data: {
          seat: 'build',
          from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
          to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
          cause: 'runner-usage-limit',
          accountCause: 'balance',
          headline: 'Balance spent on OpenCode CLI',
          auto: true,
          configRevision: 'revision',
        },
      },
    ];
    writeFileSync(
      join(dir, 'session.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const events = await readPacketEvents(tmp, 'sess-01', []);
    const prompted = events.find((event) => event.type === 'recovery_prompted');
    const switched = events.find((event) => event.type === 'seat_switched');
    if (prompted === undefined) throw new Error('Missing recovery_prompted');

    expect(prompted.message).toBe('Balance spent on OpenCode CLI');
    expect(prompted.reason).toBe('runner-usage-limit');
    expect(switched).toMatchObject({
      type: 'seat_switched',
      seat: 'build',
      auto: true,
      accountCause: 'balance',
      cause: 'runner-usage-limit',
      headline: 'Balance spent on OpenCode CLI',
      configRevision: 'revision',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
    });
  });

  it('carries admission time and preserves the original readiness warning', () => {
    const dir = join(tmp, '.splitbrief', 'sessions', 'sess-01');
    mkdirSync(dir, { recursive: true });
    const warning =
      'Default implementer opencode (deepseek/deepseek-flash) can execute commands on this machine.';
    writeFileSync(
      join(dir, 'readiness.json'),
      JSON.stringify({
        type: 'start-readiness',
        generatedAt: '2026-10-10T12:56:00.000Z',
        status: 'ready-with-warnings',
        nextAction: 'continue',
        blockerCount: 0,
        warningCount: 1,
        checks: [{ id: 'implementer', severity: 'warning', summary: warning }],
      }),
    );
    const readiness = readReadiness(tmp, 'sess-01', []);

    expect(readiness.generatedAt).toBe('2026-10-10T12:56:00.000Z');
    expect(readiness.checks[0]?.summary).toBe(warning);
  });
});
