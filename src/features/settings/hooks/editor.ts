import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reportConfigSaveFailure } from '../../../stores/project/save-feedback.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import type { SettingDef } from '../../../core/settings/catalog.js';
import { matchesFilter } from '../presentation.js';
import type { SettingsItem } from '../items.js';
import { getConfigValue, applyEdits } from '../../../core/config/accessors/values.js';
import { configError } from '../../../core/config/errors.js';
import { useFilterableList, type PageSize } from '../../../hooks/use-filterable-list.js';
import { useEditBuffer } from './buffer.js';
import type { Config } from '../../../core/schemas/config.js';
import { isTextEntryInput } from '../../../lib/terminal/text-entry.js';

export type CrewSettingsItem = Extract<SettingsItem, { kind: 'crew' }>;

interface UseSettingsEditorParams {
  config: Config;
  items: SettingsItem[];
  initialKey: string | undefined;
  initialFilter: string | undefined;
  onClose: () => void;
  onActivateCrew: (item: CrewSettingsItem) => void;
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

/** Enter is advertised on every row: a crew row opens its seat's picker. */
export function hintFor(item: SettingsItem): string {
  if (item.kind === 'crew') return '⏎ change seat';
  const kind = item.def.kind;
  return kind === 'string' || kind === 'number' ? '⏎ edit' : 'space toggle';
}

function getCurrentConfig(): Config {
  const current = configStore.get().config;
  if (current === null) throw configError.loadNotCalled('updating settings');
  return current;
}

function cyclesInPlace(item: SettingsItem): boolean {
  if (item.kind === 'crew') return false;
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

async function persist(updated: Config): Promise<void> {
  const result = await configStore.save(updated);
  if (reportConfigSaveFailure(result)) return;
  feedbackStore.setMessage('Saved');
}

export function useSettingsEditor({
  config,
  items,
  initialKey,
  initialFilter,
  onClose,
  onActivateCrew,
  pageSize,
  canActOnIndex,
}: UseSettingsEditorParams): SettingsEditorState {
  const getValue = (def: SettingDef, source = config): unknown =>
    def.readValue ? def.readValue(source) : getConfigValue(source, def.id);

  const saveValue = async (dotPath: string, value: unknown) => {
    await persist(applyEdits(getCurrentConfig(), { [dotPath]: value }));
  };

  const editor = useEditBuffer({
    onCommit: (def, value) => {
      enqueueSave(() => saveValue(def.id, value));
    },
  });

  const toggleSetting = (def: SettingDef) => {
    enqueueSave(async () => {
      const currentConfig = getCurrentConfig();
      if (def.kind === 'boolean') {
        await saveValue(def.id, !getValue(def, currentConfig));
      } else if (def.kind === 'enum' && def.options) {
        const firstOption = def.options[0];
        const current = String(getValue(def, currentConfig) ?? firstOption ?? '');
        const idx = def.options.indexOf(current);
        const next = def.options[(idx + 1) % def.options.length];
        if (next !== undefined) await saveValue(def.id, next);
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
