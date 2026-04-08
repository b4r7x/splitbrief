import { useState } from 'react';
import { useInput } from 'ink';
import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { feedbackStore } from '../../../stores/feedback.js';
import {
  SETTINGS_DEFS,
  type SettingDef,
} from '../../../core/settings/catalog.js';
import { getConfigValue, applyEdits } from '../../../core/config/index.js';
import { matchesFilter, validateNumber } from './settings-presentation.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import type { Config } from '../../../types.js';

interface InlineEditState {
  editingId: string | null;
  editBuffer: string;
  isEditing: boolean;
  startEditing: (id: string, initialValue: string) => void;
}

function useInlineEdit(onSave: (id: string, value: string) => void): InlineEditState {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState('');

  const startEditing = (id: string, initialValue: string) => {
    setEditingId(id);
    setEditBuffer(initialValue);
    overlayStore.setExclusive(true);
  };

  const finish = (commit: boolean) => {
    if (commit && editingId) onSave(editingId, editBuffer);
    setEditingId(null);
    setEditBuffer('');
    overlayStore.setExclusive(false);
  };

  useInput(
    (input, key) => {
      if (key.escape) { finish(false); return; }
      if (key.return) { finish(true); return; }
      if (key.backspace || key.delete) { setEditBuffer((prev) => prev.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setEditBuffer((prev) => prev + input);
    },
    { isActive: !!editingId },
  );

  return { editingId, editBuffer, isEditing: !!editingId, startEditing };
}

interface UseSettingsEditorParams {
  config: Config;
  focusSetting: string | undefined;
  onClose: () => void;
  onOpenSubPicker: (def: SettingDef) => void;
}

export interface SettingsEditorState {
  filter: string;
  filtered: SettingDef[];
  effectiveIndex: number;
  editingId: string | null;
  editBuffer: string;
  selectedDef: SettingDef | undefined;
  isDisabled: (def: SettingDef) => boolean;
  getValue: (def: SettingDef) => unknown;
}

export function useSettingsEditor({
  config,
  focusSetting,
  onClose,
  onOpenSubPicker,
}: UseSettingsEditorParams): SettingsEditorState {
  const isDisabled = (def: SettingDef): boolean => !!def.disabled?.(config);

  const getValue = (def: SettingDef): unknown => getConfigValue(config, def.id);

  const saveValue = (dotPath: string, value: unknown) => {
    const updated = applyEdits(config, { [dotPath]: value });
    configStore.save(updated);
    feedbackStore.setMessage('Saved');
  };

  const edit = useInlineEdit((id, value) => {
    const def = SETTINGS_DEFS.find((d) => d.id === id);
    if (!def) return;
    if (def.kind === 'number') {
      const num = validateNumber(value, def);
      if (num !== null) saveValue(def.id, num);
    } else {
      const trimmed = value.trim();
      if (trimmed) saveValue(def.id, trimmed);
    }
  });

  const initialIndex = focusSetting
    ? Math.max(0, SETTINGS_DEFS.findIndex((d) => d.id === focusSetting))
    : 0;

  const list = useFilterableList<SettingDef>({
    items: SETTINGS_DEFS,
    filterFn: matchesFilter,
    onSelect: (def) => {
      if (isDisabled(def)) return;
      if (def.kind === 'picker') { onOpenSubPicker(def); return; }
      if (def.kind === 'string' || def.kind === 'number') {
        const current = getValue(def);
        edit.startEditing(def.id, current != null ? String(current) : '');
      }
    },
    onClose,
    isActive: !edit.isEditing,
    shouldAppendChar: (c) => c !== ' ',
    initialIndex,
  });

  // Space key: toggle boolean / cycle enum (not handled by useFilterableList)
  useInput(
    (input) => {
      if (input !== ' ' || list.filtered.length === 0) return;
      const def = list.filtered[list.selectedIndex];
      if (isDisabled(def)) return;
      if (def.kind === 'boolean') {
        saveValue(def.id, !getValue(def));
      } else if (def.kind === 'enum' && def.options) {
        const current = String(getValue(def) ?? def.options[0]);
        const idx = def.options.indexOf(current);
        saveValue(def.id, def.options[(idx + 1) % def.options.length]);
      }
    },
    { isActive: !edit.isEditing },
  );

  return {
    filter: list.filter,
    filtered: list.filtered,
    effectiveIndex: list.selectedIndex,
    editingId: edit.editingId,
    editBuffer: edit.editBuffer,
    selectedDef: list.filtered[list.selectedIndex],
    isDisabled,
    getValue,
  };
}
