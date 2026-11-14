import { describe, expect, it } from 'vitest';
import {
  bylineDiagnostic,
  formatModelsByline,
  formatToolsByline,
  modelBylineAxes,
  wrapOnWords,
} from './byline.js';
import { pickerListingSource } from './listing-source.js';
import { formatCatalogDiagnostic, type ModelCatalogDiagnostic } from './catalog-guidance.js';
import { formatPermissionLabels } from './labels.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { cliPermissions } from '../model-catalog/posture.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool/catalog.js';
import { overlayWidth } from '../../../core/navigation/overlay-rect.js';
import { mergeOptionFamilies } from '../model-catalog/option-merge.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import type { ModelOption } from '../model-catalog/recency.js';

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

  it.each([56, 76, 108])('keeps command failure recovery within two rows of %i cells', (budget) => {
    const line = byline({
      toolName: 'OpenCode CLI',
      budget,
      diagnostic: {
        kind: 'probe-failed',
        failure: 'command-failed',
        cause: `Server at http://127.0.0.1:49374 ${'failed '.repeat(25)}`,
      },
    });

    expect(line).toContain('OpenCode CLI could not list models: Server at');
    expect(line).toContain('ctrl+r to retry');
    expect(wrapOnWords(line, budget, 2).cut).toBe(false);
  });

  it('names an earlier listing and its refresh key for a ready tool', () => {
    expect(
      byline({
        toolName: 'OpenCode',
        modelCount: 3,
        diagnostic: { kind: 'not-run-retained' },
      }),
    ).toBe(`Models from an earlier check${SOFT_SEP}ctrl+r detects this tool's models`);
  });

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
        budget: 108,
      }),
    ).toBe(
      formatCatalogDiagnostic({ kind: 'probe-failed', failure: 'malformed' }, 'Kilo Code CLI'),
    );
    expect(
      bylineDiagnostic({
        diagnostic: { kind: 'unsupported' },
        modelCount: 9,
        toolName: 'Claude Code CLI',
        budget: 108,
      }),
    ).toBeUndefined();
    expect(
      bylineDiagnostic({
        diagnostic: undefined,
        modelCount: 0,
        toolName: 'X',
        budget: 108,
      }),
    ).toBeUndefined();
  });

  it.each([
    { kind: 'not-probed' },
    { kind: 'probe-failed', failure: 'not-run' },
  ] satisfies ModelCatalogDiagnostic[])(
    'names the bundled list rather than denying it when rows are listed for %j',
    (diagnostic) => {
      const listed =
        bylineDiagnostic({
          diagnostic,
          modelCount: 3,
          toolName: 'OpenCode',
          budget: 108,
        }) ?? '';

      expect(listed).toContain('Bundled model list');
      expect(listed).toContain('ctrl+r');
      expect(listed).not.toContain('has not run');
      expect(
        bylineDiagnostic({
          diagnostic,
          modelCount: 0,
          toolName: 'OpenCode',
          budget: 108,
        }),
      ).toBe(formatCatalogDiagnostic(diagnostic, 'OpenCode'));
    },
  );

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

  it('keeps the sandbox posture, the one capability that differs by tool, on a 120-column byline', () => {
    const budget = overlayWidth({ cols: 120, density: 'wide' });
    for (const tool of ['claude-code', 'codex'] as const) {
      const descriptor = CLI_TOOL_CATALOG[tool];
      const listing = pickerListingSource(tool);
      const line = formatToolsByline({
        toolName: descriptor.displayName,
        version: '2.0.0',
        modelCount: 9,
        rowNoun: listing.rowNoun,
        rowNounPlural: listing.rowNounPlural,
        source: listing.source,
        unverifiedForPlan: listing.unverifiedForPlan,
        diagnostic: undefined,
        lane: 'ready',
        capabilities: formatPermissionLabels(cliPermissions(descriptor, 'implementer')),
        billing: 'unknown',
        budget,
      });
      expect(line, tool).toContain('cli sandbox');
    }
  });
});

describe('formatModelsByline', () => {
  it("spells the row's label, its exact id, its chosen axes and its size", () => {
    expect(
      formatModelsByline({
        label: 'GPT-5.6 Sol',
        id: 'gpt-5.6-sol-high-fast',
        axes: ['high', 'fast'],
        contextLength: undefined,
      }),
    ).toBe('GPT-5.6 Sol · gpt-5.6-sol-high-fast · high · fast');
    expect(
      formatModelsByline({
        label: 'GPT-5.6 Sol',
        id: 'gpt-5.6-sol-high-fast',
        axes: ['high', 'fast'],
        contextLength: 1_000_000,
      }).endsWith(' · 1M'),
    ).toBe(true);
  });

  it('says so where the listing gives the model no tool calls', () => {
    // `kilo models --verbose` on kilo 7.0.49: `z-ai/glm-5.2:free` answers in text, `toolcall: false`.
    expect(
      formatModelsByline({
        label: 'Z.ai: GLM 5.2 (free)',
        id: 'kilo/z-ai/glm-5.2:free',
        axes: [],
        contextLength: 32_768,
        supportsToolCalls: false,
      }),
    ).toBe('Z.ai: GLM 5.2 (free) · kilo/z-ai/glm-5.2:free · 32K · no tool calls');
    expect(
      formatModelsByline({
        label: 'GPT-5.5',
        id: 'openai/gpt-5.5',
        axes: [],
        contextLength: undefined,
        supportsToolCalls: true,
      }),
    ).toBe('GPT-5.5 · openai/gpt-5.5');
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
  it('states only the selected Antigravity id level beside an unused effort draft', () => {
    const flash: ModelOption = {
      id: 'gemini-3.8-flash-high',
      variants: ['high', 'medium', 'low'].map((level) => ({
        fullId: `gemini-3.8-flash-${level}`,
        providerPrefix: '',
        tag: level,
      })),
    };
    expect(
      modelBylineAxes({ model: flash, id: 'gemini-3.8-flash-low', effortDraft: 'high' }),
    ).toEqual(['low']);
  });

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
      ['high', 'fast'],
    );
    expect(modelBylineAxes({ model: sol, id: 'gpt-5.6-sol', effortDraft: null })).toEqual([]);
  });

  it("prefers the tool's own ladder over the id's tokens", () => {
    const option: ModelOption = { id: 'opus', effortChoices: ['low', 'medium', 'high'] };
    expect(modelBylineAxes({ model: option, id: 'opus', effortDraft: 'high' })).toEqual(['high']);
    expect(modelBylineAxes({ model: option, id: 'opus', effortDraft: null })).toEqual([]);
    expect(modelBylineAxes({ model: option, id: 'opus', effortDraft: 'ultra' })).toEqual([]);
  });
});
