import { describe, expect, it } from 'vitest';
import type { CliToolDetection, ProviderDetection } from './detection.js';
import {
  admitStart,
  deriveRunnerStatus,
  legacyDetectionFromRunnerEvidence,
  runnerEvidenceFromCliToolDetection,
  runnerEvidenceFromProviderDetection,
  type AuthFact,
  type ProbeOutcome,
  type RunnerEvidence,
  type RunnerEvidenceSource,
  type StartFact,
} from './runner-evidence.js';

function freshEvidence(
  input: {
    auth?: AuthFact;
    credential?: RunnerEvidence['credential'];
    source?: RunnerEvidenceSource;
    endpoint?: ProbeOutcome<null>;
    catalog?: RunnerEvidence['catalog'];
    modelRun?: RunnerEvidence['modelRun'];
    installation?: RunnerEvidence['installation'];
    executable?: RunnerEvidence['executable'];
  } = {},
): RunnerEvidence {
  return {
    runner: { id: 'codex', kind: 'cli', locality: 'unknown', enabled: 'enabled' },
    context: {
      key: 'runner:codex:context-1',
      observedAt: 1_786_000_000_000,
      source: input.source ?? 'fresh',
    },
    installation: input.installation ?? 'installed',
    executable: input.executable ?? {
      kind: 'trusted',
      identity: {
        canonicalPath: '/opt/splitbrief/bin/codex',
        realPath: '/opt/splitbrief/bin/codex',
        platformFileId: '1:2',
        fingerprint: `1:2:3:4:sha256:${'a'.repeat(64)}`,
        resolvedAt: 1_786_000_000_000,
      },
    },
    compatibility: {
      kind: 'compatible',
      installedVersion: '0.40.0',
      testedVersion: '0.40.0',
    },
    credential: input.credential ?? 'unknown',
    auth: input.auth ?? 'verified',
    endpoint: input.endpoint ?? { kind: 'not-run' },
    catalog: input.catalog ?? { kind: 'not-run' },
    modelRun: input.modelRun ?? {
      kind: 'unknown',
      selectionId: 'gpt-5',
      observedAt: 1_786_000_000_000,
      contextKey: 'runner:codex:context-1',
    },
  };
}

function startAdmission(evidence: RunnerEvidence, requiredFacts: readonly StartFact[] = []) {
  return admitStart({
    evidence,
    expectedContextKey: 'runner:codex:context-1',
    expectedSelectionId: 'gpt-5',
    requiredFacts,
    interaction: 'interactive',
    runnerTier: 'first-class',
    unverifiedAuth: 'denied',
  });
}

describe('runner evidence', () => {
  it('does not promote version-only or credential-present legacy facts to verified authentication', () => {
    const cliDetection: CliToolDetection = {
      tool: 'codex',
      executable: {
        path: '/opt/splitbrief/bin/codex',
        fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      },
      trust: 'trusted',
      installedVersion: '0.40.0',
      testedVersion: '0.40.0',
      compatibility: 'compatible',
      auth: 'authenticated',
      diagnostic: { state: 'ready', remediation: null },
      probedAt: 1_786_000_000_000,
    };
    const providerWithKey: ProviderDetection = {
      provider: 'openai',
      available: true,
      isLocal: false,
      hasKey: true,
    };
    const providerWithoutKey: ProviderDetection = { ...providerWithKey, hasKey: false };

    const cliEvidence = runnerEvidenceFromCliToolDetection(cliDetection);
    const providerEvidence = runnerEvidenceFromProviderDetection(providerWithKey);
    const providerEvidenceWithoutKey = runnerEvidenceFromProviderDetection(providerWithoutKey);

    expect(cliEvidence.auth).toBe('unknown');
    expect(cliEvidence.executable).toEqual({ kind: 'unknown' });
    expect(providerEvidence).toMatchObject({ credential: 'present', auth: 'unknown' });
    expect(providerEvidenceWithoutKey).toMatchObject({ credential: 'absent', auth: 'unknown' });
    expect(startAdmission(cliEvidence, ['authentication'])).toEqual({
      kind: 'denied',
      reason: { kind: 'evidence-source', source: 'legacy-projection' },
    });
  });

  it('keeps an installed runner configurable when authentication is unknown', () => {
    const evidence = freshEvidence({ auth: 'unknown', credential: 'present' });

    expect(deriveRunnerStatus(evidence)).toEqual({
      kind: 'installed-configurable',
      reason: 'unknown',
    });
    expect(startAdmission(evidence, ['authentication'])).toEqual({
      kind: 'denied',
      reason: { kind: 'authentication-unverified' },
    });
  });

  it('reports unknown installation and unresolved executable facts without claiming completion', () => {
    expect(deriveRunnerStatus(freshEvidence({ installation: 'unknown' }))).toEqual({
      kind: 'installation-unresolved',
    });
    expect(deriveRunnerStatus(freshEvidence({ executable: { kind: 'missing' } }))).toEqual({
      kind: 'executable-missing',
    });
  });

  it.each([
    { kind: 'unsupported' },
    { kind: 'missing-credential' },
    { kind: 'invalid-credential' },
    { kind: 'policy-denied' },
    { kind: 'offline' },
    { kind: 'timeout' },
    { kind: 'malformed' },
    { kind: 'cancelled' },
    { kind: 'not-run' },
  ] satisfies readonly ProbeOutcome<null>[])('keeps the $kind probe outcome distinct', (endpoint) => {
    const admission = startAdmission(freshEvidence({ endpoint }), ['reachable-endpoint']);

    expect(admission).toEqual({
      kind: 'denied',
      reason: { kind: 'probe', fact: 'reachable-endpoint', outcome: endpoint.kind },
    });
  });

  it('keeps a successful empty catalog distinct from an endpoint failure', () => {
    const evidence: RunnerEvidence = {
      ...freshEvidence({ catalog: { kind: 'success', value: [] } }),
      runner: { id: 'openai', kind: 'api', locality: 'remote', enabled: 'enabled' },
      endpoint: { kind: 'success', value: null },
    };
    const admission = startAdmission(evidence, ['catalog']);

    expect(deriveRunnerStatus(evidence)).toEqual({ kind: 'catalog-empty' });
    expect(admission).toEqual({ kind: 'admitted' });
  });

  it('rejects cached evidence even when every required fact is verified', () => {
    const admission = startAdmission(freshEvidence({ source: 'cached', auth: 'verified' }), [
      'trusted-executable',
      'compatible-version',
      'authentication',
    ]);

    expect(admission).toEqual({
      kind: 'denied',
      reason: { kind: 'evidence-source', source: 'cached' },
    });
  });

  it('does not reuse a verified model-run fact for a different exact selection', () => {
    const admission = startAdmission(
      freshEvidence({
        modelRun: {
          kind: 'verified-by-last-run',
          selectionId: 'gpt-4',
          observedAt: 1_786_000_000_000,
          contextKey: 'runner:codex:context-1',
        },
      }),
      ['model-run'],
    );

    expect(admission).toEqual({
      kind: 'denied',
      reason: { kind: 'model-context-mismatch' },
    });
  });

  it('projects evidence back to the legacy shape without credential material', () => {
    const legacy = legacyDetectionFromRunnerEvidence({
      evidence: freshEvidence({ auth: 'unknown', credential: 'present' }),
      remediationFor: (state) => `remediation:${state}`,
    });

    expect(legacy).toMatchObject({ auth: 'unknown', diagnostic: { state: 'unverified' } });
    expect(JSON.stringify(legacy)).not.toContain('credential');
  });
});
