import type { Config } from '../schemas/config.js';
import { APPROVE_LEVELS, ISOLATION_STRATEGIES } from '../schemas/enums.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { getIsolationStrategy } from '../config/accessors/values.js';
import { resolveEndChecks, resolveReviewCadence } from '../config/runtime/resolve.js';

const isApiImplementer = (config: Config): boolean =>
  resolveImplementerProfiles(config).defaultProfile.config.kind === 'api';

export const SETTINGS_SECTIONS = ['Crew', 'Fallback', 'Tuning', 'Workflow', 'Validation'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type SettingKind = 'boolean' | 'number' | 'string' | 'enum';

export interface SettingDef {
  id: string;
  label: string;
  section: SettingsSection;
  description: string;
  kind: SettingKind;
  options?: string[];
  optionLabels?: Readonly<Record<string, string>>;
  min?: number;
  integer?: boolean;
  unsetLabel?: string;
  /** Override for reading the label when it depends on the resolved config. */
  readLabel?: (config: Config) => string;
  /**
   * Override for reading the display value. Used when the DU makes a direct
   * dot-path read impossible (e.g. `planner.tool` only exists on cli variant,
   * but the picker needs the canonical tool name across all variants).
   */
  readValue?: (config: Config) => unknown;
  /** The reason the row is read-only, or undefined when the row can be edited. */
  lockedBy?: (config: Config) => string | undefined;
}

const lockedWhileReviewNone = (config: Config): string | undefined =>
  resolveReviewCadence(config) === 'none'
    ? 'Read-only while REVIEW is None: no review runs.'
    : undefined;

export const SETTINGS_DEFS: SettingDef[] = [
  {
    id: 'implementer.contextLength',
    label: 'Context length',
    section: 'Tuning',
    description:
      'Stop a brief that does not fit this many tokens (auto = no stop; the tool handles its own context)',
    kind: 'number',
    min: 1024,
    integer: true,
    unsetLabel: 'auto',
    readLabel: (config) => (isApiImplementer(config) ? 'Context length' : 'Prompt budget'),
  },
  {
    id: 'workflow.approve',
    label: 'Plan approval',
    section: 'Workflow',
    description: 'Whether the plan waits for your approval before the build starts',
    kind: 'enum',
    options: [...APPROVE_LEVELS],
    unsetLabel: 'plan',
  },
  {
    id: 'workflow.isolation',
    label: 'Isolation',
    section: 'Workflow',
    description: 'Where the build seat writes its changes; worktree by default',
    kind: 'enum',
    options: [...ISOLATION_STRATEGIES],
    optionLabels: { 'staged-copy': 'staged copy', none: 'your checkout' },
    readValue: getIsolationStrategy,
  },
  {
    id: 'workflow.review',
    label: 'Review cadence',
    section: 'Workflow',
    description: 'When the review seat reads the diff: once at the end, or after every brief',
    kind: 'enum',
    options: ['end', 'task'],
    readValue: resolveReviewCadence,
    lockedBy: lockedWhileReviewNone,
  },
  {
    id: 'validation.endChecks',
    label: 'End-of-run checks',
    section: 'Validation',
    description:
      'SPLITBRIEF runs the project gate the plan names before the final review. When off, a fix brief does not run the reviewer check it answers.',
    kind: 'boolean',
    readValue: resolveEndChecks,
    lockedBy: lockedWhileReviewNone,
  },
  {
    id: 'validation.testCommand',
    label: 'Test command',
    section: 'Validation',
    description: "The command the planner's test checks run (auto = the stack's own)",
    kind: 'string',
    unsetLabel: 'auto',
  },
];
