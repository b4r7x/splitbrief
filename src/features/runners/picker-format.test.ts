import { describe, expect, it } from 'vitest';
import {
  formatCatalogDiagnostic,
  formatPickerByline,
  formatRouteAuth,
  formatRouteRemedy,
  formatModelCatalogGuidance,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import { SOFT_SEP } from '../../components/separators.js';
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

  it('states the real diagnostic when nothing is confirmed', () => {
    const guidance = formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, bundled: 5 }, {
      kind: 'not-probed',
    } satisfies ModelCatalogDiagnostic);

    expect(guidance.detail).toBe(formatCatalogDiagnostic({ kind: 'not-probed' }, 'Codex'));
  });

  it('leads with the no-listing sentence for a tool that cannot list models', () => {
    const guidance = formatModelCatalogGuidance(readyCliTool(), { ...zeroCounts, bundled: 3 }, {
      kind: 'unsupported',
    } satisfies ModelCatalogDiagnostic);

    expect(guidance.headline).toContain('does not support model listing');
    expect(guidance.detail).toBe('aliases are offered');
    expect(guidance.detail).not.toContain('ctrl+r');
  });

  it('keeps the alias wording for claude-code', () => {
    const guidance = formatModelCatalogGuidance(
      { ...readyCliTool(), id: 'claude-code', displayName: 'Claude Code CLI' },
      { ...zeroCounts, bundled: 9 },
      { kind: 'unsupported' } satisfies ModelCatalogDiagnostic,
    );

    expect(guidance.detail).toBe('aliases are offered');
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

  it('does not promise a different result after a malformed listing', () => {
    const guidance = formatModelCatalogGuidance(readyCliTool(), zeroCounts, {
      kind: 'probe-failed',
      failure: 'malformed',
    } satisfies ModelCatalogDiagnostic);

    const detail = guidance.detail ?? '';
    expect(detail).toContain('will not help');
    expect(detail).not.toContain('retry');
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

describe('formatCatalogDiagnostic', () => {
  it.each([
    [{ kind: 'not-probed' }, 'Select this tool to detect its models'],
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
      'Model catalog request could not reach the network',
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
  ] satisfies Array<[ModelCatalogDiagnostic, string]>)(
    'gives actionable copy for %j',
    (diagnostic, copy) => {
      expect(formatCatalogDiagnostic(diagnostic, 'OpenCode')).toBe(copy);
    },
  );
});

describe('formatRouteAuth', () => {
  it('claims nothing when the tool cannot report sign-in state', () => {
    expect(formatRouteAuth({ auth: { kind: 'unchecked' }, floor: false })).toEqual({
      word: undefined,
      glyph: undefined,
    });
  });

  it('keeps the word and drops the glyph at the viewport floor', () => {
    const auth = { kind: 'configured', source: 'oauth' } as const;

    const roomy = formatRouteAuth({ auth, floor: false });
    const floor = formatRouteAuth({ auth, floor: true });

    expect(roomy.glyph).toBe('configured');
    expect(floor.glyph).toBeUndefined();
    expect(floor.word).toBe(roomy.word);
  });

  it('distinguishes a configured route, a missing one and an unreadable one', () => {
    const configured = formatRouteAuth({
      auth: { kind: 'configured', source: 'oauth' },
      floor: false,
    });
    const missing = formatRouteAuth({ auth: { kind: 'needs-sign-in' }, floor: false });
    const unknown = formatRouteAuth({
      auth: { kind: 'unknown', reason: 'timeout' },
      floor: false,
    });

    expect(new Set([configured.glyph, missing.glyph, unknown.glyph]).size).toBe(3);
    expect(new Set([configured.word, missing.word, unknown.word]).size).toBe(3);
  });

  it('reads a listing that named no provider as needing sign-in, not as unknown', () => {
    const empty = formatRouteAuth({ auth: { kind: 'unknown', reason: 'empty' }, floor: false });
    const missing = formatRouteAuth({ auth: { kind: 'needs-sign-in' }, floor: false });
    const timeout = formatRouteAuth({ auth: { kind: 'unknown', reason: 'timeout' }, floor: false });

    expect(empty.word).toBe(missing.word);
    expect(empty.word).not.toBe(timeout.word);
  });

  it('names the environment variable a configured route reads', () => {
    expect(
      formatRouteAuth({
        auth: { kind: 'configured', source: 'env', envVar: 'OPENAI_API_KEY' },
        floor: false,
      }).word,
    ).toContain('OPENAI_API_KEY');
  });
});

describe('formatRouteRemedy', () => {
  const route = {
    toolName: 'OpenCode CLI',
    oracleCommand: 'opencode providers list',
    provider: 'opencode-go',
    versions: { observed: '0.3.0', required: '0.40.0' },
  };

  it('has nothing to remedy for a configured route', () => {
    expect(formatRouteRemedy({ auth: { kind: 'configured', source: 'oauth' }, ...route })).toBe(
      undefined,
    );
  });

  it('leads with the sign-in command for a route the tool has no credential for', () => {
    const remedy = formatRouteRemedy({ auth: { kind: 'needs-sign-in' }, ...route }) ?? '';

    expect(remedy).toContain('opencode auth login opencode-go');
    expect(remedy.indexOf('opencode auth login opencode-go')).toBeLessThan(
      remedy.indexOf('ctrl+r'),
    );
  });

  it.each([
    'empty',
    'timeout',
    'exit-failure',
    'parse-failure',
    'version-mismatch',
    'not-probed',
  ] as const)('puts the action ahead of the explanation for %s', (reason) => {
    const remedy = formatRouteRemedy({ auth: { kind: 'unknown', reason }, ...route }) ?? '';
    const [head = ''] = remedy.split(SOFT_SEP);

    expect(remedy).not.toBe('');
    expect(head).toMatch(/ctrl\+r|upgrade|auth login/);
  });

  it('names the version gap the upgrade has to close', () => {
    const remedy =
      formatRouteRemedy({ auth: { kind: 'unknown', reason: 'version-mismatch' }, ...route }) ?? '';

    expect(remedy).toContain('0.3.0');
    expect(remedy).toContain('0.40.0');
  });

  it('never dangles a retry promise in front of the parse failure it cannot fix', () => {
    const remedy =
      formatRouteRemedy({ auth: { kind: 'unknown', reason: 'parse-failure' }, ...route }) ?? '';

    expect(remedy).toContain('will not help');
    expect(remedy.indexOf('ctrl+r')).toBe(remedy.indexOf('ctrl+r will not help'));
  });

  it('says the state is unreadable, not that the route needs sign-in, without an oracle', () => {
    const remedy = formatRouteRemedy({ auth: { kind: 'unchecked' }, ...route }) ?? '';

    expect(remedy).toContain('OpenCode CLI');
    expect(remedy).not.toContain('ctrl+r');
    expect(remedy).not.toContain('needs sign-in');
  });
});

describe('formatPickerByline', () => {
  const byline = (over: Partial<Parameters<typeof formatPickerByline>[0]> = {}): string =>
    formatPickerByline({
      toolName: 'Claude Code CLI',
      version: '2.4.0',
      counts: { ...zeroCounts, bundled: 3, suggestions: 10 },
      lane: 'ready',
      diagnostic: { kind: 'unsupported' },
      capabilities: ['Network', 'Shell', 'Subscription included'],
      ...over,
    });

  it('keeps every count ahead of the capability strip that truncation cuts', () => {
    const aliases = byline({
      counts: { ...zeroCounts, bundled: 3 },
      diagnostic: undefined,
    });
    const catalog = byline({ counts: { ...zeroCounts, suggestions: 10, confirmed: 126 } });

    expect(aliases.indexOf('3 known aliases')).toBeGreaterThan(-1);
    expect(aliases.indexOf('3 known aliases')).toBeLessThan(aliases.indexOf('Network'));
    expect(catalog.indexOf('10 models')).toBeGreaterThan(-1);
    expect(catalog.indexOf('10 models')).toBeLessThan(catalog.indexOf('Network'));
    expect(catalog.indexOf('126 detected')).toBeLessThan(catalog.indexOf('Network'));
  });

  it('never counts hidden bundled rows among the models the byline offers', () => {
    const line = byline({
      counts: { ...zeroCounts, confirmed: 3, bundled: 5 },
      diagnostic: undefined,
    });

    expect(line).toContain('3 detected');
    expect(line).not.toMatch(/\b8\b/);
    expect(line).not.toContain('5 known aliases');
  });

  it('separates counts by provenance instead of summing them', () => {
    const line = byline({ counts: { ...zeroCounts, bundled: 3, suggestions: 10, confirmed: 126 } });

    expect(line).toContain('126 detected');
    expect(line).not.toContain('13 ');
  });

  it('states the missing listing command only for a tool that has none', () => {
    expect(byline()).toContain('no listing command');
    expect(byline({ diagnostic: undefined })).not.toContain('no listing command');
  });

  it('reports the catalog lane with its retry key, ahead of the capabilities', () => {
    const pending = byline({ lane: 'pending' });
    const failed = byline({ lane: 'failed' });

    expect(pending).toContain('Loading models…');
    expect(failed).toContain('Could not load models');
    expect(failed).toContain('ctrl+r');
    expect(failed.indexOf('ctrl+r')).toBeLessThan(failed.indexOf('Network'));
    expect(byline()).not.toContain('Loading models…');
  });

  it('still counts claude-code bundled rows as known aliases', () => {
    const line = formatPickerByline({
      toolName: 'Claude Code CLI',
      version: undefined,
      counts: { confirmed: 0, stale: 0, suggestions: 0, bundled: 2, custom: 0 },
      lane: 'ready',
      diagnostic: { kind: 'unsupported' },
      capabilities: [],
      toolId: 'claude-code',
    });

    expect(line).toContain('known aliases');
  });

  it('omits the version when the tool did not report one', () => {
    expect(byline({ version: undefined })).not.toContain('2.4.0');
  });
});
