import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  formatConfigSaveSuccess,
  reportConfigSaveFailure,
} from '../../../stores/project/save-feedback.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { SettingDef } from '../../../core/settings/catalog.js';
import { matchesFilter, settingSaveSubject } from '../presentation.js';
import type { SettingsItem } from '../items.js';
import { getConfigValue, applyEdits } from '../../../core/config/accessors/values.js';
import { configError } from '../../../core/config/errors.js';
import { useFilterableList, type PageSize } from '../../../hooks/use-filterable-list.js';
import { useEditBuffer } from './buffer.js';
import type { Config } from '../../../core/schemas/config.js';
import { isTextEntryInput } from '../../../lib/terminal/text-entry.js';

export type CrewSettingsItem = Extract<SettingsItem, { kind: 'crew' }>;
export type FallbackSettingsItem = Extract<SettingsItem, { kind: 'fallback' }>;

interface UseSettingsEditorParams {
  config: Config;
  items: SettingsItem[];
  initialKey: string | undefined;
  initialFilter: string | undefined;
  onClose: () => void;
  onActivateCrew: (item: CrewSettingsItem) => void;
  onActivateFallback: (item: FallbackSettingsItem) => void;
  pageSize: PageSize<SettingsItem>;
  canActOnIndex: (filtered: SettingsItem[], index: number) => boolean;
}

interface SettingsEditorState {
  filter: string;
  filtered: SettingsItem[];
  effectiveIndex: number;
  editingId: string | null;
  editBuffer: string;
  selectedItem: SettingsItem | undefined;
  getValue: (def: SettingDef) => unknown;
  activate: (index: number) => void;
}

/** Each row advertises the one key it answers to, in the word for what that key does to it. */
export function hintFor(item: SettingsItem): string {
  if (item.kind === 'crew') return '⏎ change seat';
  if (item.kind === 'fallback') return '⏎ change fallback';
  const kind = item.def.kind;
  if (kind === 'enum') return 'space cycle';
  if (kind === 'boolean') return 'space toggle';
  return '⏎ edit';
}

function getCurrentConfig(): Config {
  const current = configStore.get().config;
  if (current === null) throw configError.loadNotCalled('updating settings');
  return current;
}

function cyclesInPlace(item: SettingsItem): boolean {
  if (item.kind !== 'setting') return false;
  return item.def.kind === 'boolean' || item.def.kind === 'enum';
}

// configStore.save is async with revision conflict detection, so each edit must
// read the config only after the previous save has settled or it computes from a
// stale snapshot and the save is rejected as a conflict.
let saveQueue: Promise<void> = Promise.resolve();

function enqueueSave(task: () => Promise<void>): void {
  saveQueue = saveQueue.then(task).catch((err: unknown) => {
    feedbackStore.setError(toErrorMessage(err));
  });
}

async function saveSetting(def: SettingDef, value: unknown): Promise<void> {
  const current = getCurrentConfig();
  const result = await configStore.save(applyEdits(current, { [def.id]: value }));
  if (reportConfigSaveFailure(result)) return;
  feedbackStore.setMessage(
    formatConfigSaveSuccess(settingSaveSubject(def, value, current), result),
  );
}

export function useSettingsEditor({
  config,
  items,
  initialKey,
  initialFilter,
  onClose,
  onActivateCrew,
  onActivateFallback,
  pageSize,
  canActOnIndex,
}: UseSettingsEditorParams): SettingsEditorState {
  const getValue = (def: SettingDef, source = config): unknown =>
    def.readValue ? def.readValue(source) : getConfigValue(source, def.id);

  const editor = useEditBuffer({
    onCommit: (def, value) => {
      enqueueSave(() => saveSetting(def, value));
    },
  });

  const toggleSetting = (def: SettingDef) => {
    enqueueSave(async () => {
      const currentConfig = getCurrentConfig();
      if (def.kind === 'boolean') {
        await saveSetting(def, !getValue(def, currentConfig));
      } else if (def.kind === 'enum' && def.options) {
        const firstOption = def.options[0];
        const current = String(getValue(def, currentConfig) ?? firstOption ?? '');
        const idx = def.options.indexOf(current);
        const next = def.options[(idx + 1) % def.options.length];
        if (next !== undefined) await saveSetting(def, next);
      }
    });
  };

  const runItemAction = (item: SettingsItem) => {
    if (item.kind === 'setting') toggleSetting(item.def);
  };

  const runSelect = (item: SettingsItem) => {
    if (item.kind === 'crew') {
      onActivateCrew(item);
      return;
    }
    if (item.kind === 'fallback') {
      onActivateFallback(item);
      return;
    }
    const def = item.def;
    if (def.kind === 'string' || def.kind === 'number') {
      const current = getValue(def);
      editor.startEditing(def.id, current != null ? String(current) : '');
    }
  };

  const list = useFilterableList<SettingsItem>({
    items,
    getKey: (item) => item.key,
    filterFn: matchesFilter,
    onSelect: runSelect,
    onItemAction: runItemAction,
    onClose,
    isActive: !editor.isEditing,
    shouldAppendChar: (c) => c !== ' ',
    initialKey,
    initialFilter,
    pageSize,
    customKeys: (input, key, { runSelectedItemAction }) => {
      if (input !== ' ' || !isTextEntryInput(input, key)) return false;
      runSelectedItemAction();
      return true;
    },
  });

  const activate = (index: number) => {
    if (editor.isEditing) return;
    if (!canActOnIndex(list.filtered, index)) return;
    const item = list.filtered[index];
    if (!item) return;
    if (cyclesInPlace(item)) {
      list.runItemAction(item);
      return;
    }
    list.selectItem(item);
  };

  return {
    filter: list.filter,
    filtered: list.filtered,
    effectiveIndex: list.selectedIndex,
    editingId: editor.editingId,
    editBuffer: editor.editBuffer,
    selectedItem: list.filtered[list.selectedIndex],
    getValue,
    activate,
  };
}
