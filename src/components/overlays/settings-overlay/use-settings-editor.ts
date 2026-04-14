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
import { matchesFilter, validateNumber } from '../../../core/settings/presentation.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import type { Config } from '../../../types.js';

interface UseSettingsEditorParams {
  config: Config;
  focusSetting: string | undefined;
  onClose: () => void;
  onOpenSubPicker: (def: SettingDef) => void;
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
}: UseSettingsEditorParams): SettingsEditorState {
  const getValue = (def: SettingDef): unknown =>
    def.readValue ? def.readValue(config) : getConfigValue(config, def.id);

  const saveValue = (dotPath: string, value: unknown) => {
    const updated = applyEdits(config, { [dotPath]: value });
    const saved = configStore.save(updated);
    if (saved) feedbackStore.setMessage('Saved');
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const isEditing = !!editingId;

  const startEditing = (id: string, initialValue: string) => {
    setEditingId(id);
    setEditBuffer(initialValue);
    overlayStore.setExclusive(true);
  };

  const finishEditing = (commit: boolean) => {
    if (commit && editingId) {
      const def = SETTINGS_DEFS.find((d) => d.id === editingId);
      if (def) {
        if (def.kind === 'number') {
          const num = validateNumber(editBuffer, def);
          if (num !== null) saveValue(def.id, num);
        } else {
          const trimmed = editBuffer.trim();
          if (trimmed) saveValue(def.id, trimmed);
        }
      }
    }
    setEditingId(null);
    setEditBuffer('');
    overlayStore.setExclusive(false);
  };

  useInput(
    (input, key) => {
      if (key.escape) { finishEditing(false); return; }
      if (key.return) { finishEditing(true); return; }
      if (key.backspace || key.delete) { setEditBuffer((prev) => prev.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setEditBuffer((prev) => prev + input);
    },
    { isActive: isEditing },
  );

  const initialIndex = focusSetting
    ? Math.max(0, SETTINGS_DEFS.findIndex((d) => d.id === focusSetting))
    : 0;

  const list = useFilterableList<SettingDef>({
    items: SETTINGS_DEFS,
    filterFn: matchesFilter,
    onSelect: (def) => {
      if (def.kind === 'picker') { onOpenSubPicker(def); return; }
      if (def.kind === 'string' || def.kind === 'number') {
        const current = getValue(def);
        startEditing(def.id, current != null ? String(current) : '');
      }
    },
    onClose,
    isActive: !isEditing,
    shouldAppendChar: (c) => c !== ' ',
    initialIndex,
  });

  useInput(
    (input) => {
      if (input !== ' ' || list.filtered.length === 0) return;
      const def = list.filtered[list.selectedIndex];
      if (!def) return;
      if (def.kind === 'boolean') {
        saveValue(def.id, !getValue(def));
      } else if (def.kind === 'enum' && def.options) {
        const firstOption = def.options[0];
        const current = String(getValue(def) ?? firstOption ?? '');
        const idx = def.options.indexOf(current);
        const next = def.options[(idx + 1) % def.options.length];
        if (next !== undefined) saveValue(def.id, next);
      }
    },
    { isActive: !isEditing },
  );

  return {
    filter: list.filter,
    filtered: list.filtered,
    effectiveIndex: list.selectedIndex,
    editingId,
    editBuffer,
    selectedDef: list.filtered[list.selectedIndex],
    getValue,
  };
}
