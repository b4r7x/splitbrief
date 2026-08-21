import { describe, expect, it } from 'vitest';
import {
  formatAuthFactsUnavailableNotice,
  formatCatalogDiagnostic,
  formatModelCatalogGuidance,
  formatProviderConfiguredClause,
  formatProviderSignInClause,
  formatStoredCredentialNote,
  formatToolPreview,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';

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

  it('states suggested-catalog truth when nothing is confirmed but suggestions render', () => {
    const guidance = formatModelCatalogGuidance(readyCliTool(), {
      ...zeroCounts,
      suggestions: 2,
      bundled: 1,
    });

    expect(guidance).toEqual({
      headline: 'No models confirmed · 3 suggested from catalog',
      detail: undefined,
    });
  });

  it('reports detection in progress instead of an empty catalog while discovery refreshes', () => {
    expect(formatModelCatalogGuidance(readyCliTool(), zeroCounts, undefined, true)).toEqual({
      headline: 'Detecting models…',
      detail: undefined,
    });
    expect(
      formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, suggestions: 2 }, undefined, true)
        .detail,
    ).toBe('Detecting models…');
    expect(
      formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, confirmed: 1 }, undefined, true)
        .headline,
    ).toContain('1 model detected');
  });

  it('attaches the diagnostic detail to the suggested-catalog headline', () => {
    const diagnostic: ModelCatalogDiagnostic = { kind: 'not-probed' };

    const guidance = formatModelCatalogGuidance(
      readyCliTool(),
      { ...zeroCounts, bundled: 5 },
      diagnostic,
    );

    expect(guidance.headline).toBe('No models confirmed · 5 suggested from catalog');
    expect(guidance.detail).toBe('Select this tool to detect its models');
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

  it('shows the sign-in remediation under the Auth required label for zero providers', () => {
    const tool: PickerOption = {
      ...readyCliTool(),
      status: {
        state: 'unauthenticated',
        remediation: 'Sign in or configure a provider - free models require sign-in.',
      },
      available: false,
    };

    expect(formatModelCatalogGuidance(tool, zeroCounts)).toEqual({
      headline: 'Auth required',
      detail: 'Sign in or configure a provider - free models require sign-in.',
    });
  });

  it('keeps status remediation ahead of any count copy when the tool is not ready', () => {
    const tool: PickerOption = {
      ...readyCliTool(),
      status: { state: 'unauthenticated', remediation: 'Sign in first.' },
      available: false,
    };

    expect(formatModelCatalogGuidance(tool, { ...zeroCounts, suggestions: 3 })).toEqual({
      headline: 'Auth required',
      detail: 'Sign in first.',
    });
  });
});

describe('formatToolPreview with configured providers', () => {
  it('ends the preview strip with the provider names so truncation cuts them first', () => {
    const tool: PickerOption = {
      ...readyCliTool(),
      status: {
        state: 'ready',
        remediation: null,
        configuredProviders: ['GitHub Copilot', 'Alibaba Coding Plan'],
      },
    };

    const preview = formatToolPreview(tool, { ...zeroCounts, confirmed: 3 });

    expect(preview).toContain('2 providers configured');
    expect(preview.endsWith('GitHub Copilot, Alibaba Coding Plan')).toBe(true);
  });

  it('adds no provider copy when readiness is presence-derived', () => {
    const preview = formatToolPreview(readyCliTool(), { ...zeroCounts, confirmed: 3 });

    expect(preview).not.toContain('provider configured');
    expect(preview).not.toContain('providers configured');
  });
});

describe('formatCatalogDiagnostic', () => {
  it.each([
    [{ kind: 'not-probed' }, 'Select this tool to detect its models'],
    [{ kind: 'probe-failed', failure: 'unsupported' }, 'Aider does not support model listing'],
    [
      { kind: 'probe-failed', failure: 'missing-credential' },
      'Sign in to Aider to detect its models',
    ],
    [
      { kind: 'probe-failed', failure: 'invalid-credential' },
      'Aider sign-in was rejected. Sign in again',
    ],
    [{ kind: 'probe-failed', failure: 'policy-denied' }, 'Aider denied model catalog access'],
    [
      { kind: 'probe-failed', failure: 'offline' },
      'Model catalog request could not reach the network',
    ],
    [
      { kind: 'probe-failed', failure: 'timeout' },
      'Model detection timed out. Press ctrl+r to retry',
    ],
    [{ kind: 'probe-failed', failure: 'malformed' }, 'Model catalog output was malformed'],
    [
      { kind: 'probe-failed', failure: 'cancelled' },
      'Model detection was cancelled. Press ctrl+r to retry',
    ],
    [
      { kind: 'probe-failed', failure: 'not-run' },
      'Model detection has not run yet. Press ctrl+r to refresh',
    ],
  ] satisfies Array<[ModelCatalogDiagnostic, string]>)(
    'gives actionable copy for %j',
    (diagnostic, copy) => {
      expect(formatCatalogDiagnostic(diagnostic, 'Aider')).toBe(copy);
    },
  );
});

describe('provider axis copy', () => {
  it('names every backing credential source, spelling env vars out in full', () => {
    expect(
      formatProviderConfiguredClause('copilot', [{ provider: 'GitHub Copilot', source: 'oauth' }]),
    ).toBe('copilot signed in (oauth)');
    expect(
      formatProviderConfiguredClause('openai', [
        { provider: 'OpenAI', source: 'oauth' },
        { provider: 'OpenAI', source: 'env', envVar: 'OPENAI_API_KEY' },
      ]),
    ).toBe('openai signed in (oauth, env OPENAI_API_KEY)');
  });

  it('remediates sign-in with the provider argument, or account vocabulary for gateways', () => {
    expect(
      formatProviderSignInClause({
        tag: 'openrouter',
        authKey: 'openrouter',
        loginCommand: 'kilo auth login',
      }),
    ).toBe('openrouter needs sign-in · kilo auth login openrouter');
    expect(
      formatProviderSignInClause({
        tag: 'kilo',
        authKey: 'kilo',
        loginCommand: 'kilo auth login',
        gatewayAccount: 'Kilo',
      }),
    ).toBe('requires a Kilo account: kilo auth login');
  });

  it('keeps the bounded credential note ahead of the unbounded provider strip', () => {
    const tool: PickerOption = {
      ...readyCliTool(),
      status: {
        state: 'ready',
        remediation: null,
        configuredProviders: ['GitHub Copilot', 'Alibaba Coding Plan'],
      },
    };
    const preview = formatToolPreview(
      tool,
      { ...zeroCounts, confirmed: 2 },
      null,
      undefined,
      formatStoredCredentialNote(2),
    );
    expect(preview.indexOf('2 credentials stored')).toBeGreaterThan(-1);
    expect(preview.indexOf('2 credentials stored')).toBeLessThan(
      preview.indexOf('GitHub Copilot, Alibaba Coding Plan'),
    );
  });

  it('reports an unreadable oracle as unknown, never as unauthenticated', () => {
    const notice = formatAuthFactsUnavailableNotice('kilo auth list');
    expect(notice).toBe('auth state unknown — could not read kilo auth list · ctrl+r retry');
    expect(notice).not.toContain('Auth required');
  });
});
