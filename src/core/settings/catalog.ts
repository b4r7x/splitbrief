import type { Config } from '../schemas/config.js';
import { APPROVE_LEVELS, COMMIT_STRATEGIES, WORKFLOW_MODES } from '../schemas/enums.js';
import { CompactionFormatSchema } from '../schemas/compaction.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { RUNNER_IDLE_KILL_MS } from '../schemas/runner-fields.js';

const MAX_RETRIES_LIMIT = 10;

const isApiImplementer = (config: Config): boolean =>
  resolveImplementerProfiles(config).defaultProfile.config.kind === 'api';

export const SETTINGS_SECTIONS = ['Crew', 'Tuning', 'Workflow', 'Validation'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type SettingKind = 'boolean' | 'number' | 'string' | 'enum';

export interface SettingDef {
  id: string;
  label: string;
  section: SettingsSection;
  description: string;
  kind: SettingKind;
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  appliesTo?: (config: Config) => boolean;
  unsetLabel?: string;
  /** Override for reading the label when it depends on the resolved config. */
  readLabel?: (config: Config) => string;
  /**
   * Override for reading the display value. Used when the DU makes a direct
   * dot-path read impossible (e.g. `planner.tool` only exists on cli variant,
   * but the picker needs the canonical tool name across all variants).
   */
  readValue?: (config: Config) => unknown;
}

export const SETTINGS_DEFS: SettingDef[] = [
  {
    id: 'implementer.temperature',
    label: 'Temperature',
    section: 'Tuning',
    description: '0=precise  0.3=balanced  1+=creative (dropped on non-api backends)',
    kind: 'number',
    min: 0,
    max: 2,
    appliesTo: isApiImplementer,
  },
  {
    id: 'implementer.contextLength',
    label: 'Context length',
    section: 'Tuning',
    description: 'Prompt budget for the build seat (auto = detected from the model)',
    kind: 'number',
    min: 1024,
    integer: true,
    unsetLabel: 'auto',
    readLabel: (config) => (isApiImplementer(config) ? 'Context length' : 'Prompt budget'),
  },
  {
    id: 'implementer.timeout',
    label: 'Timeout',
    section: 'Tuning',
    description: 'Request timeout (ms)',
    kind: 'number',
    min: 1,
    max: 600000,
    integer: true,
    appliesTo: isApiImplementer,
    unsetLabel: `auto (idle kill ${RUNNER_IDLE_KILL_MS / 60_000}m)`,
  },
  {
    id: 'workflow.mode',
    label: 'Mode',
    section: 'Workflow',
    description:
      'quick (1 call, 0 gates) | standard (4 calls, 1 gate) | speckit (6-7 calls, 2 gates)',
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
];
