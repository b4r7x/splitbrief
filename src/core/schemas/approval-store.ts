import { z } from 'zod';
import { ActionClassSchema } from './enums.js';
export { ActionClassSchema } from './enums.js';

export type ActionClass = z.infer<typeof ActionClassSchema>;

export const ApprovalGrantSchema = z.object({
  pattern: z.string().min(1),
  class: ActionClassSchema,
  scope: z.enum(['session', 'always']),
  sessionId: z.string().optional(),
  grantedAt: z.string(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

export const ApprovalsStoreSchema = z.object({
  version: z.literal(1),
  grants: z.array(ApprovalGrantSchema),
}).strict();
export type ApprovalsStore = z.infer<typeof ApprovalsStoreSchema>;
