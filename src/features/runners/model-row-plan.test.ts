import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { formatContextLength } from '../../core/formatting.js';
import type { CliToolId } from '../../core/runners/cli-tool-catalog.js';
import {
  nativeCliCatalogToDetectedModels,
  parseAntigravityModelCatalog,
  parseCodexNativeModelCatalog,
  parseCopilotHelpConfigCatalog,
  parseCursorNativeModelCatalog,
  parseKiloNativeModelCatalog,
  parseOpenCodeNativeModelCatalog,
  type NativeCliModelCatalog,
} from '../../engine/providers/cli-model-catalog.js';
import { ELLIPSIS, getTerminalCellWidth } from '../../utils/display-text.js';
import { SOFT_SEP } from '../../core/separators.js';
import { buildRightModels } from './model-catalog/catalog.js';
import { assemblePickerDescriptors, buildPickerOptions } from './model-catalog/options.js';
import { buildRightRows, type RightRow } from './model-catalog/rows.js';
import { planModelRows } from './model-row-plan.js';
import { formatModelName } from '../../core/model-display.js';

const FIXTURES = join(import.meta.dirname, '../../../testing/fixtures');

/** The Models column's row width at 120, 80 and 60 terminal columns: the widths the gallery draws. */
const ROW_WIDTHS = [47, 31, 21] as const;

/** The chrome a row spends beside its label and cells: lead, disclosure and check. */
const BARE_CHROME = 6;

const CAPTURES: Readonly<
  Record<string, readonly [string, (stdout: string) => NativeCliModelCatalog | null]>
> = {
  opencode: ['opencode/api-model-full.json', parseOpenCodeNativeModelCatalog],
  'kilo-code': ['kilo/models-verbose.txt', parseKiloNativeModelCatalog],
  cursor: ['cursor/list-models-2026.09.18.txt', parseCursorNativeModelCatalog],
  codex: ['codex/debug-models-0.155.1.json', parseCodexNativeModelCatalog],
  copilot: ['copilot/help-config-1.0.83.txt', parseCopilotHelpConfigCatalog],
  antigravity: ['antigravity/models.txt', parseAntigravityModelCatalog],
};

/** The rows the picker builds from a tool's own captured listing, as the gallery feeds it. */
function capturedRows(toolId: CliToolId): RightRow[] {
  const capture = CAPTURES[toolId];
  if (capture === undefined) throw new Error(`no capture for ${toolId}`);
  const [path, parse] = capture;
  const catalog = parse(readFileSync(join(FIXTURES, path), 'utf8'));
  if (catalog === null) throw new Error(`the ${toolId} capture did not parse`);
  const cache = makeModelCacheAccessor({
    providerModels: { [toolId]: nativeCliCatalogToDetectedModels(catalog) },
  });
  const item = buildPickerOptions(
    'planner',
    assemblePickerDescriptors(),
    { cliTools: [cliDetectionFor('ready', toolId)], providers: [], providerOutcomes: [] },
    undefined,
  ).find((option) => option.id === toolId);
  const models = buildRightModels({ role: 'planner', customModels: [], currentItem: item, cache });
  return buildRightRows({
    models,
    expandedModelId: null,
    providerAuth: undefined,
    hasOracle: false,
    catalogLane: 'ready',
    persistedModel: undefined,
    customModels: [],
    browseCatalog: false,
  });
}

function modelIds(rows: readonly RightRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'model' ? [row.model.id] : []));
}

