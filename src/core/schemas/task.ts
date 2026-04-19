import { z } from 'zod';
import { TaskStatusSchema } from './enums.js';

export const TaskIdSchema = z.string().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;
export const taskId = (s: string): TaskId => TaskIdSchema.parse(s);

export const TaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  action: z.enum(['create', 'modify']),
  file: z.string(),
  dependsOn: z.array(TaskIdSchema),
  description: z.string(),
  signature: z.string().optional(),
  currentCode: z.string().optional(),
  tests: z.array(z.string()),
  constraints: z.array(z.string()),
  pattern: z.string().optional(),
  typeDefs: z.string(),
  implementationSteps: z.array(z.string()),
  status: TaskStatusSchema,
});

export type Task = z.infer<typeof TaskSchema>;
