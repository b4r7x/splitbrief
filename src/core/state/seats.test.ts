import { existsSync } from 'node:fs';
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
});
