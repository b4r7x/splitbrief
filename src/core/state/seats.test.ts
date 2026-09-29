import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../paths-io.js';
import { SEATS_FILE, sessionDir } from '../paths.js';
import {
  formatSeatChangeNotice,
  readSeatIdentities,
  reconcileSeatIdentities,
  recordSeatIdentities,
  seatIdentitiesFromConfig,
  seatIdentityChanges,
  writeSeatIdentities,
} from './seats.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function session(name: string): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('recordSeatIdentities', () => {
  it('writes seats.json beside state.json', () => {
    const ref = session('seats-write');

    recordSeatIdentities(ref, makeConfig());

    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), SEATS_FILE))).toBe(true);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(makeConfig()));
  });

  it('keeps the record a session already has', () => {
    const ref = session('seats-keep');
    recordSeatIdentities(ref, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));
    const first = readSeatIdentities(ref);

    recordSeatIdentities(ref, makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }));

    expect(readSeatIdentities(ref)).toEqual(first);
  });
});

describe('seatIdentityChanges', () => {
  it('names the seat that moved', () => {
    const before = seatIdentitiesFromConfig(
      makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
    );
    const after = seatIdentitiesFromConfig(
      makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } }),
    );

    const changes = seatIdentityChanges(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.seat).toBe('build');
    const change = changes[0] ?? { seat: 'build' as const, before: '', after: '' };
    expect(formatSeatChangeNotice(change)).toContain('the rest of the run uses the new seat');
    expect(formatSeatChangeNotice(change)).not.toContain('context will be rebuilt');
  });

  it('promises a rebuilt context only for the plan seat', () => {
    const notice = formatSeatChangeNotice({
      seat: 'plan',
      before: 'Codex · gpt-5',
      after: 'Claude Code · opus',
    });

    expect(notice).toBe(
      'PLAN seat changed Codex · gpt-5 → Claude Code · opus; context will be rebuilt',
    );
  });

  it('reports nothing when no seats were recorded', () => {
    expect(seatIdentityChanges(null, seatIdentitiesFromConfig(makeConfig()))).toEqual([]);
  });
});

describe('reconcileSeatIdentities', () => {
  it('reports what moved and re-records the crew the run is about to use', () => {
    const ref = session('seats-reconcile');
    const current = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    recordSeatIdentities(ref, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));

    const changes = reconcileSeatIdentities(ref, current);

    expect(changes.map((change) => change.seat)).toEqual(['build']);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(current));
  });

  it('leaves the record alone when the crew did not move', () => {
    const ref = session('seats-reconcile-same');
    const config = makeConfig();
    recordSeatIdentities(ref, config);

    expect(reconcileSeatIdentities(ref, config)).toEqual([]);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(config));
  });

  it('keeps the ids each identity was spelled from, beside the identities it compares', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
    });

    expect(seatIdentitiesFromConfig(config)).toMatchObject({
      plan: 'Claude Code CLI · opus · max',
      ids: { plan: { tool: 'claude-code', model: 'opus', axes: ['max'], kind: 'cli' } },
    });
  });

  it('adds the ids to a record written before them, without reporting a change', () => {
    const ref = session('seats-reconcile-upgrade');
    const config = makeConfig();
    const { plan, build, review } = seatIdentitiesFromConfig(config);
    writeSeatIdentities(ref, { plan, build, review });

    expect(reconcileSeatIdentities(ref, config)).toEqual([]);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(config));
  });

  it('reads a record whose ids predate kinds and adds them without a notice', () => {
    const ref = session('seats-reconcile-kind-upgrade');
    const config = makeConfig();
    const current = seatIdentitiesFromConfig(config);
    // The bytes an older version wrote for this crew: the same ids, without the kind.
    const legacy = {
      plan: current.plan,
      build: current.build,
      review: current.review,
      ids: {
        plan: { tool: 'claude-code', axes: [] },
        build: { tool: 'ollama', model: 'qwen2.5-coder:7b', axes: [] },
        review: { tool: 'claude-code', axes: [] },
      },
    };
    writeFileSync(
      join(sessionDir(ref.projectDir, ref.sessionId), SEATS_FILE),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );

    expect(readSeatIdentities(ref)).toEqual(legacy);
    expect(reconcileSeatIdentities(ref, config)).toEqual([]);
    expect(readSeatIdentities(ref)?.ids?.plan?.kind).toBe('cli');
    expect(readSeatIdentities(ref)).toEqual(current);
  });

  it('hands the ids of both sides to whoever names the change', () => {
    const ref = session('seats-reconcile-ids');
    recordSeatIdentities(ref, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));

    const [change] = reconcileSeatIdentities(
      ref,
      makeConfig({ implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } }),
    );

    expect(change).toMatchObject({
      seat: 'build',
      beforeIds: { tool: 'codex' },
      afterIds: { tool: 'claude-code', model: 'sonnet' },
    });
  });
});
