import { assertNever } from '../../utils/type-guards.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import {
  crewRowFilterText,
  crewRowKey,
  deriveCrewRows,
  type CrewRow,
  type CrewRowKey,
} from '../../core/crew/rows.js';
import type { CliEffortChannel } from '../../core/runners/effort-channel.js';
import type { Config } from '../../core/schemas/config.js';
import {
  SETTINGS_SECTIONS,
  type SettingDef,
  type SettingsSection,
} from '../../core/settings/catalog.js';

export type SettingsItem =
  | Readonly<{ kind: 'crew'; row: CrewRow; key: CrewRowKey }>
  | Readonly<{ kind: 'setting'; def: SettingDef; key: string }>;

const SEAT_DESCRIPTIONS: Readonly<Record<CrewSeatId, string>> = {
  plan: 'Plans the work and compiles every brief; the review seat runs this same setup while it inherits it.',
  build: 'Executes the briefs the planner compiles; this is the seat that writes the code.',
  review: "Reads the diff after every task; with no tool of its own it runs the planner's setup.",
};

const INHERITED_EFFORT_DESCRIPTION =
  "Inherited with the planner's setup. Give REVIEW its own tool to set it separately (⏎ on REVIEW).";

const EFFORT_DESCRIPTION = 'How hard this seat reasons; auto leaves the choice to the tool.';

const EFFORT_DESCRIPTIONS: Readonly<Record<CliEffortChannel, string>> = {
  'effort-flag': EFFORT_DESCRIPTION,
  none: EFFORT_DESCRIPTION,
  // Shared by opencode and kilo-code since sprint 16 gave kilo the variant channel, so this names
  // neither tool: each spells its own presets and delivers them on its own `--variant`.
  variant:
    "How hard this seat reasons, in the tool's own vocabulary; delivered as a named preset on `--variant`.",
  'model-id':
    'How hard this seat reasons is spelled by the model id, so it is chosen with the model in the seat picker (⏎ on the seat).',
};

export function buildSettingsItems(
  input: Readonly<{
    config: Config;
    defs: readonly SettingDef[];
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): SettingsItem[] {
  const crew = deriveCrewRows({
    config: input.config,
    displayNames: input.displayNames,
  }).map((row): SettingsItem => ({ kind: 'crew', row, key: crewRowKey(row) }));
  const settings = input.defs
    .filter((def) => def.appliesTo?.(input.config) ?? true)
    .toSorted((a, b) => SETTINGS_SECTIONS.indexOf(a.section) - SETTINGS_SECTIONS.indexOf(b.section))
    .map((def): SettingsItem => ({ kind: 'setting', def, key: def.id }));
  return [...crew, ...settings];
}

export function settingsItemSection(item: SettingsItem): SettingsSection {
  return item.kind === 'crew' ? 'Crew' : item.def.section;
}

/**
 * The crew key carries the seat word, so `plan` reaches the PLAN branch rows too. Descriptions are
 * left out: prose matches drag unrelated rows in (`temp` would hit "Max retry attempts per task").
 */
export function settingsItemFilterText(item: SettingsItem): string {
  if (item.kind === 'crew') return `${item.key} ${crewRowFilterText(item.row)}`.toLowerCase();
  return `${item.def.label} ${item.def.section}`.toLowerCase();
}

function crewRowDescription(row: CrewRow): string {
  switch (row.kind) {
    case 'seat':
      return SEAT_DESCRIPTIONS[row.id];
    case 'effort':
      return row.inherited ? INHERITED_EFFORT_DESCRIPTION : EFFORT_DESCRIPTIONS[row.channel];
    default:
      return assertNever(row);
  }
}

export function settingsItemDescription(
  input: Readonly<{ item: SettingsItem; config: Config }>,
): string {
  const { item } = input;
  return item.kind === 'crew' ? crewRowDescription(item.row) : item.def.description;
}
