import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { setupSeatSession } from '#testing/helpers/seat-session.js';
import { SEATS_FILE, sessionDir } from '../../paths.js';
import {
  readSeatIdentities,
  readSeatIdentityRecord,
  recordSeatIdentities,
  seatIdentitiesFromConfig,
} from './record.js';

const session = setupSeatSession();

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
