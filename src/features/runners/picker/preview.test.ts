import { describe, expect, it } from 'vitest';
import {
  cliTool,
  pickerCatalog,
  readyPermissions,
  zeroCounts,
} from '#testing/helpers/runner-picker.js';
import {
  PLANNER_INHERITANCE,
  REVIEW_NONE,
  formatSeatIdentity,
} from '../../../core/crew/identity.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import { SOFT_SEP } from '../../../core/separators.js';
import {
  inheritPlannerOption,
  noFallbackOption,
  reviewNoneOption,
  type PickerOption,
} from '../model-catalog/options.js';
import { deriveModelCatalogCapability } from '../model-catalog/posture.js';
import type { ModelOption, ModelVariant } from '../model-catalog/recency.js';
import type { RightRow } from '../model-catalog/types.js';
import type { RouteAuthContext } from '../right-column/policy.js';
import type { PreviewContext } from '../two-column-picker/picker.js';
import { formatCatalogDiagnostic } from './catalog-guidance.js';
import { resolvePreview, terminalPaneFor } from './preview.js';
import type { PickerCatalog } from './use-catalog.js';

const kilo = cliTool({ id: 'kilo-code', displayName: 'Kilo Code CLI' });

function catalogFor(input: Partial<PickerCatalog> & { currentItem: PickerOption | undefined }) {
  return pickerCatalog({
    items: input.currentItem === undefined ? [] : [input.currentItem],
    selectedItemId: input.currentItem?.id,
    rightModels: [],
    roleLabel: 'PLAN',
    modelCounts: zeroCounts,
    ...input,
  });
}

describe('terminalPaneFor', () => {
  const catalog = catalogFor({ currentItem: kilo });

  it('promises to keep or clear the fallback by whether None is saved', () => {
    const line = 'A Seat down halt pauses the run and asks which tool takes the seat.';

    expect(terminalPaneFor(noFallbackOption({ isCurrent: true }), catalog)).toEqual({
      label: 'No fallback',
      verb: 'keep no fallback',
      lines: [line],
    });
    expect(terminalPaneFor(noFallbackOption({ isCurrent: false }), catalog)?.verb).toBe(
      'clear fallback',
    );
  });

  it('says what a review seat set to None leaves out', () => {
    const pane = terminalPaneFor(reviewNoneOption({ isCurrent: false }), catalog);

    expect(pane?.label).toBe(REVIEW_NONE.mark);
    expect(pane?.verb).toBe('confirm');
    expect(pane?.lines[0]).toBe('No seat reviews the run.');
  });

  it('names the planner identity on the inherit row', () => {
    const pane = terminalPaneFor(
      inheritPlannerOption({ planner: kilo, isCurrent: false }),
      catalog,
    );

    expect(pane?.label).toBe(PLANNER_INHERITANCE.mark);
    expect(pane?.lines.slice(0, 3)).toEqual([
      'Review uses the same',
      'tool and model:',
      { whole: catalog.plannerIdentity },
    ]);
  });

  it('opens the local server form for a local service that is not answering', () => {
    const ollama: PickerOption = {
      id: 'ollama',
      displayName: 'Ollama',
      kind: 'api',
      roles: ['planner', 'implementer'],
      modelPolicy: 'required',
      modelCapability: deriveModelCatalogCapability('required'),

      permissions: readyPermissions,
      status: { state: 'unavailable', remediation: 'Ollama is not answering.' },
      available: false,
    };
    const pane = terminalPaneFor(ollama, catalog);

    expect(pane?.label).toBe('Local server');
    expect(pane?.verb).toBe('set up');
    expect(pane?.lines.slice(-3)).toEqual([
      '⏎ opens its address, its token and a check.',
      '',
      'Nothing is saved yet.',
    ]);
  });

  it('names the saved choice only on the saved tool that is not ready', () => {
    const savedRunner: RunnerConfig = { kind: 'cli', tool: 'kilo-code', model: 'kilo/free' };
    const signedOut: PickerOption = {
      ...kilo,
      status: { state: 'unauthenticated', remediation: 'Sign in to Kilo Code CLI.' },
      available: false,
    };
    const saved = catalogFor({ currentItem: signedOut, savedRunner });

    expect(terminalPaneFor({ ...signedOut, isCurrent: true }, saved)?.label).toBe('Auth required');
    expect(terminalPaneFor({ ...signedOut, isCurrent: true }, saved)?.lines).toEqual([
      'Sign in to Kilo Code CLI.',
      '',
      'Its models show here when it is ready.',
      '',
      'Saved choice:',
      { whole: formatSeatIdentity({ seat: savedRunner }) },
    ]);
    expect(terminalPaneFor(signedOut, saved)?.lines).toHaveLength(3);
    expect(terminalPaneFor(kilo, saved)).toBeUndefined();
  });
});

