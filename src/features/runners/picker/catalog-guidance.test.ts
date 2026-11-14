import { describe, expect, it } from 'vitest';
import {
  formatCatalogDiagnostic,
  formatModelCatalogGuidance,
  type ModelCatalogDiagnostic,
} from './catalog-guidance.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { PickerOption } from '../model-catalog/options.js';
import { deriveModelCatalogCapability } from '../model-catalog/posture.js';

const zeroCounts = { confirmed: 0, stale: 0, suggestions: 0, bundled: 0, custom: 0 };

function readyCliTool(): PickerOption {
  return {
    id: 'codex',
    displayName: 'Codex',
    kind: 'cli',
    roles: ['planner', 'implementer'],
    modelPolicy: 'optional',
    modelCapability: deriveModelCatalogCapability('optional', false),
    billing: 'subscription-included',
    permissions: {
      directWrite: false,
      network: true,
      shell: false,
      automaticApproval: false,
      sandbox: 'none',
    },
    status: { state: 'ready', remediation: null },
    available: true,
  };
}

describe('formatModelCatalogGuidance', () => {
  it('counts only confirmed models as detected', () => {
    expect(formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, confirmed: 2 })).toEqual({
      headline: '2 models detected · custom models allowed',
      detail: undefined,
    });
    expect(
      formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, confirmed: 1, suggestions: 4 })
        .headline,
    ).toContain('1 model detected');
  });

  it('never sums provenances into one suggestion count when nothing is confirmed', () => {
    const guidance = formatModelCatalogGuidance(readyCliTool(), {
      ...zeroCounts,
      suggestions: 2,
      bundled: 1,
    });

    expect(guidance.headline).not.toMatch(/\b3\b/);
    expect(guidance.headline).not.toContain('detected');
  });

  it('reports detection in progress instead of an empty catalog while discovery refreshes', () => {
    expect(formatModelCatalogGuidance(readyCliTool(), zeroCounts, undefined, true)).toEqual({
      headline: 'Detecting models…',
      detail: undefined,
    });
    expect(
      formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, suggestions: 2 }, undefined, true)
        .headline,
    ).toBe('Detecting models…');
    expect(
      formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, confirmed: 1 }, undefined, true)
        .headline,
    ).toContain('1 model detected');
  });

  it('leads with the no-listing sentence for a tool that cannot list models', () => {
    const guidance = formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, bundled: 3 }, {
      kind: 'unsupported',
    } satisfies ModelCatalogDiagnostic);

    expect(guidance.headline).toContain('does not support model listing');
    expect(guidance.detail).toBeUndefined();
  });

  it('does not claim aliases are offered when a live catalog lane hides bundled rows', () => {
    const guidance = formatModelCatalogGuidance(
      readyCliTool(),
      { ...zeroCounts, confirmed: 0, suggestions: 4, bundled: 3 },
      { kind: 'unsupported' } satisfies ModelCatalogDiagnostic,
    );

    expect(guidance.headline).toContain('does not support model listing');
    expect(guidance.detail ?? '').not.toContain('aliases');
  });

  it('keeps the refresh remediation for a truly empty catalog', () => {
    expect(formatModelCatalogGuidance(readyCliTool(), zeroCounts)).toEqual({
      headline: 'No models detected',
      detail: 'Press ctrl+r to refresh detection',
    });
  });

  it('counts configured providers in the headline when the tool reports them', () => {
    const tool: PickerOption = {
      ...readyCliTool(),
      status: {
        state: 'ready',
        remediation: null,
        configuredProviders: ['GitHub Copilot', 'Alibaba Coding Plan'],
      },
    };

    expect(formatModelCatalogGuidance(tool, { ...zeroCounts, confirmed: 2 })).toEqual({
      headline: '2 models detected · custom models allowed · 2 providers configured',
      detail: undefined,
    });
  });

  it('uses the singular provider noun for one configured provider', () => {
    const tool: PickerOption = {
      ...readyCliTool(),
      status: { state: 'ready', remediation: null, configuredProviders: ['GitHub Copilot'] },
    };

    expect(formatModelCatalogGuidance(tool, zeroCounts).headline).toBe(
      'No models detected · 1 provider configured',
    );
  });
});

describe('formatCatalogDiagnostic', () => {
  it.each([
    [{ kind: 'not-probed' }, 'Model detection has not run yet. Press ctrl+r to refresh'],
    [{ kind: 'probe-failed', failure: 'unsupported' }, 'OpenCode does not support model listing'],
    [
      { kind: 'probe-failed', failure: 'missing-credential' },
      'Sign in to OpenCode to detect its models',
    ],
    [
      { kind: 'probe-failed', failure: 'invalid-credential' },
      'OpenCode sign-in was rejected. Sign in again',
    ],
    [{ kind: 'probe-failed', failure: 'policy-denied' }, 'OpenCode denied model catalog access'],
    [
      { kind: 'probe-failed', failure: 'offline' },
      'Model detection could not reach the network. Press ctrl+r to retry',
    ],
    [
      { kind: 'probe-failed', failure: 'timeout' },
      'Model detection timed out. Press ctrl+r to retry',
    ],
    [
      { kind: 'probe-failed', failure: 'cancelled' },
      'Model detection was cancelled. Press ctrl+r to retry',
    ],
    [
      { kind: 'probe-failed', failure: 'not-run' },
      'Model detection has not run yet. Press ctrl+r to refresh',
    ],
    [
      { kind: 'not-run-retained' },
      `Models from an earlier check${SOFT_SEP}ctrl+r detects this tool's models`,
    ],
    [
      {
        kind: 'probe-failed',
        failure: 'command-failed',
        cause: 'Server at http://127.0.0.1:49374 did not provide a compatible V2 health response',
      },
      `OpenCode could not list models: Server at http://127.0.0.1:49374 did not provide a compatible V2 health response${SOFT_SEP}ctrl+r to retry`,
    ],
  ] satisfies Array<[ModelCatalogDiagnostic, string]>)(
    'gives actionable copy for %j',
    (diagnostic, copy) => {
      expect(formatCatalogDiagnostic(diagnostic, 'OpenCode')).toBe(copy);
    },
  );

  /**
   * The four states an operator most often confuses. Each one has to name its own next step, and an
   * unreachable network must never be answered with a sign-in the tool did not ask for.
   */
  it('keeps offline, unauthorized and a detection in progress distinct and separately actionable', () => {
    const offline = formatCatalogDiagnostic(
      { kind: 'probe-failed', failure: 'offline' },
      'OpenCode',
    );
    const missingCredential = formatCatalogDiagnostic(
      { kind: 'probe-failed', failure: 'missing-credential' },
      'OpenCode',
    );
    const invalidCredential = formatCatalogDiagnostic(
      { kind: 'probe-failed', failure: 'invalid-credential' },
      'OpenCode',
    );
    const loading = formatModelCatalogGuidance(readyCliTool(), zeroCounts, undefined, true);

    expect(offline).toContain('ctrl+r');
    expect(offline).not.toMatch(/sign in/i);
    expect(missingCredential).toMatch(/sign in/i);
    expect(invalidCredential).toMatch(/sign in again/i);
    expect(loading).toEqual({ headline: 'Detecting models…', detail: undefined });

    expect(new Set([offline, missingCredential, invalidCredential, loading.headline]).size).toBe(4);
  });
});
