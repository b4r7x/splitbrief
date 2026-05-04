import type { Config } from '../schemas/config.js';
import { getProviderDisplayName } from '../providers/catalog.js';
import { formatModelName } from '../model-display.js';
import { getRunnerDisplayName } from '../config/accessors/runner-config.js';

const MAX_RETRIES_LIMIT = 10;

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
    options: ['low', 'medium', 'high', 'xhigh'],
    readValue: (config) => config.planner.effort,
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
    description: '0=precise  0.3=balanced  1+=creative',
    kind: 'number',
    min: 0,
    max: 2,
  },
  {
    id: 'implementer.contextLength',
    label: 'Context Length',
    section: 'Implementer',
    description: 'Token context window',
    kind: 'number',
    min: 1024,
    max: 131072,
    integer: true,
  },
  {
    id: 'implementer.timeout',
    label: 'Timeout',
    section: 'Implementer',
    description: 'Request timeout (ms)',
    kind: 'number',
    min: 0,
    max: 600000,
    integer: true,
  },
  {
    id: 'validation.typecheck',
    label: 'Type Check',
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
    label: 'Test Command',
    section: 'Validation',
    description: 'Argv-style test runner command',
    kind: 'string',
  },
  {
    id: 'workflow.mode',
    label: 'Mode',
    section: 'Workflow',
    description: 'instant (0 calls) | quick (1, 0) | standard (4, 1) | speckit (6-7, 2)',
    kind: 'enum',
    options: ['instant', 'quick', 'standard', 'speckit'],
  },
  {
    id: 'workflow.approve',
    label: 'Approval Gates',
    section: 'Workflow',
    description: 'Which approval gates block the workflow ("default" follows mode)',
    kind: 'enum',
    options: ['none', 'spec', 'plan', 'all', 'default'],
  },
  {
    id: 'workflow.maxRetries',
    label: 'Max Retries',
    section: 'Workflow',
    description: 'Max retry attempts per task',
    kind: 'number',
    min: 0,
    integer: true,
    max: MAX_RETRIES_LIMIT,
  },
  {
    id: 'workflow.compactionFormat',
    label: 'Compaction Format',
    section: 'Workflow',
    description: 'Summary format for transcript compaction',
    kind: 'enum',
    options: ['auto', 'freeform', 'structured'],
  },
  {
    id: 'workflow.git.commitStrategy',
    label: 'Commit Strategy',
    section: 'Workflow',
    description: 'none | checkpoint (tags) | per-task (commits)',
    kind: 'enum',
    options: ['none', 'checkpoint', 'per-task'],
    readValue: (config) => config.workflow.git?.commitStrategy ?? config.workflow.commitStrategy,
  },
  {
    id: 'workflow.git.createBranch',
    label: 'Create Branch',
    section: 'Workflow',
    description: 'Auto-create a diptych/<slug> branch at workflow start',
    kind: 'boolean',
    readValue: (config) => config.workflow.git?.createBranch ?? false,
  },
  {
    id: 'theme',
    label: 'Theme',
    section: 'Appearance',
    description: 'Color palette mode',
    kind: 'enum',
    options: ['terminal', 'mono'],
  },
  {
    id: 'shikiTheme',
    label: 'Syntax Theme',
    section: 'Appearance',
    description: 'Syntax highlighting theme',
    kind: 'enum',
    options: ['github-dark', 'github-light'],
  },
  {
    id: 'sessions.scope',
    label: 'Scope',
    section: 'Sessions',
    description: 'Session storage scope',
    kind: 'enum',
    options: ['project', 'global'],
  },
];
