import type { SettingDef } from "./catalog.js";
import type { ThemeColors } from "../types/theme.js";

export function valueColor(
  def: SettingDef,
  value: unknown,
  t: ThemeColors,
): string {
  if (def.kind === "boolean") return value ? t.success : t.textDim;
  if (def.kind === "picker") return t.accent;
  return t.textDim;
}

export function matchesFilter(def: SettingDef, query: string): boolean {
  const q = query.toLowerCase();
  return (
    def.label.toLowerCase().includes(q) ||
    def.description.toLowerCase().includes(q) ||
    def.section.toLowerCase().includes(q)
  );
}

export function validateNumber(value: string, def: SettingDef): number | null {
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  if (def.min !== undefined && num < def.min) return null;
  if (def.max !== undefined && num > def.max) return null;
  if (def.integer && !Number.isInteger(num)) return null;
  return num;
}

export function displayValue(def: SettingDef, value: unknown): string {
  if (def.kind === "boolean") return value ? "[\u2713]" : "[\u2717]";
  if (value !== undefined && value !== null) {
    const formatted = def.formatValue ? def.formatValue(value) : String(value);
    return `[${formatted}]`;
  }
  return "[\u2014]";
}
