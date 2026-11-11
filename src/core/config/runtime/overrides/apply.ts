import type { z } from 'zod';
import { EFFORT_LEVELS, EffortLevelSchema } from '../../../schemas/enums.js';
import { configError } from '../../errors.js';
import type { Config } from '../../../schemas/config.js';
import {
  applyImplementerOverrides,
  applyPlannerEffort,
  applyReviewerEffort,
  applyRunnerOverrides,
  type AppliedOverrides,
} from './runner.js';
import type { CLIOverrides } from './schema.js';

function parseOverrideOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  allowed: readonly string[],
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw configError.invalidOverride(label, value, `Must be one of: ${allowed.join(', ')}`);
  }
  return parsed.data;
}

export function applyCLIOverrides(config: Config, overrides: CLIOverrides): AppliedOverrides {
  let next = config;
  const ignoredFlags: string[] = [];
  const take = (applied: AppliedOverrides) => {
    ignoredFlags.push(...applied.ignoredFlags);
    next = applied.config;
  };
  if (overrides.planner) {
    take(applyRunnerOverrides('planner', overrides.planner, next));
  }
  if (overrides.implementer || overrides.contextLength !== undefined) {
    take(
      applyImplementerOverrides(
        {
          ...overrides.implementer,
          ...(overrides.implementer?.contextLength !== undefined ||
          overrides.contextLength !== undefined
            ? { contextLength: overrides.implementer?.contextLength ?? overrides.contextLength }
            : {}),
        },
        next,
      ),
    );
  }
  if (overrides.reviewer) {
    take(applyRunnerOverrides('reviewer', overrides.reviewer, next));
  }
  if (overrides.plannerEffort !== undefined) {
    const effort = parseOverrideOrThrow(
      EffortLevelSchema,
      overrides.plannerEffort,
      '--planner-effort',
      EFFORT_LEVELS,
    );
    next = applyPlannerEffort(next, effort);
  }
  if (overrides.reviewerEffort !== undefined) {
    const effort = parseOverrideOrThrow(
      EffortLevelSchema,
      overrides.reviewerEffort,
      '--reviewer-effort',
      EFFORT_LEVELS,
    );
    next = applyReviewerEffort(next, effort);
  }
  return { config: next, ignoredFlags };
}