describe('planModelRows on the captured listings', () => {
  it('keeps the DeepSeek family visible beside the id that distinguishes its rows', () => {
    const rows: RightRow[] = [
      { id: 'deepseek/deepseek-flash', contextLength: 1_000_000 },
      {
        id: 'opencode-go/deepseek-v4.1-flash',
        contextLength: 1_000_000,
        variants: [
          {
            fullId: 'opencode-go/deepseek-v4.1-flash',
            providerPrefix: 'opencode-go',
            tag: 'opencode-go',
          },
          {
            fullId: 'ollama-cloud/deepseek-v4.1-flash',
            providerPrefix: 'ollama-cloud',
            tag: 'ollama-cloud',
          },
        ],
      },
    ].map((model) => ({
      kind: 'model',
      model: { ...model, displayName: 'DeepSeek V4.1 Flash' },
      provenance: 'Detected',
      section: '',
      expanded: false,
    }));
    const labelsAt = (width: number) =>
      [...planModelRows({ rows, width, providerId: 'opencode' }).rows.values()].map(
        (row) => row.label,
      );
    for (const width of [56, 47]) {
      const labels = labelsAt(width);
      expect(labels.every((label) => label.startsWith('DeepSeek V4.1 Flash'))).toBe(true);
      expect(new Set(labels).size).toBe(2);
    }
    // Too narrow for the family beside the id: the id stays, and no cut opens on the separator.
    expect(labelsAt(31)).toEqual([`${ELLIPSIS}deepseek-flash`, `${ELLIPSIS}deepseek-v4.1-flash`]);
  });

  it.each(['opencode', 'kilo-code', 'cursor', 'codex', 'copilot', 'antigravity'] as const)(
    'leaves no two %s rows reading alike at any width',
    (toolId) => {
      const rows = capturedRows(toolId);
      for (const width of ROW_WIDTHS) {
        const plan = planModelRows({ rows, width, providerId: undefined });
        const labels = modelIds(rows).map((id) => plan.rows.get(id)?.label);
        const repeated = labels.filter((label, index) => labels.indexOf(label) !== index);
        expect({ width, repeated }).toEqual({ width, repeated: [] });
      }
    },
  );

  it('keeps the part that differs when three Kilo free routes share every word but one', () => {
    const rows = capturedRows('kilo-code');
    const ling = [
      'kilo/inclusionai/ling-3.0-flash-fin:free',
      'kilo/inclusionai/ling-3.0-flash-sante:free',
      'kilo/inclusionai/ling-3.0-flash-vl:free',
    ];
    const at = (width: number) => {
      const plan = planModelRows({ rows, width, providerId: undefined });
      return ling.map((id) => plan.rows.get(id)?.label);
    };

    expect(at(47)).toEqual([
      'Ling 3.0 Flash Fin (free)',
      'Ling 3.0 Flash Sante (free)',
      'Ling 3.0 Flash VL (free)',
    ]);
    for (const width of [31, 21]) {
      const labels = at(width);
      expect(new Set(labels).size).toBe(3);
      expect(labels.map((label) => /Fin|Sant|VL/.exec(label ?? '')?.[0])).toEqual([
        'Fin',
        'Sant',
        'VL',
      ]);
    }
  });

  it.each(['opencode', 'kilo-code', 'cursor', 'codex', 'copilot', 'antigravity'] as const)(
    'cuts no %s model name inside a word',
    (toolId) => {
      const rows = capturedRows(toolId).flatMap((row) => (row.kind === 'model' ? [row] : []));
      // The spellings a row's name is built from: its own, the vendor a gateway prepends shed,
      // and a twin's, which adds the id the provider gives it.
      const namesOf = (model: (typeof rows)[number]['model']): string[] =>
        [model.displayName, formatModelName(model.id), model.id]
          .filter((name): name is string => name !== undefined)
          .flatMap((name) => [name, name.replace(/^[^:()]{1,24}: /, '')])
          .flatMap((name) => [name, `${name}${SOFT_SEP}${model.id.split('/').at(-1)}`]);
      for (const width of ROW_WIDTHS) {
        const plan = planModelRows({ rows, width, providerId: undefined });
        for (const { model } of rows) {
          const label = plan.rows.get(model.id)?.label ?? '';
          if (!label.endsWith(ELLIPSIS)) continue;
          const head = label.slice(0, -ELLIPSIS.length);
          const wholeWords = namesOf(model).some(
            (name) => name.startsWith(head) && /^[\s:(/-]/.test(name.slice(head.length)),
          );
          // Telling rows apart outranks whole words: a head is cut inside a word only where its
          // whole words read like another row's.
          const wordHead = head.replace(/[^\s:(/-]*$/, '').replace(/[\s:(/-]+$/, '');
          const sharedWordHead = rows.some(
            (other) =>
              other.model.id !== model.id &&
              namesOf(other.model).some((name) => name.startsWith(wordHead)),
          );
          expect({ width, label, wholeWords: wholeWords || sharedWordHead }).toEqual({
            width,
            label,
            wholeWords: true,
          });
        }
      }
    },
  );

  it('cuts inside a word only where every whole-word form reads like another row', () => {
    const plan = planModelRows({
      rows: capturedRows('kilo-code'),
      width: 21,
      providerId: undefined,
    });
    const labels = [...plan.rows.values()].map((row) => row.label);

    // `…(free)` would be every free route; `Nemotron 3.5…` is also the Content Safety model.
    expect(labels).toContain(`Nemotron 3.5 L${ELLIPSIS}`);
    expect(labels).not.toContain(`${ELLIPSIS}(free)`);
  });

  it('names a model family by its whole words where a word would not fit', () => {
    const plan = planModelRows({
      rows: capturedRows('antigravity'),
      width: 21,
      providerId: undefined,
    });
    const labels = [...plan.rows.values()].map((row) => row.label);

    expect(labels).toContain(`Gemini 3.8${ELLIPSIS}`);
    expect(labels.some((label) => label.includes(`Fla${ELLIPSIS}`))).toBe(false);
  });

  it('gives up the leading words of a cut another name also starts with', () => {
    const rows = capturedRows('copilot');
    const plan = planModelRows({ rows, width: 21, providerId: undefined });

    expect(plan.rows.get('claude-fable-5.1')?.label).toBe('…Fable 5.1');
    expect(plan.rows.get('claude-fable-5')?.label).toBe('Claude Fable 5');
    expect(plan.rows.get('claude-sonnet-4.6')?.label).toBe('…Sonnet 4.6');
  });

  it('tells two models apart by id where the listing names them alike', () => {
    const rows = capturedRows('opencode');
    const plan = planModelRows({ rows, width: 47, providerId: undefined });

    expect(plan.rows.get('ollama-cloud/kimi-k3')?.label).toBe('Kimi K3 · kimi-k3');
    expect(plan.rows.get('kimi-code-plan-global/k3')?.label).toBe('Kimi K3 · k3');
  });

  it.each(['opencode', 'kilo-code', 'cursor', 'codex'] as const)(
    'gives every %s row the size column or none of them, at each width',
    (toolId) => {
      const rows = capturedRows(toolId).flatMap((row) =>
        row.kind === 'model' && row.model.contextLength !== undefined ? [row] : [],
      );
      for (const width of ROW_WIDTHS) {
        const plan = planModelRows({ rows, width, providerId: undefined });
        const shown = rows.map((row) =>
          (plan.rows.get(row.model.id)?.metadata ?? '').includes(
            formatContextLength(row.model.contextLength),
          ),
        );
        expect({ width, mixed: new Set(shown).size > 1 }).toEqual({ width, mixed: false });
      }
    },
  );

  it('fits every label into the room its own cells leave', () => {
    for (const toolId of ['opencode', 'kilo-code', 'cursor', 'codex'] as const) {
      const rows = capturedRows(toolId);
      for (const width of ROW_WIDTHS) {
        for (const planned of planModelRows({ rows, width, providerId: undefined }).rows.values()) {
          if (planned.path) continue;
          const cells =
            planned.metadata === undefined ? 0 : getTerminalCellWidth(planned.metadata) + 1;
          expect(getTerminalCellWidth(planned.label)).toBeLessThanOrEqual(
            width - BARE_CHROME - cells,
          );
        }
      }
    }
  });

  it('spells a nameless custom id through its provider catalogue label', () => {
    const row: RightRow = {
      kind: 'model',
      model: { id: 'claude-opus-5-5' },
      provenance: 'Custom',
      section: '',
      expanded: false,
    };
    const plan = planModelRows({ rows: [row], width: 60, providerId: 'claude-code' });

    expect(plan.rows.get('claude-opus-5-5')?.label).toBe('Opus 5.5');
  });

  it('leaves the alias its name and gives a custom full id beside it its own id', () => {
    const item = buildPickerOptions(
      'planner',
      assemblePickerDescriptors(),
      { cliTools: [cliDetectionFor('ready', 'claude-code')], providers: [], providerOutcomes: [] },
      undefined,
    ).find((option) => option.id === 'claude-code');
    const customModels = ['claude-opus-5-5'];
    const models = buildRightModels({ role: 'planner', customModels, currentItem: item });
    const rows = buildRightRows({
      models,
      expandedModelId: null,
      providerAuth: undefined,
      hasOracle: false,
      catalogLane: 'ready',
      persistedModel: 'claude-opus-5-5',
      customModels,
      browseCatalog: false,
    });

    for (const width of ROW_WIDTHS.slice(0, 2)) {
      const plan = planModelRows({ rows, width, providerId: 'claude-code' });
      expect({
        width,
        alias: plan.rows.get('opus')?.label,
        custom: plan.rows.get('claude-opus-5-5')?.label,
      }).toEqual({ width, alias: 'Opus 5.5', custom: 'claude-opus-5-5' });
    }
  });
});
