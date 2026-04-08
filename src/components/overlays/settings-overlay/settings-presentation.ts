import type { Theme } from '../../../ui/theme.js';
import type { SettingDef } from '../../../core/settings/catalog.js';

export function matchesFilter(def: SettingDef, query: string): boolean {
  const q = query.toLowerCase();
  return def.label.toLowerCase().includes(q) || def.description.toLowerCase().includes(q) || def.section.toLowerCase().includes(q);
}

export function validateNumber(value: string, def: SettingDef): number | null {
  const num = Number(value);
  if (isNaN(num)) return null;
  if (def.min !== undefined && num < def.min) return null;
  if (def.max !== undefined && num > def.max) return null;
  if (def.integer && !Number.isInteger(num)) return null;
  return num;
}

export function displayValue(def: SettingDef, value: unknown, isDisabled: boolean): string {
  if (isDisabled) return '[\u2014]';
  if (def.kind === 'boolean') return value ? '[\u2713]' : '[\u2717]';
  if (value !== undefined && value !== null) {
    const formatted = def.formatValue ? def.formatValue(value) : String(value);
    return `[${formatted}]`;
  }
  return '[\u2014]';
}

export function valueColor(def: SettingDef, value: unknown, disabled: boolean, t: Theme): string {
  if (disabled) return t.textDim;
  if (def.kind === 'boolean') return value ? t.success : t.textDim;
  if (def.kind === 'picker') return t.accent;
  return t.textDim;
}
