import type { Config } from '../schemas/config.js';
import {
  APPROVE_LEVELS,
  COMMIT_STRATEGIES,
  EFFORT_LEVELS,
  THEME_MODES,
  WORKFLOW_MODES,
} from '../schemas/enums.js';
import { CompactionFormatSchema } from '../schemas/compaction.js';
import { getProviderDisplayName } from '../providers/catalog.js';
import { formatModelName } from '../model-display.js';
import { getRunnerDisplayName } from '../config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { RUNNER_IDLE_KILL_MS } from '../schemas/runner-fields.js';

const MAX_RETRIES_LIMIT = 10;

const isApiImplementer = (config: Config): boolean =>
  resolveImplementerProfiles(config).defaultProfile.config.kind === 'api';

export type SettingKind = 'boolean' | 'number' | 'string' | 'enum' | 'picker';

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
  appliesTo?: (config: Config) => boolean;
  unsetLabel?: string;
  /**
   * Override for reading the display value. Used when the DU makes a direct
   * dot-path read impossible (e.g. `planner.tool` only exists on cli variant,
   * but the picker needs the canonical tool name across all variants).
   */
  readValue?: (config: Config) => unknown;
  formatValue?: (value: unknown) => string;
}

export const SETTINGS_DEFS: SettingDef[] = [
  {
    id: 'planner.kind',
    label: 'Tool',
    section: 'Planner',
    description: 'Planner tool or API provider \u2192 /planner',
    kind: 'picker',
    readValue: (config) => getRunnerDisplayName(config.planner),
    formatValue: (v) => getProviderDisplayName(String(v ?? '')),
  },
  {
    id: 'planner.model',
    label: 'Model',
    section: 'Planner',
    description: 'Planner model \u2192 /planner',
    kind: 'picker',
    readValue: (config) => config.planner.model,
    formatValue: (v) => formatModelName(String(v ?? '')),
  },
  {
    id: 'planner.effort',
    label: 'Effort',
    section: 'Planner',
    description: 'Reasoning hint: low | medium | high | xhigh (dropped on unsupported backends)',
    kind: 'enum',
    options: [...EFFORT_LEVELS],
    readValue: (config) => config.planner.effort,
    unsetLabel: 'auto (tool default)',
  },
  {
    id: 'implementer.tool',
    label: 'Tool',
    section: 'Implementer',
    description: 'Implementer tool or API provider \u2192 /implementer',
    kind: 'picker',
    readValue: (config) => getRunnerDisplayName(config.implementer),
    formatValue: (v) => getProviderDisplayName(String(v ?? '')),
  },
  {
    id: 'implementer.model',
    label: 'Model',
    section: 'Implementer',
    description: 'Implementer model \u2192 /implementer',
    kind: 'picker',
    formatValue: (v) => formatModelName(String(v ?? '')),
  },
  {
    id: 'implementer.temperature',
    label: 'Temperature',
    section: 'Implementer',
    description: '0=precise  0.3=balanced  1+=creative (dropped on non-api backends)',
    kind: 'number',
    min: 0,
    max: 2,
    appliesTo: isApiImplementer,
  },
  {
    id: 'implementer.contextLength',
    label: 'Context length',
    section: 'Implementer',
    description: 'Token context window (auto = detected from the model)',
    kind: 'number',
    min: 1024,
    integer: true,
    appliesTo: isApiImplementer,
    unsetLabel: 'auto',
  },
  {
    id: 'implementer.contextLength',
    label: 'Prompt budget',
    section: 'Implementer',
    description: 'Token budget for prompt code-context truncation',
    kind: 'number',
    min: 1024,
    integer: true,
    appliesTo: (config) => !isApiImplementer(config),
    unsetLabel: 'auto',
  },
  {
    id: 'implementer.timeout',
    label: 'Timeout',
    section: 'Implementer',
    description: 'Request timeout (ms)',
    kind: 'number',
    min: 1,
    max: 600000,
    integer: true,
    appliesTo: isApiImplementer,
    unsetLabel: `auto (idle kill ${RUNNER_IDLE_KILL_MS / 60_000}m)`,
  },
  {
    id: 'validation.typecheck',
    label: 'Type check',
    section: 'Validation',
    description: 'Run tsc type checking',
    kind: 'boolean',
  },
  {
    id: 'validation.lint',
    label: 'Lint',
    section: 'Validation',
    description: 'Run linter',
    kind: 'boolean',
  },
  {
    id: 'validation.test',
    label: 'Test',
    section: 'Validation',
    description: 'Run test suite',
    kind: 'boolean',
  },
  {
    id: 'validation.testCommand',
    label: 'Test command',
    section: 'Validation',
    description: 'Argv-style test runner command',
    kind: 'string',
  },
  {
    id: 'workflow.mode',
    label: 'Mode',
    section: 'Workflow',
    description: 'instant (1, 0) | quick (1, 0) | standard (4, 1) | speckit (6-7, 2)',
    kind: 'enum',
    options: [...WORKFLOW_MODES],
  },
  {
    id: 'workflow.approve',
    label: 'Spec/plan gates',
    section: 'Workflow',
    description: 'Which spec/plan document gates block the workflow ("default" follows mode)',
    kind: 'enum',
    options: [...APPROVE_LEVELS],
  },
  {
    id: 'workflow.maxRetries',
    label: 'Max retries',
    section: 'Workflow',
    description: 'Max retry attempts per task',
    kind: 'number',
    min: 0,
    integer: true,
    max: MAX_RETRIES_LIMIT,
  },
  {
    id: 'workflow.compactionFormat',
    label: 'Compaction format',
    section: 'Workflow',
    description: 'Summary format for transcript compaction',
    kind: 'enum',
    options: [...CompactionFormatSchema.options],
  },
  {
    id: 'workflow.git.commitStrategy',
    label: 'Commit strategy',
    section: 'Workflow',
    description: 'none | checkpoint (tags) | per-task (commits)',
    kind: 'enum',
    options: [...COMMIT_STRATEGIES],
    readValue: (config) => config.workflow.git?.commitStrategy,
  },
  {
    id: 'workflow.git.createBranch',
    label: 'Create branch',
    section: 'Workflow',
    description: 'Auto-create a splitbrief/<slug> branch at workflow start',
    kind: 'boolean',
    readValue: (config) => config.workflow.git?.createBranch ?? false,
  },
  {
    id: 'theme',
    label: 'Theme',
    section: 'Appearance',
    description: 'Color palette mode',
    kind: 'enum',
    options: [...THEME_MODES],
  },
];
