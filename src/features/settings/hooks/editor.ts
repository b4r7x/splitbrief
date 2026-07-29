import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { SETTINGS_DEFS, type SettingDef } from '../../../core/settings/catalog.js';
import { matchesFilter } from '../presentation.js';
import { getConfigValue, applyEdits } from '../../../core/config/accessors/values.js';
import { configError } from '../../../core/config/errors.js';
import { useFilterableList, type PageSize } from '../../../hooks/use-filterable-list.js';
import { useEditBuffer } from './buffer.js';
import type { Config } from '../../../core/schemas/config.js';
import { isTextEntryInput } from '../../../lib/terminal/text-entry.js';

interface UseSettingsEditorParams {
  config: Config;
  focusSetting: string | undefined;
  onClose: () => void;
  onOpenSubPicker: (def: SettingDef) => void;
  pageSize: PageSize<SettingDef>;
  canActOnIndex: (filtered: SettingDef[], index: number) => boolean;
}

interface SettingsEditorState {
  filter: string;
  filtered: SettingDef[];
  effectiveIndex: number;
  editingId: string | null;
  editBuffer: string;
  selectedDef: SettingDef | undefined;
  getValue: (def: SettingDef) => unknown;
  activate: (index: number) => void;
}

function getCurrentConfig(): Config {
  const current = configStore.get().config;
  if (current === null) throw configError.loadNotCalled('updating settings');
  return current;
}

export function useSettingsEditor({
  config,
  focusSetting,
  onClose,
  onOpenSubPicker,
  pageSize,
  canActOnIndex,
}: UseSettingsEditorParams): SettingsEditorState {
  const getValue = (def: SettingDef, source = config): unknown =>
    def.readValue ? def.readValue(source) : getConfigValue(source, def.id);

  const saveValue = (dotPath: string, value: unknown) => {
    const current = getCurrentConfig();
    const updated = applyEdits(current, { [dotPath]: value });
    const result = configStore.save(updated, { changedPaths: [dotPath] });
    if (result.ok) {
      feedbackStore.setMessage('Saved');
    } else if (result.error) {
      feedbackStore.setError(`Failed to save config: ${result.error.message}`);
    }
  };

  const editor = useEditBuffer({
    onCommit: (def, value) => saveValue(def.id, value),
  });

  const onSpaceToggle = (def: SettingDef) => {
    const currentConfig = getCurrentConfig();
    if (def.kind === 'boolean') {
      saveValue(def.id, !getValue(def, currentConfig));
    } else if (def.kind === 'enum' && def.options) {
      const firstOption = def.options[0];
      const current = String(getValue(def, currentConfig) ?? firstOption ?? '');
      const idx = def.options.indexOf(current);
      const next = def.options[(idx + 1) % def.options.length];
      if (next !== undefined) saveValue(def.id, next);
    }
  };

  const isListActive = !editor.isEditing;
  const applicableDefs = SETTINGS_DEFS.filter((def) => def.appliesTo?.(config) ?? true);

  const runSelect = (def: SettingDef) => {
    if (def.kind === 'picker') {
      onOpenSubPicker(def);
      return;
    }
    if (def.kind === 'string' || def.kind === 'number') {
      const current = getValue(def);
      editor.startEditing(def.id, current != null ? String(current) : '');
    }
  };

  const list = useFilterableList<SettingDef>({
    items: applicableDefs,
    getKey: (def) => def.id,
    filterFn: matchesFilter,
    onSelect: runSelect,
    onItemAction: onSpaceToggle,
    onClose,
    isActive: isListActive,
    shouldAppendChar: (c) => c !== ' ',
    initialKey: focusSetting,
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
    const def = list.filtered[index];
    if (!def) return;
    if (def.kind === 'boolean' || def.kind === 'enum') {
      list.runItemAction(def);
      return;
    }
    list.selectItem(def);
  };

  return {
    filter: list.filter,
    filtered: list.filtered,
    effectiveIndex: list.selectedIndex,
    editingId: editor.editingId,
    editBuffer: editor.editBuffer,
    selectedDef: list.filtered[list.selectedIndex],
    getValue,
    activate,
  };
}
