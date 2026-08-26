import type { RunnerRole } from '../../src/core/runners/cli-tool-catalog.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
  type RunnerPickerOption,
} from '../../src/features/runners/model-catalog/options.js';
import { buildRightRows } from '../../src/features/runners/model-catalog/rows.js';
import type { ModelOption } from '../../src/features/runners/model-catalog/recency.js';
import type { PickerCatalog } from '../../src/features/runners/use-picker-catalog.js';

/**
 * The option the picker would actually emit for `id`, built by the real
 * descriptor assembly and projection. Tests commit selections through this so a
 * fabricated model policy, billing posture or permission set cannot disagree
 * with the catalog the UI reads.
 */
export function realPickerOption(role: RunnerRole, id: string): RunnerPickerOption {
  const option = realPickerOptions(role).find(
    (candidate): candidate is RunnerPickerOption =>
      candidate.kind !== 'custom-command' && candidate.id === id,
  );
  if (!option) throw new Error(`no ${role} picker option for "${id}"`);
  return option;
}

export function realPickerOptions(role: RunnerRole): PickerOption[] {
  return buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools: [], providers: [] },
    undefined,
  );
}

type DerivedCatalogField =
  | 'rightRows'
  | 'initialRightIndex'
  | 'resolveRightIndex'
  | 'plannerIdentity'
  | 'catalogLane'
  | 'providerAuth'
  | 'hasOracle'
  | 'initialLeftIdx'
  | 'focusModels'
  | 'currentModel'
  | 'persistedModel'
  | 'catalogDiagnostic'
  | 'currentCommand'
  | 'currentCommandKind'
  | 'customModels'
  | 'discovery'
  | 'setCurrentItem';

type CatalogFixture = Omit<PickerCatalog, DerivedCatalogField> &
  Partial<Pick<PickerCatalog, DerivedCatalogField>> & {
    /** The models the derived rows are built from; the catalog exposes only the rows. */
    rightModels: ModelOption[];
    /** Seeds the derived rows so an expanded model brings its route rows. */
    expandedModelId?: string | null | undefined;
  };

/**
 * A `PickerCatalog` for a view test: the fixture states the facts it is about
 * and the right-hand rows are derived from its models, the way the hook does.
 */
export function pickerCatalog(fixture: CatalogFixture): PickerCatalog {
  const { expandedModelId, rightModels, ...base } = fixture;
  const rightRows =
    base.rightRows ??
    buildRightRows({
      models: rightModels,
      expandedModelId: expandedModelId ?? null,
      providerAuth: base.providerAuth,
      hasOracle: base.hasOracle ?? false,
      catalogLane: base.catalogLane ?? 'ready',
      persistedModel: base.persistedModel,
      customModels: base.customModels ?? [],
    });
  const persisted = base.persistedModel;
  const initialRightIndex =
    base.initialRightIndex ??
    Math.max(
      0,
      rightRows.findIndex(
        (row) => row.kind === 'model' && persisted !== undefined && row.model.id === persisted,
      ),
    );
  return {
    ...base,
    rightRows,
    initialRightIndex,
    resolveRightIndex: () => initialRightIndex,
    plannerIdentity: base.plannerIdentity ?? 'Claude Code CLI · Claude Sonnet 4',
    catalogLane: base.catalogLane ?? 'ready',
    providerAuth: base.providerAuth,
    hasOracle: base.hasOracle ?? false,
    initialLeftIdx: base.initialLeftIdx ?? 0,
    focusModels: base.focusModels ?? false,
    currentModel: base.currentModel,
    persistedModel: base.persistedModel,
    catalogDiagnostic: base.catalogDiagnostic,
    currentCommand: base.currentCommand,
    currentCommandKind: base.currentCommandKind,
    customModels: base.customModels ?? [],
    discovery: base.discovery ?? { cold: false, refreshing: false },
    setCurrentItem: base.setCurrentItem ?? (() => {}),
  };
}
