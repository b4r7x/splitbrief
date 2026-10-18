import type { CrewSeatId, SeatDisplayName } from '../../core/crew/identity.js';
import {
  deriveFallbackRows,
  fallbackRowKey,
  FALLBACK_NONE_WORDS,
  type FallbackRow,
  type FallbackRowKey,
} from '../../core/crew/fallback.js';
import {
  crewRowFilterText,
  crewRowKey,
  deriveCrewRows,
  type CrewRow,
  type CrewRowKey,
} from '../../core/crew/rows.js';
import type { Config } from '../../core/schemas/config.js';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import type { SavedCatalogOf } from '../../core/discovery/catalog-read-merge.js';
import {
  SETTINGS_SECTIONS,
  type SettingDef,
  type SettingsSection,
} from '../../core/settings/catalog.js';

export type SettingsItem =
  | Readonly<{ kind: 'crew'; row: CrewRow; key: CrewRowKey }>
  | Readonly<{ kind: 'fallback'; row: FallbackRow; key: FallbackRowKey }>
  | Readonly<{ kind: 'setting'; def: SettingDef; key: string }>;

export function buildSettingsItems(
  input: Readonly<{
    config: Config;
    defs: readonly SettingDef[];
    cliTools: readonly CliToolDetection[];
    cliCatalog?: SavedCatalogOf | undefined;
    displayNames?: Partial<Record<CrewSeatId, string>> | undefined;
    seatDisplayName?: SeatDisplayName | undefined;
  }>,
): SettingsItem[] {
  const crew = deriveCrewRows({
    config: input.config,
    displayNames: input.displayNames,
  }).map((row): SettingsItem => ({ kind: 'crew', row, key: crewRowKey(row) }));
  const fallbacks = deriveFallbackRows(input).map(
    (row): SettingsItem => ({ kind: 'fallback', row, key: fallbackRowKey(row) }),
  );
  const settings = input.defs
    .filter((def) => def.appliesTo?.(input.config) ?? true)
    .toSorted((a, b) => SETTINGS_SECTIONS.indexOf(a.section) - SETTINGS_SECTIONS.indexOf(b.section))
    .map((def): SettingsItem => ({ kind: 'setting', def, key: def.id }));
  return [...crew, ...fallbacks, ...settings];
}

export function settingsItemSection(item: SettingsItem): SettingsSection {
  if (item.kind === 'crew') return 'Crew';
  if (item.kind === 'fallback') return 'Fallback';
  return item.def.section;
}

/**
 * The crew key carries the seat word, so `plan` reaches the PLAN seat row. Descriptions are
 * left out: prose matches drag unrelated rows in (`format` would hit "Summary format for
 * transcript compaction").
 */
export function settingsItemFilterText(item: SettingsItem): string {
  if (item.kind === 'crew') return `${item.key} ${crewRowFilterText(item.row)}`.toLowerCase();
  if (item.kind === 'fallback')
    return `${item.key} ${item.row.identity ?? FALLBACK_NONE_WORDS}`.toLowerCase();
  return `${item.def.label} ${item.def.section}`.toLowerCase();
}
