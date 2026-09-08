import type { CrewSeatId } from '../../core/crew/identity.js';
import {
  crewRowFilterText,
  crewRowKey,
  deriveCrewRows,
  type CrewRow,
  type CrewRowKey,
} from '../../core/crew/rows.js';
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
 * The crew key carries the seat word, so `plan` reaches the PLAN seat row. Descriptions are
 * left out: prose matches drag unrelated rows in (`temp` would hit "Max retry attempts per task").
 */
export function settingsItemFilterText(item: SettingsItem): string {
  if (item.kind === 'crew') return `${item.key} ${crewRowFilterText(item.row)}`.toLowerCase();
  return `${item.def.label} ${item.def.section}`.toLowerCase();
}

export function settingsItemDescription(
  input: Readonly<{ item: SettingsItem; config: Config }>,
): string {
  const { item } = input;
  return item.kind === 'crew' ? SEAT_DESCRIPTIONS[item.row.id] : item.def.description;
}
