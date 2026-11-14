import { seatConfiguredEffort } from '../../../core/runners/capabilities.js';
import {
  type SeatPickerRole,
  type PickerSlot,
  seatPickerLane,
} from '../../../core/runners/seat-roles.js';
import { configStore } from '../../../stores/project/config.js';
import { pickerViewStore } from '../../../stores/ui/picker-view.js';
import { readPickerRunner, modelRowMatchesId } from '../model-catalog/catalog.js';
import {
  isOptionFamily,
  routePrefixesOf,
  optionAxesOf,
  optionDraftOf,
  routeDraftOf,
  stepOptionAxis,
} from '../model-catalog/option-axis.js';
import type { ModelOption } from '../model-catalog/recency.js';
import { offersEffortLadder, effortLadderFor } from '../model-catalog/axis-rows.js';
import type { RightRow } from '../model-catalog/types.js';
import { readPickerProfile } from '../picker/profile.js';
import type { CycleOutcome } from '../two-column-picker/types.js';

/**
 * An expansion that steps a draft is confirmed from its parent; one that only lists
 * provider routes holds no draft, so its parent closes it instead.
 */
export function expansionDrafts(model: ModelOption): boolean {
  if (isOptionFamily(model)) return true;
  if (offersEffortLadder(model)) return true;
  const variants = model.variants ?? [];
  return routePrefixesOf(variants).some((prefix) => optionAxesOf(variants, prefix).length > 0);
}

/** Unset heads the ladder, so a drafted preset can always be taken back. */
function nextEffortDraft(choices: readonly string[], current: string | null): string | null {
  const ladder: readonly (string | null)[] = [null, ...choices];
  return ladder[(ladder.indexOf(current) + 1) % ladder.length] ?? null;
}

/**
 * The level the seat already runs, read from the field its own channel spends — the
 * same answer the commit gives, so the ladder opens on what the crew row reads rather
 * than on unset.
 */
function configuredEffort(role: SeatPickerRole, slot: PickerSlot): string | null {
  const config = configStore.get().config;
  if (config === null) return null;
  const lane = seatPickerLane(role);
  const runner = readPickerRunner(config, lane, slot, readPickerProfile());
  return runner === undefined ? null : seatConfiguredEffort({ runner, role: lane });
}

interface ExpansionDraftInput {
  readonly expandedModelId?: string | null | undefined;
  readonly optionDraftId?: string | null | undefined;
  readonly effortDraft?: string | null | undefined;
  readonly currentModel?: string | undefined;
  readonly role: SeatPickerRole;
  readonly slot: PickerSlot;
}

export function expansionDraft(
  model: ModelOption,
  input: ExpansionDraftInput,
): { optionDraftId: string | undefined; effortDraft: string | null } {
  const isDrafted =
    (input.optionDraftId != null &&
      input.optionDraftId !== '' &&
      modelRowMatchesId(model, input.optionDraftId)) ||
    (input.expandedModelId != null &&
      input.expandedModelId !== '' &&
      modelRowMatchesId(model, input.expandedModelId));
  const isSeat =
    input.currentModel !== undefined &&
    input.currentModel !== '' &&
    modelRowMatchesId(model, input.currentModel);

  const draftedOption =
    input.optionDraftId != null && modelRowMatchesId(model, input.optionDraftId)
      ? input.optionDraftId
      : input.expandedModelId;
  const optionTarget = isDrafted ? draftedOption : isSeat ? input.currentModel : undefined;
  const optionDraftId = isOptionFamily(model) ? optionDraftOf(model, optionTarget) : undefined;

  const choices = effortLadderFor(model, optionDraftOf(model, optionDraftId));
  if (isDrafted && input.effortDraft != null && choices.includes(input.effortDraft)) {
    return { optionDraftId, effortDraft: input.effortDraft };
  }
  if (isSeat) {
    const configured = configuredEffort(input.role, input.slot);
    return {
      optionDraftId,
      effortDraft: configured !== null && choices.includes(configured) ? configured : null,
    };
  }
  return { optionDraftId, effortDraft: null };
}

/**
 * Space belongs to the expanded family: an axis row steps it, and takes the key
 * even where its ladder has nowhere to go — but only a row that moved owns the
 * click, so a dead axis confirms under the mouse the way its byline says. The
 * parent holds the key rather than collapsing the family the user is steering.
 */
export function cycleRightRow(row: RightRow): CycleOutcome {
  if (row.kind !== 'axis') {
    return row.kind === 'model' && row.expanded && expansionDrafts(row.model) ? 'held' : 'none';
  }
  if (!row.steps) return 'held';
  if (row.choices.length > 0) {
    // A preset drafted on another route is not a rung of this ladder, so the
    // step starts from unset the way the row already reads.
    const draft = pickerViewStore.get().effortDraft;
    const current = draft !== null && row.choices.includes(draft) ? draft : null;
    pickerViewStore.setEffortDraft(nextEffortDraft(row.choices, current));
    return 'stepped';
  }
  // Stepping inside a route moves the draft onto it, so every route of a
  // merged row is reachable from its own axis.
  const current = routeDraftOf(row.model, row.providerPrefix, pickerViewStore.get().optionDraftId);
  const next = stepOptionAxis(row.model, row.axis, current, row.providerPrefix);
  if (next === undefined) return 'held';
  pickerViewStore.setOptionDraftId(next);
  return 'stepped';
}
