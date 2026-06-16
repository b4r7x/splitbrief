import { useInput } from 'ink';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { SETTINGS_DEFS, type SettingDef } from '../../../core/settings/catalog.js';
import { matchesFilter } from '../presentation.js';
import { getConfigValue, applyEdits } from '../../../core/config/accessors/values.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import { useEditBuffer } from './buffer.js';
import type { Config } from '../../../core/schemas/config.js';

interface UseSettingsEditorParams {
  config: Config;
  focusSetting: string | undefined;
  onClose: () => void;
  onOpenSubPicker: (def: SettingDef) => void;
  pageSize: number;
}

interface SettingsEditorState {
  filter: string;
  filtered: SettingDef[];
  effectiveIndex: number;
  editingId: string | null;
  editBuffer: string;
  selectedDef: SettingDef | undefined;
  getValue: (def: SettingDef) => unknown;
}

export function useSettingsEditor({
  config,
  focusSetting,
  onClose,
  onOpenSubPicker,
  pageSize,
}: UseSettingsEditorParams): SettingsEditorState {
  const getValue = (def: SettingDef): unknown =>
    def.readValue ? def.readValue(config) : getConfigValue(config, def.id);

  const saveValue = (dotPath: string, value: unknown) => {
    const updated = applyEdits(config, { [dotPath]: value });
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
    if (def.kind === 'boolean') {
      saveValue(def.id, !getValue(def));
    } else if (def.kind === 'enum' && def.options) {
      const firstOption = def.options[0];
      const current = String(getValue(def) ?? firstOption ?? '');
      const idx = def.options.indexOf(current);
      const next = def.options[(idx + 1) % def.options.length];
      if (next !== undefined) saveValue(def.id, next);
    }
  };

  const isListActive = !editor.isEditing;
  const initialIndex = focusSetting
    ? Math.max(
        0,
        SETTINGS_DEFS.findIndex((d) => d.id === focusSetting),
      )
    : 0;

  const list = useFilterableList<SettingDef>({
    items: SETTINGS_DEFS,
    filterFn: matchesFilter,
    onSelect: (def) => {
      if (def.kind === 'picker') {
        onOpenSubPicker(def);
        return;
      }
      if (def.kind === 'string' || def.kind === 'number') {
        const current = getValue(def);
        editor.startEditing(def.id, current != null ? String(current) : '');
      }
    },
    onClose,
    isActive: isListActive,
    shouldAppendChar: (c) => c !== ' ',
    initialIndex,
    pageSize,
  });

  useInput(
    (input) => {
      if (input !== ' ' || list.filtered.length === 0) return;
      const def = list.filtered[list.selectedIndex];
      if (def) onSpaceToggle(def);
    },
    { isActive: isListActive },
  );

  return {
    filter: list.filter,
    filtered: list.filtered,
    effectiveIndex: list.selectedIndex,
    editingId: editor.editingId,
    editBuffer: editor.editBuffer,
    selectedDef: list.filtered[list.selectedIndex],
    getValue,
  };
}
