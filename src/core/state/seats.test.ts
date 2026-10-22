import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../paths-io.js';
import { SEATS_FILE, sessionDir } from '../paths.js';
import { createInitialState, transition } from './machine.js';
import { saveState } from './persistence.js';
import {
  formatSeatChangeNotice,
  readSeatIdentities,
  readSeatIdentityRecord,
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
  it('records the catalog identity that the crew displays', () => {
    const ref = session('seats-catalog');
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } });

    recordSeatIdentities(ref, config, { build: 'GPT-6-Luna' });

    expect(readSeatIdentities(ref)?.build).toBe('OpenAI Codex CLI · GPT-6-Luna');
  });

  it('writes seats.json beside state.json', () => {
    const ref = session('seats-write');

    recordSeatIdentities(ref, makeConfig());

    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), SEATS_FILE))).toBe(true);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(makeConfig()));
    expect(readSeatIdentityRecord(ref)?.switchCount).toBe(0);
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
  it('refreshes catalog labels without reporting unchanged ids as a moved seat', () => {
    const ref = session('seats-catalog-rename');
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } });
    recordSeatIdentities(ref, config);

    expect(reconcileSeatIdentities(ref, config, { build: 'GPT-6-Luna' })).toEqual([]);
    expect(readSeatIdentities(ref)?.build).toBe('OpenAI Codex CLI · GPT-6-Luna');
  });

  it('reports different ids even when the catalog gives them the same name', () => {
    const before = seatIdentitiesFromConfig(
      makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'model-a' } }),
      { build: 'Shared name' },
    );
    const after = seatIdentitiesFromConfig(
      makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'model-b' } }),
      { build: 'Shared name' },
    );

    expect(seatIdentityChanges(before, after).map((change) => change.seat)).toEqual(['build']);
  });

  it('reports what moved and re-records the crew the run is about to use', () => {
    const ref = session('seats-reconcile');
    const current = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
    recordSeatIdentities(ref, makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }));

    const changes = reconcileSeatIdentities(ref, current);

    expect(changes.map((change) => change.seat)).toEqual(['build']);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(current));
  });

  // A brief can route to a BUILD profile other than the default; a seat saved for that profile
  // runs that brief, so the record names it as a move the same way it names the default's.
  const profiles = (small: { tool: 'antigravity' | 'claude-code'; model: string }) =>
    makeConfig({
      implementerProfiles: {
        default: 'big',
        profiles: {
          big: { kind: 'cli', tool: 'claude-code', model: 'haiku' },
          small: { kind: 'cli', ...small },
        },
      },
    });

  it('reports a seat moved on a BUILD profile other than the default', () => {
    const ref = session('seats-reconcile-profile');
    recordSeatIdentities(ref, profiles({ tool: 'antigravity', model: 'gemini-nonexistent-9' }));
    const current = profiles({ tool: 'claude-code', model: 'haiku' });

    const changes = reconcileSeatIdentities(ref, current);

    expect(changes).toEqual([
      expect.objectContaining({
        seat: 'build',
        profile: 'small',
        beforeIds: expect.objectContaining({ tool: 'antigravity', model: 'gemini-nonexistent-9' }),
        afterIds: expect.objectContaining({ tool: 'claude-code', model: 'haiku' }),
      }),
    ]);
    expect(reconcileSeatIdentities(ref, current)).toEqual([]);
  });

  it('leaves the record alone when the crew did not move', () => {
    const ref = session('seats-reconcile-same');
    const config = makeConfig();
    recordSeatIdentities(ref, config);

    expect(reconcileSeatIdentities(ref, config)).toEqual([]);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(config));
  });

  it('records appended switches even when the crew did not move', () => {
    const ref = session('seats-switch-count');
    const config = makeConfig();
    const action = {
      type: 'RECORD_SEAT_SWITCH',
      seat: 'build',
      from: 'Claude Code CLI · Sonnet 5.5 · high',
      to: 'Claude Code CLI · Sonnet 5.5 · max',
      toSeat: { tool: 'claude-code', model: 'sonnet', effort: 'max' },
      cause: 'runner-usage-limit',
      auto: false,
      configRevision: 'switched',
    } as const;
    const switched = transition(createInitialState('switch count'), action);
    saveState(ref, switched);
    recordSeatIdentities(ref, config);
    expect(readSeatIdentityRecord(ref)?.switchCount).toBe(1);

    saveState(ref, transition(switched, action));
    expect(reconcileSeatIdentities(ref, config)).toEqual([]);
    expect(readSeatIdentityRecord(ref)?.switchCount).toBe(2);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(config));
  });

  it('adds the switch count to an unchanged record that predates it', () => {
    const ref = session('seats-count-upgrade');
    const config = makeConfig();
    writeFileSync(
      join(sessionDir(ref.projectDir, ref.sessionId), SEATS_FILE),
      JSON.stringify(seatIdentitiesFromConfig(config)),
    );
    expect(readSeatIdentityRecord(ref)?.switchCount).toBeUndefined();

    expect(reconcileSeatIdentities(ref, config)).toEqual([]);

    expect(readSeatIdentityRecord(ref)?.switchCount).toBe(0);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(config));
  });

  it('keeps the ids each identity was spelled from, beside the identities it compares', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
    });

    expect(seatIdentitiesFromConfig(config)).toMatchObject({
      plan: 'Claude Code CLI · Opus 5.5 · max',
      ids: { plan: { tool: 'claude-code', model: 'opus', axes: ['max'], kind: 'cli' } },
    });
  });

  it('re-records a review seat that stopped following the planner for the same tool and model', () => {
    const ref = session('seats-review-follow');
    recordSeatIdentities(ref, makeConfig());
    expect(readSeatIdentities(ref)?.reviewFollowsPlan).toBe(true);
    const ownReviewer = makeConfig({ reviewer: { kind: 'cli', tool: 'claude-code' } });

    expect(reconcileSeatIdentities(ref, ownReviewer)).toEqual([]);

    expect(readSeatIdentities(ref)?.reviewFollowsPlan).toBe(false);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(ownReviewer));
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

  const idLevelSeat = { kind: 'cli', tool: 'antigravity', model: 'gemini-3.8-flash-high' } as const;
  const idLevelConfig = makeConfig({
    planner: idLevelSeat,
    implementer: idLevelSeat,
    reviewer: idLevelSeat,
  });
  // The bytes an older version wrote for this crew: the axes held the effort flag alone.
  const legacyIds = {
    tool: 'antigravity',
    model: idLevelSeat.model,
    axes: [],
    kind: 'cli',
  } as const;
  const legacyIdentity = 'Google Antigravity CLI · Gemini 3.8 Flash (High)';
  const idLevelLegacy = {
    plan: legacyIdentity,
    build: legacyIdentity,
    review: legacyIdentity,
    ids: { plan: legacyIds, build: legacyIds, review: legacyIds },
  };

  it('reads a model-id seat recorded without the level its id spells as the same seat', () => {
    const ref = session('seats-reconcile-id-level');
    writeFileSync(
      join(sessionDir(ref.projectDir, ref.sessionId), SEATS_FILE),
      `${JSON.stringify(idLevelLegacy, null, 2)}\n`,
    );

    expect(reconcileSeatIdentities(ref, idLevelConfig)).toEqual([]);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(idLevelConfig));
  });

  it('reports a resume change from a recorded low effort flag to the high model id', () => {
    const ref = session('seats-reconcile-recorded-effort');
    writeSeatIdentities(ref, {
      ...idLevelLegacy,
      build: 'Google Antigravity CLI · Gemini 3.8 Flash · low',
      ids: {
        ...idLevelLegacy.ids,
        build: { ...legacyIds, axes: ['low'] },
      },
    });

    const changes = reconcileSeatIdentities(ref, idLevelConfig);

    expect(changes.map(formatSeatChangeNotice)).toEqual([
      'BUILD seat changed Google Antigravity CLI · Gemini 3.8 Flash · low → Google Antigravity CLI · Gemini 3.8 Flash · high; the rest of the run uses the new seat',
    ]);
    expect(readSeatIdentities(ref)).toEqual(seatIdentitiesFromConfig(idLevelConfig));
  });

  it('reports a move to the id of another level', () => {
    const current = seatIdentitiesFromConfig(
      makeConfig({
        planner: idLevelSeat,
        implementer: { ...idLevelSeat, model: 'gemini-3.8-flash-low' },
        reviewer: idLevelSeat,
      }),
    );

    expect(seatIdentityChanges(idLevelLegacy, current).map((change) => change.seat)).toEqual([
      'build',
    ]);
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

describe('seat identities ignore the declared fallback', () => {
  it('reads a fallback-only edit as no seat change', () => {
    const before = seatIdentitiesFromConfig(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
      }),
    );
    const after = seatIdentitiesFromConfig(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'opencode' } },
      }),
    );

    expect(after).toEqual(before);
  });

  it('keeps the fallback out of the recorded ids', () => {
    const identities = seatIdentitiesFromConfig(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
      }),
    );

    expect(identities.ids?.plan).not.toHaveProperty('fallback');
  });
});
