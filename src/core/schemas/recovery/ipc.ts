import { z } from 'zod';
import { PhaseSchema, RecoveryActionSchema, RecoveryReasonSchema } from '../enums.js';
import { TaskIdSchema } from '../task.js';
import type { RecoveryFact, RecoveryIssue } from './schemas.js';
import { actionsAreLegalForReason, recommendedActionIsAvailable } from './policy.js';

export const IpcRecoveryIssueSchema = z
  .strictObject({
    id: z.string(),
    reason: RecoveryReasonSchema,
    phase: PhaseSchema,
    taskId: TaskIdSchema.optional(),
    taskTitle: z.string().optional(),
    files: z.array(z.string()),
    affectedTaskIds: z.array(TaskIdSchema),
    selectedImplementerProfile: z.string().optional(),
    availableActions: z.array(RecoveryActionSchema).min(1),
    recommendedAction: RecoveryActionSchema,
    workerProfile: z.string().optional(),
    facts: z.record(z.string(), z.boolean()).optional(),
  })
  .refine(recommendedActionIsAvailable, {
    path: ['recommendedAction'],
    message: 'recommendedAction must be one of availableActions',
  })
  .refine(actionsAreLegalForReason, {
    path: ['availableActions'],
    message: 'availableActions contain actions illegal for the recovery reason',
  });

export type IpcRecoveryIssue = z.infer<typeof IpcRecoveryIssueSchema>;

export function projectIpcRecoveryIssue(issue: RecoveryIssue): IpcRecoveryIssue {
  const facts = booleanFacts(issue.facts);
  const workerProfile =
    typeof issue.facts?.['routeBiggerProfile'] === 'string'
      ? issue.facts['routeBiggerProfile']
      : undefined;
  return {
    id: issue.id,
    reason: issue.reason,
    phase: issue.phase,
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    ...(issue.taskTitle !== undefined && { taskTitle: issue.taskTitle }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    ...(issue.selectedImplementerProfile !== undefined && {
      selectedImplementerProfile: issue.selectedImplementerProfile,
    }),
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
    ...(workerProfile !== undefined && { workerProfile }),
    ...(facts !== undefined && { facts }),
  };
}

function booleanFacts(
  facts: Record<string, RecoveryFact> | undefined,
): Record<string, boolean> | undefined {
  if (facts === undefined) return undefined;
  const entries = Object.entries(facts).filter((entry): entry is [string, boolean] => {
    return typeof entry[1] === 'boolean';
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
