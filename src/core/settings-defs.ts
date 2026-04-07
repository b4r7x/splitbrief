import type { Config } from "../types.js";
import type { Theme } from "../ui/theme.js";
import { formatModelName } from "../utils/model-names.js";
import { getDisplayName } from "../engine/providers/backend-registry.js";

export type SettingKind = "boolean" | "number" | "string" | "enum" | "picker";

export interface SettingDef {
  id: string;
  label: string;
  section: string;
  description: string;
  kind: SettingKind;
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  disabled?: (config: Config) => boolean;
  formatValue?: (value: unknown) => string;
}

export const SETTINGS_DEFS: SettingDef[] = [
  {
    id: "planner.tool",
    label: "Tool",
    section: "Planner",
    description: "Planner tool or API provider \u2192 /planner",
    kind: "picker",
    formatValue: (v) => getDisplayName(String(v ?? "")),
  },
  {
    id: "planner.model",
    label: "Model",
    section: "Planner",
    description: "Planner model \u2192 /planner",
    kind: "picker",
    formatValue: (v) => formatModelName(String(v ?? "")),
  },
  {
    id: "implementer.provider",
    label: "Tool",
    section: "Implementer",
    description: "Implementer tool or API provider \u2192 /implementer",
    kind: "picker",
    formatValue: (v) => getDisplayName(String(v ?? "")),
  },
  {
    id: "implementer.model",
    label: "Model",
    section: "Implementer",
    description: "Implementer model \u2192 /implementer",
    kind: "picker",
    formatValue: (v) => formatModelName(String(v ?? "")),
  },
  {
    id: "implementer.temperature",
    label: "Temperature",
    section: "Implementer",
    description: "0=precise  0.3=balanced  1+=creative",
    kind: "number",
    min: 0,
    max: 2,
  },
  {
    id: "implementer.contextLength",
    label: "Context Length",
    section: "Implementer",
    description: "Token context window",
    kind: "number",
    min: 1024,
    max: 131072,
    integer: true,
  },
  {
    id: "implementer.timeout",
    label: "Timeout",
    section: "Implementer",
    description: "Request timeout (ms)",
    kind: "number",
    min: 0,
    max: 600000,
    integer: true,
  },
  {
    id: "validation.typecheck",
    label: "Type Check",
    section: "Validation",
    description: "Run tsc type checking",
    kind: "boolean",
  },
  {
    id: "validation.lint",
    label: "Lint",
    section: "Validation",
    description: "Run linter",
    kind: "boolean",
  },
  {
    id: "validation.test",
    label: "Test",
    section: "Validation",
    description: "Run test suite",
    kind: "boolean",
  },
  {
    id: "validation.testCommand",
    label: "Test Command",
    section: "Validation",
    description: "Test runner command",
    kind: "string",
  },
  {
    id: "workflow.mode",
    label: "Mode",
    section: "Workflow",
    description: "quick (1 call, 0 approvals) | standard (4, 1) | full (4, 2)",
    kind: "enum",
    options: ["quick", "standard", "full"],
  },
  {
    id: "workflow.autoApproveSpec",
    label: "Auto-Approve Spec",
    section: "Workflow",
    description: "Skip spec review",
    kind: "boolean",
  },
  {
    id: "workflow.autoApprovePlan",
    label: "Auto-Approve Plan",
    section: "Workflow",
    description: "Skip plan review",
    kind: "boolean",
  },
  {
    id: "workflow.maxRetries",
    label: "Max Retries",
    section: "Workflow",
    description: "Max retry attempts per task",
    kind: "number",
    min: 0,
    integer: true,
    max: 10,
  },
  {
    id: "workflow.commitStrategy",
    label: "Commit Strategy",
    section: "Workflow",
    description: "none | checkpoint (tags) | per-task (commits)",
    kind: "enum",
    options: ["none", "checkpoint", "per-task"],
  },
  {
    id: "theme",
    label: "Theme",
    section: "Appearance",
    description: "Color palette mode",
    kind: "enum",
    options: ["terminal", "mono"],
  },
  {
    id: "shikiTheme",
    label: "Syntax Theme",
    section: "Appearance",
    description: "Syntax highlighting theme",
    kind: "enum",
    options: ["github-dark", "github-light"],
  },
  {
    id: "sessions.scope",
    label: "Scope",
    section: "Sessions",
    description: "Session storage scope",
    kind: "enum",
    options: ["project", "global"],
  },
];

export function getConfigValue(config: Config, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function applyEdits(config: Config, edits: Record<string, unknown>): Config {
  const clone: Record<string, unknown> = structuredClone(config) as unknown as Record<string, unknown>;
  for (const [dotPath, value] of Object.entries(edits)) {
    const parts = dotPath.split(".");
    let current = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== "object") {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return clone as unknown as Config;
}

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
  if (isDisabled) return "[\u2014]";
  if (def.kind === "boolean") return value ? "[\u2713]" : "[\u2717]";
  if (value !== undefined && value !== null) {
    const formatted = def.formatValue ? def.formatValue(value) : String(value);
    return `[${formatted}]`;
  }
  return "[\u2014]";
}

export function valueColor(def: SettingDef, value: unknown, disabled: boolean, t: Theme): string {
  if (disabled) return t.textDim;
  if (def.kind === 'boolean') return value ? t.success : t.textDim;
  if (def.kind === 'picker') return t.accent;
  return t.textDim;
}
