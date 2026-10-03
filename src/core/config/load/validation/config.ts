import type { z } from 'zod';
import { ConfigSchema } from '../../../schemas/config.js';
import { REMOVED_RUNNER_KINDS } from '../../../schemas/runner-fields.js';
import { RETIRED_APPROVE_LEVELS } from '../../../schemas/enums.js';
import { includes, narrowRecord } from '../../../../utils/type-guards.js';
import { apiKeyErrors } from './credentials.js';
import { securityWarnings } from './warnings.js';
import type { ConfigError, ConfigValidation } from './types.js';

const UNKNOWN_KEY_MESSAGE =
  'Unknown config key — remove it or use the current spelling from docs/CONFIGURATION.md.';

const RUNNER_BLOCKS = ['planner', 'reviewer', 'implementer'] as const;

// Zod reports every unrecognized key of an object under the object's own path,
// which would name `workflow` instead of `workflow.autoApproveSpec`. Expanding
// one error per key is what makes the offending path readable.
function issueErrors(issue: z.core.$ZodIssue): ConfigError[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: [...issue.path, key].join('.'),
      message: UNKNOWN_KEY_MESSAGE,
    }));
  }
  return [{ path: issue.path.join('.'), message: issue.message }];
}

function removedKindError(path: string, block: unknown): ConfigError | undefined {
  const kind = narrowRecord(block)?.kind;
  if (!includes(REMOVED_RUNNER_KINDS, kind)) return undefined;
  return {
    path: `${path}.kind`,
    message: `Runner kind "${kind}" was removed; use kind cli, api, shell, or agent.`,
  };
}

function runnerBlockEntries(config: Record<string, unknown>): [string, unknown][] {
  const profiles = narrowRecord(narrowRecord(config.implementerProfiles)?.profiles) ?? {};
  return [
    ...RUNNER_BLOCKS.map((block): [string, unknown] => [block, config[block]]),
    ...Object.entries(profiles).map(([name, profile]): [string, unknown] => [
      `implementerProfiles.profiles.${name}`,
      profile,
    ]),
  ];
}

// A removed kind never reaches the runner refinements — the discriminated union
// rejects the discriminator first, with a message that only lists the survivors.
function removedEntityErrors(config: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const [path, block] of runnerBlockEntries(config)) {
    const error = removedKindError(path, block);
    if (error) errors.push(error);
  }
  return errors;
}

// These backends end a run with a native terminal event, and that event is their
// parser's contract: substituting a text parser would let a bare process exit pass
// as completed. The engine adapter refuses the substitution too
// (src/engine/runners/cli-tools/output-format.ts), but a config that can never run
// must fail at load, before any runner is built.
export const STRUCTURED_TERMINAL_TOOL_IDS = [
  'antigravity',
  'claude-code',
  'codex',
  'command-code',
  'cursor',
] as const;

function outputFormatConflictError(path: string, block: unknown): ConfigError | undefined {
  const runner = narrowRecord(block);
  if (runner?.kind !== 'cli' || runner.outputFormat === undefined) return undefined;
  if (!includes(STRUCTURED_TERMINAL_TOOL_IDS, runner.tool)) return undefined;
  return {
    path: `${path}.outputFormat`,
    message: `Configured outputFormat cannot replace the ${runner.tool} terminal contract; the backend's native parser and terminal protocol stay authoritative.`,
  };
}

function outputFormatConflictErrors(config: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const [path, block] of runnerBlockEntries(config)) {
    const error = outputFormatConflictError(path, block);
    if (error) errors.push(error);
  }
  return errors;
}

const RETIRED_BRIEF_KEY = 'compiler';

// The root object is not strict, so a stale key from an older config stays tolerated; the keys this
// release removed are named here instead, to fail as loudly as a key in a strict block does.
const REMOVED_TOP_LEVEL_KEYS = [
  'otel',
  'snapshots',
  'trust',
  'plannerEstimateReview',
  'autoSplitOverflow',
  RETIRED_BRIEF_KEY,
] as const;

const REMOVED_TOP_LEVEL_KEY_MESSAGES: Partial<
  Record<(typeof REMOVED_TOP_LEVEL_KEYS)[number], string>
> = {
  [RETIRED_BRIEF_KEY]: `Unknown key "${RETIRED_BRIEF_KEY}" — the brief ${RETIRED_BRIEF_KEY} was retired on 2026-09-13; briefs compile from the plan directly.`,
};

function removedTopLevelKeyErrors(config: Record<string, unknown>): ConfigError[] {
  return REMOVED_TOP_LEVEL_KEYS.filter((key) => config[key] !== undefined).map((key) => ({
    path: key,
    message: REMOVED_TOP_LEVEL_KEY_MESSAGES[key] ?? UNKNOWN_KEY_MESSAGE,
  }));
}

/**
 * Retired config values that still load, each with one notice. A row without `value` retires
 * its key whatever it holds.
 */
const RETIRED_CONFIG_VALUES: readonly {
  path: readonly [block: string, key: string];
  value?: string;
  notice: string;
}[] = [
  {
    path: ['workflow', 'mode'],
    notice:
      'workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.',
  },
  ...RETIRED_APPROVE_LEVELS.map((value) => ({
    path: ['workflow', 'approve'] as const,
    value,
    notice: `workflow.approve "${value}" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.`,
  })),
  {
    path: ['workflow', 'taskReview'],
    notice:
      'workflow.task_review was retired and is ignored: the build no longer stops for your review after each brief. Delete workflow.task_review.',
  },
  {
    path: ['workflow', 'briefReview'],
    notice:
      'workflow.brief_review was retired and is ignored: you review the briefs on the plan card. Delete workflow.brief_review.',
  },
  {
    path: ['workflow', 'speckit'],
    notice:
      'workflow.speckit was retired and is ignored: every run plans in one session. Delete workflow.speckit.',
  },
  {
    path: ['approval', 'tiers'],
    notice:
      'approval.tiers was retired and is ignored: a write to a protected path always asks, and no other write does. Delete approval.tiers.',
  },
];

/** One notice per retired value the raw config names; the load reports them, once. */
export function retiredValueNotices(config: Record<string, unknown>): string[] {
  return RETIRED_CONFIG_VALUES.filter(({ path: [block, key], value }) => {
    const loaded = narrowRecord(config[block])?.[key];
    return value === undefined ? loaded !== undefined : loaded === value;
  }).map(({ notice }) => notice);
}

export function validateConfig(config: Record<string, unknown>): ConfigValidation {
  const result = ConfigSchema.safeParse(config);

  const removed = [...removedEntityErrors(config), ...removedTopLevelKeyErrors(config)];
  const named = new Set(removed.map(({ path }) => path));
  const errors: ConfigValidation['errors'] = [...removed, ...outputFormatConflictErrors(config)];

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(...issueErrors(issue).filter(({ path }) => !named.has(path)));
    }
  }

  if (result.success) {
    errors.push(...apiKeyErrors(result.data));
  }

  const warnings = result.success ? securityWarnings(result.data) : [];

  return { errors, warnings, data: result.success ? result.data : undefined };
}