describe('resolvePreview', () => {
  const variant: ModelVariant = {
    fullId: 'openrouter/gemini-3-flash',
    providerPrefix: 'openrouter',
    tag: 'openrouter',
  };
  const model: ModelOption = {
    id: 'openrouter/gemini-3-flash',
    displayName: 'Gemini Marker',
    variants: [variant],
  };
  const unsignedRoute: RightRow = {
    kind: 'route',
    model,
    variant,
    last: true,
    auth: { kind: 'needs-sign-in', tool: 'kilo-code', provider: 'openrouter' },
    tree: { depth: 1, parentContinues: false },
  };
  const expandedModel: RightRow = {
    kind: 'model',
    model,
    provenance: 'Detected',
    section: '',
    expanded: true,
  };
  const auth: RouteAuthContext = { tool: 'kilo-code', providerAuth: undefined, catalog: undefined };
  const signIn = `sign in: kilo auth login openrouter${SOFT_SEP}then ctrl+r`;

  function context(
    input: Partial<PreviewContext<PickerOption, RightRow>>,
  ): PreviewContext<PickerOption, RightRow> {
    return {
      activeColumn: 'left',
      leftItem: kilo,
      rightItem: null,
      isOnCustomItem: false,
      bylineBudget: 120,
      ...input,
    };
  }

  it('previews nothing without a tool, or on the None rows', () => {
    const empty = catalogFor({ currentItem: undefined });

    expect(resolvePreview(context({ leftItem: undefined }), { catalog: empty, auth })).toBe(
      undefined,
    );
    const catalog = catalogFor({ currentItem: kilo });
    for (const leftItem of [
      noFallbackOption({ isCurrent: false }),
      reviewNoneOption({ isCurrent: false }),
    ]) {
      expect(resolvePreview(context({ leftItem }), { catalog, auth })).toBeUndefined();
    }
  });

  it('leads with the command that unblocks an unsigned route', () => {
    const catalog = catalogFor({ currentItem: kilo, rightRows: [expandedModel, unsignedRoute] });

    expect(
      resolvePreview(context({ activeColumn: 'right', rightItem: unsignedRoute }), {
        catalog,
        auth,
      }),
    ).toBe(signIn);
  });

  it('names the unsigned route of an expanded model on the model row', () => {
    const catalog = catalogFor({ currentItem: kilo, rightRows: [expandedModel, unsignedRoute] });

    expect(
      resolvePreview(context({ activeColumn: 'right', rightItem: expandedModel }), {
        catalog,
        auth,
      }),
    ).toBe(signIn);
  });

  it('names a catalog that could not be listed before any byline', () => {
    const diagnostic = { kind: 'probe-failed', failure: 'missing-credential' } as const;
    const catalog = catalogFor({ currentItem: kilo, catalogDiagnostic: diagnostic });

    expect(resolvePreview(context({}), { catalog, auth })).toBe(
      formatCatalogDiagnostic(diagnostic, 'Kilo Code CLI'),
    );
  });

  it('answers for the highlighted model row in the Models column', () => {
    const configured: RightRow = {
      ...unsignedRoute,
      auth: { kind: 'configured', source: 'listed' },
    };
    const catalog = catalogFor({ currentItem: kilo, rightRows: [expandedModel, configured] });

    const byline = resolvePreview(context({ activeColumn: 'right', rightItem: configured }), {
      catalog,
      auth,
    });

    expect(byline?.split(SOFT_SEP).slice(0, 2)).toEqual([
      'Gemini Marker',
      'openrouter/gemini-3-flash',
    ]);
  });

  it('says that the automatic row passes no model flag', () => {
    const auto: RightRow = {
      kind: 'model',
      model: { id: 'auto', displayName: 'Auto Marker' },
      provenance: 'Detected',
      section: '',
      expanded: false,
    };
    const catalog = catalogFor({ currentItem: kilo, rightRows: [auto] });

    expect(
      resolvePreview(context({ activeColumn: 'right', rightItem: auto }), { catalog, auth }),
    ).toBe(`Auto Marker${SOFT_SEP}no --model flag${SOFT_SEP}Kilo Code CLI runs its own default`);
  });

  it('puts the stale count after the Tools byline', () => {
    const catalog = catalogFor({ currentItem: kilo, modelCounts: { ...zeroCounts, stale: 2 } });

    const byline = resolvePreview(context({}), { catalog, auth }) ?? '';

    expect(byline.startsWith('Kilo Code CLI')).toBe(true);
    expect(byline.endsWith(`${SOFT_SEP}2 stale models retained. Refresh detection.`)).toBe(true);
  });
});
