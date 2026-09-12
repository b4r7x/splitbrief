import type { z } from 'zod';
import { ConfigSchema } from '../../../schemas/config.js';
import { REMOVED_RUNNER_KINDS } from '../../../schemas/runner-fields.js';
import { RETIRED_WORKFLOW_MODE, RETIRED_WORKFLOW_MODE_NOTICE } from '../../../schemas/enums.js';
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

// A removed kind never reaches the runner refinements — the discriminated union
// rejects the discriminator first, with a message that only lists the survivors.
function removedEntityErrors(config: Record<string, unknown>): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const block of RUNNER_BLOCKS) {
    const error = removedKindError(block, config[block]);
    if (error) errors.push(error);
  }

  const profiles = narrowRecord(narrowRecord(config.implementerProfiles)?.profiles) ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    const error = removedKindError(`implementerProfiles.profiles.${name}`, profile);
    if (error) errors.push(error);
  }

  return errors;
}

// The root object is not strict, so a stale key from an older config stays tolerated; the keys this
// release removed are named here instead, to fail as loudly as a key in a strict block does.
const REMOVED_TOP_LEVEL_KEYS = [
  'otel',
  'snapshots',
  'trust',
  'plannerEstimateReview',
  'autoSplitOverflow',
] as const;

function removedTopLevelKeyErrors(config: Record<string, unknown>): ConfigError[] {
  return REMOVED_TOP_LEVEL_KEYS.filter((key) => config[key] !== undefined).map((key) => ({
    path: key,
    message: UNKNOWN_KEY_MESSAGE,
  }));
}

function deprecatedModeWarnings(config: Record<string, unknown>): string[] {
  const mode = narrowRecord(config.workflow)?.mode;
  return mode === RETIRED_WORKFLOW_MODE ? [RETIRED_WORKFLOW_MODE_NOTICE] : [];
}

export function validateConfig(config: Record<string, unknown>): ConfigValidation {
  const result = ConfigSchema.safeParse(config);

  const removed = [...removedEntityErrors(config), ...removedTopLevelKeyErrors(config)];
  const named = new Set(removed.map(({ path }) => path));
  const errors: ConfigValidation['errors'] = [...removed];

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(...issueErrors(issue).filter(({ path }) => !named.has(path)));
    }
  }

  if (result.success) {
    errors.push(...apiKeyErrors(result.data));
  }

  const warnings = [
    ...(result.success ? securityWarnings(result.data) : []),
    ...deprecatedModeWarnings(config),
  ];

  return { errors, warnings, data: result.success ? result.data : undefined };
}
