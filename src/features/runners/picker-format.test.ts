import { describe, expect, it } from 'vitest';
import {
  bylineDiagnostic,
  formatCatalogDiagnostic,
  formatModelCatalogGuidance,
  formatModelsByline,
  formatPermissionLabels,
  formatRouteAuth,
  formatRouteRemedy,
  formatToolsByline,
  modelBylineAxes,
  pickerListingSource,
  type ModelCatalogDiagnostic,
} from './picker-format.js';
import { SOFT_SEP } from '../../components/separators.js';
import type { PickerOption } from './model-catalog/options.js';
import { deriveModelCatalogCapability } from './model-catalog/posture.js';
import { mergeOptionFamilies } from './model-catalog/option-merge.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import type { ModelOption } from './model-catalog/recency.js';

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
    expect(formatRouteAuth({ auth: { kind: 'unchecked' } })).toEqual({
      word: undefined,
      dim: false,
    });
  });

  it('names a configured route by credential source', () => {
    expect(formatRouteAuth({ auth: { kind: 'configured', source: 'oauth' } })).toEqual({
      word: 'signed in · oauth',
      dim: false,
    });
    expect(formatRouteAuth({ auth: { kind: 'configured', source: 'api' } }).word).toBe(
      'signed in · api key',
    );
  });

  it('distinguishes a configured route, a missing one and an unreadable one', () => {
    const configured = formatRouteAuth({
      auth: { kind: 'configured', source: 'oauth' },
    });
    const missing = formatRouteAuth({ auth: { kind: 'needs-sign-in' } });
    const unknown = formatRouteAuth({
      auth: { kind: 'unknown', reason: 'timeout' },
    });

    expect(configured.word).toBe('signed in · oauth');
    expect(configured.dim).toBe(false);
    expect(missing.word).toBe('needs sign-in');
    expect(missing.dim).toBe(true);
    expect(unknown.word).toBe('sign-in unknown');
    expect(unknown.dim).toBe(true);
    expect(new Set([configured.word, missing.word, unknown.word]).size).toBe(3);
  });

  it('reads a listing that named no provider as needing sign-in, not as unknown', () => {
    const empty = formatRouteAuth({ auth: { kind: 'unknown', reason: 'empty' } });
    const missing = formatRouteAuth({ auth: { kind: 'needs-sign-in' } });
    const timeout = formatRouteAuth({ auth: { kind: 'unknown', reason: 'timeout' } });

    expect(empty.word).toBe(missing.word);
    expect(empty.dim).toBe(true);
    expect(timeout.word).toBe('sign-in unknown');
    expect(timeout.dim).toBe(true);
    expect(empty.word).not.toBe(timeout.word);
  });

  it('names the environment variable a configured route reads', () => {
    expect(
      formatRouteAuth({
        auth: { kind: 'configured', source: 'env', envVar: 'OPENAI_API_KEY' },
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

const COPILOT_IDS = [
  'claude-sonnet-5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'mai-code-1-flash-picker',
  'gemini-3.1-pro-preview',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'grok-4.5',
  'kimi-k2.7-code',
] as const;

describe('formatToolsByline', () => {
  const byline = (over: Partial<Parameters<typeof formatToolsByline>[0]> = {}): string =>
    formatToolsByline({
      toolName: 'GitHub Copilot CLI',
      version: '1.0.77',
      modelCount: 24,
      rowNoun: 'model',
      rowNounPlural: 'models',
      source: 'from copilot help config',
      unverifiedForPlan: true,
      diagnostic: undefined,
      lane: 'ready',
      capabilities: ['network', 'shell'],
      billing: 'subscription-included',
      budget: 200,
      ...over,
    });

  const segments = (line: string): string[] => line.split(SOFT_SEP);

  it('uses the singular noun for a single row', () => {
    const single = byline({ modelCount: 1 });
    expect(single).toContain('1 model');
    expect(single).not.toContain('1 models');
    expect(byline({ modelCount: 1, rowNoun: 'alias', rowNounPlural: 'aliases' })).toContain(
      '1 alias',
    );
    expect(byline({ modelCount: 9, rowNoun: 'alias', rowNounPlural: 'aliases' })).toContain(
      '9 aliases',
    );
  });

  it('shows the catalog status whichever column has focus', () => {
    expect(
      bylineDiagnostic({
        diagnostic: { kind: 'probe-failed', failure: 'malformed' },
        modelCount: 1,
        toolName: 'Kilo Code CLI',
      }),
    ).toBe(
      formatCatalogDiagnostic({ kind: 'probe-failed', failure: 'malformed' }, 'Kilo Code CLI'),
    );
    expect(
      bylineDiagnostic({
        diagnostic: { kind: 'unsupported' },
        modelCount: 9,
        toolName: 'Claude Code CLI',
      }),
    ).toBeUndefined();
    expect(
      bylineDiagnostic({
        diagnostic: undefined,
        modelCount: 0,
        toolName: 'X',
      }),
    ).toBeUndefined();
  });

  it('carries the source phrase and the row noun ahead of the capability words', () => {
    const parts = segments(byline());
    expect(parts).toContain('24 models');
    expect(parts.some((s) => s.startsWith('from copilot help config'))).toBe(true);
    expect(parts.indexOf('24 models')).toBeLessThan(parts.indexOf('network'));
  });

  it('counts the row model, not the ids the tool printed', () => {
    const folded = mergeOptionFamilies(COPILOT_IDS.map((id) => ({ id })));
    expect(COPILOT_IDS.length).toBe(25);
    expect(folded.length).toBe(24);
    const line = byline({ modelCount: folded.length });
    expect(line).toContain('24 models');
    expect(line).not.toContain('25 models');
  });

  it('makes a diagnostic the whole line', () => {
    const diagnostic: ModelCatalogDiagnostic = {
      kind: 'probe-failed',
      failure: 'malformed',
    };
    const line = byline({
      diagnostic,
      toolName: 'Kilo Code CLI',
      billing: 'provider-dependent',
    });
    expect(line).toBe(formatCatalogDiagnostic(diagnostic, 'Kilo Code CLI'));
    expect(line).not.toContain('provider');
    expect(line).not.toContain('network');
    expect(line).not.toContain('24 models');
  });

  it('shows a diagnostic when no row survives', () => {
    const diagnostic: ModelCatalogDiagnostic = { kind: 'unsupported' };
    expect(byline({ diagnostic, modelCount: 0 })).toBe(
      formatCatalogDiagnostic(diagnostic, 'GitHub Copilot CLI'),
    );
  });

  it('keeps the source phrase for an alias lane whose confirmed count is always zero', () => {
    const line = byline({
      toolName: 'Claude Code CLI',
      version: '2.1.265',
      modelCount: 9,
      rowNoun: 'aliases',
      rowNounPlural: 'aliases',
      source: "from Claude's documented aliases",
      unverifiedForPlan: false,
      diagnostic: { kind: 'unsupported' },
    });
    expect(line).toContain('9 aliases');
    expect(line).toContain("from Claude's documented aliases");
    expect(line).not.toContain('does not support model listing');
  });

  it('drops capability words so the billing word stays whole', () => {
    const line = byline({ budget: 76 });
    expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(76);
    expect(line.endsWith('subscription')).toBe(true);
    expect(line).toContain('subscription');
    expect(line).not.toContain('shell');
    const wide = byline({ budget: 200 });
    expect(wide).toContain('network');
    expect(wide).toContain('shell');
    expect(wide).toContain('from copilot help config');
    expect(wide).toContain('not verified for your plan');
  });

  it('drops the last capability word first', () => {
    const capabilities = ['network', 'shell', 'auto approval'] as const;
    const twoCapsLine = byline({ capabilities: ['network', 'shell'] });
    const budget = getTerminalCellWidth(twoCapsLine);
    const line = byline({ capabilities, budget });
    const parts = segments(line);
    const surviving = parts.filter((s) => (capabilities as readonly string[]).includes(s));
    expect(surviving).toEqual(['network', 'shell']);
  });

  it('contributes no segment when the billing posture is unresolved', () => {
    const line = byline({ billing: 'unknown', budget: 200 });
    expect(line.endsWith(SOFT_SEP)).toBe(false);
    expect(line).not.toContain('unknown');
    expect(segments(line).every((part) => part.length > 0)).toBe(true);
  });

  it('attaches the trust clause to the source phrase', () => {
    expect(byline()).toContain('from copilot help config · not verified for your plan');
    expect(byline({ unverifiedForPlan: false })).not.toContain('not verified');
  });

  it('replaces the source segment with the catalog lane', () => {
    const pending = byline({ lane: 'pending' });
    expect(pending).toContain('Loading models…');
    expect(pending).not.toContain('from copilot help config');
    expect(pending).toContain('24 models');
    expect(pending).toContain('subscription');

    const failed = byline({ lane: 'failed' });
    expect(failed).toContain('Could not load models');
    expect(failed).toContain('ctrl+r');
    expect(failed).toContain('24 models');
    expect(failed).toContain('subscription');
  });

  it('omits the version when the tool did not report one', () => {
    expect(byline({ version: undefined })).not.toContain('1.0.77');
  });

  it('keeps the source phrase and drops the version before it', () => {
    const withoutVersion = 'Claude Code CLI · 10 aliases · Loading models… · subscription';
    const budget = getTerminalCellWidth(withoutVersion);
    const line = formatToolsByline({
      toolName: 'Claude Code CLI',
      version: '2.0.0',
      modelCount: 10,
      rowNoun: 'alias',
      rowNounPlural: 'aliases',
      source: "from Claude's documented aliases",
      unverifiedForPlan: false,
      diagnostic: undefined,
      lane: 'pending',
      capabilities: ['network', 'shell'],
      billing: 'subscription-included',
      budget,
    });
    expect(line).toBe(withoutVersion);
    expect(line).not.toContain('2.0.0');
    expect(line).toContain('Loading models…');
  });
});

describe('formatPermissionLabels', () => {
  it('lowercases every capability word', () => {
    const all = formatPermissionLabels({
      directWrite: true,
      network: true,
      shell: true,
      automaticApproval: true,
      sandbox: 'cli-managed',
    });
    expect(all.length).toBe(5);
    for (const word of all) expect(word).toBe(word.toLowerCase());
    const modeDependent = formatPermissionLabels({
      directWrite: false,
      network: false,
      shell: false,
      automaticApproval: false,
      sandbox: 'mode-dependent',
    });
    expect(modeDependent[modeDependent.length - 1]).toBe('sandbox varies');
  });
});

describe('pickerListingSource', () => {
  it('names the listing each tool really has', () => {
    expect(pickerListingSource('copilot')).toEqual({
      source: 'from copilot help config',
      rowNoun: 'model',
      rowNounPlural: 'models',
      unverifiedForPlan: true,
    });
    expect(pickerListingSource('claude-code').rowNounPlural).toBe('aliases');
    expect(pickerListingSource('claude-code').source).not.toContain('--help');
    expect(pickerListingSource('cursor').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('opencode').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('kilo-code').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('codex').unverifiedForPlan).toBe(false);
    expect(pickerListingSource('anthropic')).toEqual({
      source: 'from models.dev',
      rowNoun: 'model',
      rowNounPlural: 'models',
      unverifiedForPlan: true,
    });
    expect(pickerListingSource(undefined)).toEqual(pickerListingSource('anthropic'));
  });
});

describe('formatModelsByline', () => {
  it("spells the row's label, its exact id, its chosen axes and its size", () => {
    expect(
      formatModelsByline({
        label: 'GPT-5.6 Sol',
        id: 'gpt-5.6-sol-high-fast',
        axes: ['effort high', 'fast'],
        contextLength: undefined,
      }),
    ).toBe('GPT-5.6 Sol · gpt-5.6-sol-high-fast · effort high · fast');
    expect(
      formatModelsByline({
        label: 'GPT-5.6 Sol',
        id: 'gpt-5.6-sol-high-fast',
        axes: ['effort high', 'fast'],
        contextLength: 1_000_000,
      }).endsWith(' · 1M'),
    ).toBe(true);
  });

  it('names the tool on the Auto row', () => {
    expect(
      formatModelsByline({
        label: 'Auto',
        id: '',
        axes: [],
        contextLength: undefined,
        autoRow: { toolName: 'Cursor Agent CLI' },
      }),
    ).toBe('Auto · no --model flag · Cursor Agent CLI runs its own default');
  });
});

describe('modelBylineAxes', () => {
  it('states only the axes the row has actually chosen', () => {
    const sol: ModelOption = {
      id: 'gpt-5.6-sol',
      variants: [
        { fullId: 'gpt-5.6-sol', providerPrefix: '', tag: 'gpt-5.6-sol' },
        { fullId: 'gpt-5.6-sol-high', providerPrefix: '', tag: 'gpt-5.6-sol-high' },
        { fullId: 'gpt-5.6-sol-high-fast', providerPrefix: '', tag: 'gpt-5.6-sol-high-fast' },
      ],
    };
    expect(modelBylineAxes({ model: sol, id: 'gpt-5.6-sol-high-fast', effortDraft: null })).toEqual(
      ['effort high', 'fast'],
    );
    expect(modelBylineAxes({ model: sol, id: 'gpt-5.6-sol', effortDraft: null })).toEqual([]);
  });

  it("prefers the tool's own ladder over the id's tokens", () => {
    const option: ModelOption = { id: 'opus', effortChoices: ['low', 'medium', 'high'] };
    expect(modelBylineAxes({ model: option, id: 'opus', effortDraft: 'high' })).toEqual([
      'effort high',
    ]);
    expect(modelBylineAxes({ model: option, id: 'opus', effortDraft: null })).toEqual([]);
    expect(modelBylineAxes({ model: option, id: 'opus', effortDraft: 'ultra' })).toEqual([]);
  });
});
