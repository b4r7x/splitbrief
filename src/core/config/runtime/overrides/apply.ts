import type { z } from 'zod';
import { EFFORT_LEVELS, EffortLevelSchema } from '../../../schemas/enums.js';
import { configError } from '../../errors.js';
import type { Config } from '../../../schemas/config.js';
import { readActiveRunner } from '../../accessors/active-runner.js';
import {
  applyImplementerOverrides,
  applyPlannerEffort,
  applyReviewerEffort,
  applyRunnerOverrides,
  REMOVE_FLAG_FIX,
  type AppliedOverrides,
  type IgnoredFlag,
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
  const ignoredFlags: IgnoredFlag[] = [];
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
    const input = { name: '--planner-effort', fix: REMOVE_FLAG_FIX };
    const effort = parseOverrideOrThrow(
      EffortLevelSchema,
      overrides.plannerEffort,
      input.name,
      EFFORT_LEVELS,
    );
    take(applyPlannerEffort(next, effort, input));
  }
  if (overrides.reviewerEffort !== undefined) {
    const input = { name: '--reviewer-effort', fix: REMOVE_FLAG_FIX };
    const effort = parseOverrideOrThrow(
      EffortLevelSchema,
      overrides.reviewerEffort,
      input.name,
      EFFORT_LEVELS,
    );
    take(applyReviewerEffort(next, effort, input));
  }
  if (overrides.reviewerSpecEffort !== undefined) {
    const level = overrides.reviewerSpecEffort;
    const input = { name: `@${level} in --reviewer`, fix: `Remove @${level} from --reviewer.` };
    const effort = parseOverrideOrThrow(EffortLevelSchema, level, input.name, EFFORT_LEVELS);
    take(applyReviewerEffort(next, effort, input));
  }
  if (overrides.reviewerSpecVariant !== undefined) {
    const reviewer = readActiveRunner({ config: next, role: 'reviewer' });
    next = { ...next, reviewer: { ...reviewer, variant: overrides.reviewerSpecVariant } };
  }
  return { config: next, ignoredFlags };
}
