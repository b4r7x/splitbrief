import type { z } from 'zod';
import { EFFORT_LEVELS, EffortLevelSchema } from '../../../schemas/enums.js';
import { configError } from '../../errors.js';
import type { Config } from '../../../schemas/config.js';
import {
  applyImplementerOverrides,
  applyPlannerEffort,
  applyReviewerEffort,
  applyRunnerOverrides,
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

export function applyCLIOverrides(config: Config, overrides: CLIOverrides): Config {
  let next = config;
  if (overrides.planner) {
    next = applyRunnerOverrides('planner', overrides.planner, next);
  }
  if (overrides.implementer || overrides.contextLength !== undefined) {
    next = applyImplementerOverrides(
      {
        ...overrides.implementer,
        ...(overrides.implementer?.contextLength !== undefined ||
        overrides.contextLength !== undefined
          ? { contextLength: overrides.implementer?.contextLength ?? overrides.contextLength }
          : {}),
      },
      next,
    );
  }
  if (overrides.reviewer) {
    next = applyRunnerOverrides('reviewer', overrides.reviewer, next);
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
  return next;
}
