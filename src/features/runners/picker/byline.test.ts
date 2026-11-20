import { describe, expect, it } from 'vitest';
import {
  bylineDiagnostic,
  formatModelsByline,
  formatToolsByline,
  modelBylineAxes,
  wrapOnWords,
} from './byline.js';
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
      toolId: 'copilot',
      diagnostic: undefined,
      lane: 'ready',
      capabilities: ['network', 'shell'],

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

  it('cuts the reported cause at a word boundary and keeps the retry key', () => {
    const cause =
      'Server returned an unexpected health response while listing the available models';
    for (const budget of [50, 51, 52, 53, 54, 55, 56]) {
      const line = byline({
        toolName: 'OpenCode CLI',
        diagnostic: { kind: 'probe-failed', failure: 'command-failed', cause },
        budget,
      });
      const prefix = 'OpenCode CLI could not list models: ';
      expect(line).toContain(prefix + 'Server');
      expect(line).toContain('ctrl+r to retry');
      const shown = line.slice(prefix.length).split(SOFT_SEP)[0]?.replace(/…$/u, '').trimEnd();
      expect(shown).toBeTruthy();
      expect(cause.startsWith(`${shown} `), line).toBe(true);
      expect(wrapOnWords(line, budget, 2).cut).toBe(false);
    }
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

  it('puts the model count before the capabilities', () => {
    const parts = segments(byline());
    expect(parts).toContain('24 models');
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

  it('omits a count for the Claude alias list', () => {
    const line = byline({
      toolName: 'Claude Code CLI',
      version: '2.1.265',
      modelCount: 9,
      toolId: 'claude-code',
      diagnostic: { kind: 'unsupported' },
    });
    expect(line).not.toMatch(/9 (?:aliases|models)/u);
    expect(line).not.toContain('does not support model listing');
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

  it('shows pending and failed catalog status', () => {
    const pending = byline({ lane: 'pending' });
    expect(pending).toContain('Loading models…');
    expect(pending).toContain('24 models');

    const failed = byline({ lane: 'failed' });
    expect(failed).toContain('Could not load models');
    expect(failed).toContain('ctrl+r');
    expect(failed).toContain('24 models');
  });

  it('omits the version when the tool did not report one', () => {
    expect(byline({ version: undefined })).not.toContain('1.0.77');
  });

  it('drops the version before the loading message', () => {
    const withoutVersion = 'Claude Code CLI · Loading models…';
    const budget = getTerminalCellWidth(withoutVersion);
    const line = formatToolsByline({
      toolName: 'Claude Code CLI',
      version: '2.0.0',
      modelCount: 10,
      toolId: 'claude-code',
      diagnostic: undefined,
      lane: 'pending',
      capabilities: ['network', 'shell'],

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
      const line = formatToolsByline({
        toolName: descriptor.displayName,
        version: '2.0.0',
        modelCount: 9,
        toolId: tool,
        diagnostic: undefined,
        lane: 'ready',
        capabilities: formatPermissionLabels(cliPermissions(descriptor, 'implementer')),

        budget,
      });
      expect(line, tool).toContain('cli sandbox');
    }
  });
});

describe('formatModelsByline', () => {
  it("spells the row's label, its exact id, its chosen axes and its size", () => {});

  it('says so where the listing gives the model no tool calls', () => {
    // `kilo models --verbose` on kilo 7.0.49: `z-ai/glm-5.2:free` answers in text, `toolcall: false`.
    expect(
      formatModelsByline({
        label: 'Z.ai: GLM 5.2 (free)',
        id: 'kilo/z-ai/glm-5.2:free',
        axes: [],
        supportsToolCalls: false,
      }),
    ).toBe('Z.ai: GLM 5.2 (free) · kilo/z-ai/glm-5.2:free · no tool calls');
    expect(
      formatModelsByline({
        label: 'GPT-5.5',
        id: 'openai/gpt-5.5',
        axes: [],
        supportsToolCalls: true,
      }),
    ).toBe('GPT-5.5 · openai/gpt-5.5');
  });

  it('describes the automatic model choice in one clause', () => {
    expect(
      formatModelsByline({
        label: 'Auto',
        id: '',
        axes: [],
        autoRow: { toolName: 'Cursor Agent CLI' },
      }),
    ).toBe('Cursor Agent CLI chooses the model');
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
