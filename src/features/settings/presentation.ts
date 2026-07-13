import type { SettingDef } from '../../core/settings/catalog.js';
import { formatContextLength } from '../../core/formatting.js';
import { glyph } from '../../lib/glyphs.js';

export function matchesFilter(def: SettingDef, query: string): boolean {
  const q = query.toLowerCase();
  return (
    def.label.toLowerCase().includes(q) ||
    def.description.toLowerCase().includes(q) ||
    def.section.toLowerCase().includes(q)
  );
}

export function validateNumber(value: string, def: SettingDef): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const num = Number(trimmed);
  if (Number.isNaN(num)) return null;
  if (def.min !== undefined && num < def.min) return null;
  if (def.max !== undefined && num > def.max) return null;
  if (def.integer && !Number.isInteger(num)) return null;
  return num;
}

export function displayValue(
  def: SettingDef,
  value: unknown,
  ctx?: { detectedContextLength?: number | undefined },
): string {
  if (def.kind === 'boolean') return value ? glyph('check') : 'off';
  const detectedContextLength = ctx?.detectedContextLength;
  if (
    def.id === 'implementer.contextLength' &&
    value !== undefined &&
    value !== null &&
    detectedContextLength !== undefined &&
    value === detectedContextLength
  ) {
    return `auto (${formatContextLength(detectedContextLength)})`;
  }
  if (value !== undefined && value !== null) {
    return def.formatValue ? def.formatValue(value) : String(value);
  }
  return def.unsetLabel ?? '—';
}
