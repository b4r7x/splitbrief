import type { ListRowModel } from '../../../components/list-row/plan.js';
import type { SettingDef } from '../../../core/settings/catalog.js';
import { glyph } from '../../../lib/glyphs.js';
import { stripTerminalControls } from '../../../utils/display-text/sanitize.js';
import { displayValue } from '../presentation.js';

export function settingRowModel({
  def,
  label,
  value,
  editBuffer,
  detectedContextLength,
}: {
  def: SettingDef;
  label: string;
  value: unknown;
  /** The text typed so far while the row is in edit. */
  editBuffer: string | undefined;
  detectedContextLength: number | undefined;
}): ListRowModel {
  if (editBuffer !== undefined) {
    const buffer = `[${stripTerminalControls(editBuffer)}${glyph('editCursor')}]`;
    return { name: label, trailing: buffer, trailingParts: [{ text: buffer, tone: 'accent' }] };
  }

  const boolTrue = def.kind === 'boolean' && value === true;
  return {
    name: label,
    metadata: boolTrue ? undefined : displayValue(def, value, { detectedContextLength }),
    metadataTone: 'text',
    checked: boolTrue ? true : undefined,
  };
}
