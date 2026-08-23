import type { z } from 'zod';
import {
  APPROVE_LEVELS,
  ApproveLevelSchema,
  EFFORT_LEVELS,
  EffortLevelSchema,
  WORKFLOW_MODES,
  WorkflowModeSchema,
  type ApproveLevel,
} from '../../../schemas/enums.js';
import { configError } from '../../errors.js';
import type { Config } from '../../../schemas/config.js';
import { defaultApprovalConfig } from '../../../schemas/config.js';
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

export function applyApproveOverride(config: Config, level: ApproveLevel): Config {
  return { ...config, workflow: { ...config.workflow, approve: level } };
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
  if (overrides.approve !== undefined) {
    const level = parseOverrideOrThrow(
      ApproveLevelSchema,
      overrides.approve,
      '--approve',
      APPROVE_LEVELS,
    );
    next = applyApproveOverride(next, level);
  }
  if (overrides.mode !== undefined) {
    const mode = parseOverrideOrThrow(WorkflowModeSchema, overrides.mode, 'mode', WORKFLOW_MODES);
    next = { ...next, workflow: { ...next.workflow, mode } };
  }
  if (overrides.budget !== undefined) {
    if (!Number.isFinite(overrides.budget) || overrides.budget <= 0) {
      throw configError.invalidOverride('budget', overrides.budget, 'Must be a positive number.');
    }
    next = { ...next, workflow: { ...next.workflow, maxBudget: overrides.budget } };
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
  if (overrides.yolo) {
    const approval = next.approval ?? defaultApprovalConfig();
    next = {
      ...next,
      approval: { ...approval, enabled: false },
    };
  }
  return next;
}
