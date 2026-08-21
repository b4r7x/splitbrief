import { describe, expect, it } from 'vitest';
import { DeterminismEnvelopeSchema, TerminalProfileSchema } from './contracts/manifest-fields.js';
import { elementId } from './contracts/identifiers.js';
import {
  ArtifactProvenanceSchema,
  captureAccountingKey,
  CaptureSelectionSchema,
} from './contracts/selection.js';
import { createFrameIdentity, createVisualProvenance } from './visual-contract-fixtures.js';

const profiles = ['unicode-color', 'unicode-mono', 'ascii-mono'] as const;

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
    const selections = profiles.map((profile) =>
      CaptureSelectionSchema.parse({ ...selectionInput(), profile }),
    );
    const provenances = selections.map((selection) => selection.targets[0]?.provenance);
    if (provenances.some((provenance) => provenance === undefined)) {
      throw new Error('profile fixture did not produce a target provenance');
    }

    const definedProvenances = provenances.filter(
      (provenance): provenance is NonNullable<typeof provenance> => provenance !== undefined,
    );
    expect(definedProvenances).toHaveLength(profiles.length);
    const first = definedProvenances[0];
    if (first === undefined) throw new Error('profile fixture has no provenance');
    expect(definedProvenances[1]).toEqual(first);
    expect(definedProvenances[2]).toEqual(first);
    expect(definedProvenances.map((provenance) => captureAccountingKey(provenance))).toEqual([
      captureAccountingKey(first),
      captureAccountingKey(first),
      captureAccountingKey(first),
    ]);
    expect(definedProvenances.map((provenance) => createFrameIdentity(provenance).key)).toEqual([
      createFrameIdentity(first).key,
      createFrameIdentity(first).key,
      createFrameIdentity(first).key,
    ]);
    expect(ArtifactProvenanceSchema.safeParse({ ...first, profile: 'ascii-mono' }).success).toBe(
      false,
    );
  });
});
