import { useState } from 'react';
import { useInput } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { SETTINGS_DEFS, type SettingDef } from '../../../core/settings/catalog.js';
import { dropLastGrapheme } from '../../../components/input/text-editing.js';
import { validateNumber } from '../presentation.js';

interface UseEditBufferParams {
  onCommit: (def: SettingDef, value: unknown) => void;
}

function numberConstraintHint(def: SettingDef): string {
  const parts: string[] = [];
  if (def.min !== undefined) parts.push(`>= ${def.min}`);
  if (def.integer) parts.push('integer');
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

interface EditBufferState {
  editingId: string | null;
  editBuffer: string;
  isEditing: boolean;
  startEditing: (id: string, initialValue: string) => void;
}

export function useEditBuffer({ onCommit }: UseEditBufferParams): EditBufferState {
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
        const trimmed = editBuffer.trim();
        if (trimmed === '' && def.unsetLabel !== undefined) {
          onCommit(def, undefined);
        } else if (def.kind === 'number') {
          const num = validateNumber(trimmed, def);
          if (num === null) {
            feedbackStore.setInfo(
              `Invalid ${def.label}: enter a number${numberConstraintHint(def)}`,
            );
            return;
          }
          onCommit(def, num);
        } else {
          if (!trimmed) {
            feedbackStore.setInfo(`Invalid ${def.label}: value cannot be empty`);
            return;
          }
          onCommit(def, trimmed);
        }
      }
    }
    setEditingId(null);
    setEditBuffer('');
    overlayStore.setExclusive(false);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        finishEditing(false);
        return;
      }
      if (key.return) {
        finishEditing(true);
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer((prev) => dropLastGrapheme(prev));
        return;
      }
      if (input && !key.ctrl && !key.meta) setEditBuffer((prev) => prev + input);
    },
    { isActive: isEditing },
  );

  return { editingId, editBuffer, isEditing, startEditing };
}
