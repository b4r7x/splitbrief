import { describe, expect, it } from 'vitest';
import { DeterminismEnvelopeSchema, TerminalProfileSchema } from './contracts/manifest-fields.js';
import { elementId } from './contracts/identifiers.js';
import { containsUnsafeNetworkReference } from './contracts/network-policy.js';
import { isSafePersistedTerminalText } from './contracts/persisted-data.js';
import {
  ArtifactProvenanceSchema,
  captureAccountingKey,
  CaptureSelectionSchema,
} from './contracts/selection.js';
import {
  createFrameIdentity,
  createVisualProvenance,
  requireProvenance,
} from './visual-contract-fixtures.js';

const profiles = [
  'unicode-color',
  'unicode-256',
  'unicode-light',
  'unicode-mono',
  'ascii-mono',
] as const;

function selectionInput() {
  const provenance = createVisualProvenance();
  const entry = { provenance, elementIds: [elementId('hero')] };
  return { requests: [entry], targets: [entry] };
}

function determinismInput() {
  return {
    timezone: 'UTC',
    locale: 'en-US',
    term: 'xterm-256color',
    colorLevel: 3,
    hyperlinks: false,
    motion: false,
    clock: '2026-07-19T00:00:00.000Z',
    randomSeed: 'visual-contracts-v1',
  };
}

describe('terminal profile selection contract', () => {
  it('can capture fixed local-server examples without admitting operator addresses or tokens', () => {
    for (const port of [11434, 1234, 8080]) {
      const address = `http://localhost:${port}/v1`;
      expect(containsUnsafeNetworkReference({ value: address })).toBe(false);
      expect(isSafePersistedTerminalText(`Address ${address}`)).toBe(true);
    }
    for (const address of [
      'http://localhost:9000/v1',
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/private',
      'http://localhost:11434/v1?token=private',
      'http://localhost:11434/v1#private',
      'http://user:secret@localhost:11434/v1',
      'http://192.168.1.2:11434/v1',
    ]) {
      expect(containsUnsafeNetworkReference({ value: address })).toBe(true);
    }
  });
  it.each(profiles)('round-trips the explicit %s profile', (profile) => {
    const selection = CaptureSelectionSchema.parse({ ...selectionInput(), profile });
    const determinism = DeterminismEnvelopeSchema.parse({ ...determinismInput(), profile });

    expect(selection.profile).toBe(profile);
    expect(determinism.profile).toBe(profile);
    expect(JSON.parse(JSON.stringify(selection)).profile).toBe(profile);
    expect(JSON.parse(JSON.stringify(determinism)).profile).toBe(profile);
  });

  it('canonicalizes omitted legacy fields to unicode-color and serializes them', () => {
    const selection = CaptureSelectionSchema.parse(selectionInput());
    const determinism = DeterminismEnvelopeSchema.parse(determinismInput());

    expect(selection.profile).toBe('unicode-color');
    expect(determinism.profile).toBe('unicode-color');
    expect(JSON.parse(JSON.stringify(selection))).toHaveProperty('profile', 'unicode-color');
    expect(JSON.parse(JSON.stringify(determinism))).toHaveProperty('profile', 'unicode-color');
  });

  it('rejects unknown, null, blank, and extra profile fields instead of defaulting', () => {
    for (const value of ['unicode-rainbow', null, '', '   ']) {
      expect(
        CaptureSelectionSchema.safeParse({ ...selectionInput(), profile: value }).success,
      ).toBe(false);
      expect(
        DeterminismEnvelopeSchema.safeParse({ ...determinismInput(), profile: value }).success,
      ).toBe(false);
    }

    expect(
      CaptureSelectionSchema.safeParse({ ...selectionInput(), terminalProfile: 'unicode-mono' })
        .success,
    ).toBe(false);
    expect(
      DeterminismEnvelopeSchema.safeParse({
        ...determinismInput(),
        terminalProfile: 'unicode-mono',
      }).success,
    ).toBe(false);
    expect(TerminalProfileSchema.safeParse('future-profile').success).toBe(false);
  });

  it('keeps provenance and frame identity independent of the run profile', () => {
    const provenances = profiles.map((profile) =>
      requireProvenance(CaptureSelectionSchema.parse({ ...selectionInput(), profile })),
    );
    const first = provenances[0];
    if (first === undefined) throw new Error('profile fixture did not produce a target provenance');

    expect(provenances).toEqual(profiles.map(() => first));
    for (const profile of profiles) {
      expect(captureAccountingKey(first)).not.toContain(profile);
      expect(createFrameIdentity(first).key).not.toContain(profile);
    }
    expect(ArtifactProvenanceSchema.safeParse({ ...first, profile: 'ascii-mono' }).success).toBe(
      false,
    );
  });
});
