/**
 * The planning session's typed answer (`PlanResult`) and the run-level plan kept in state and
 * as `plan.json`. Optional values are `nullable` and every key is required, so the JSON Schema
 * passes OpenAI strict mode and the tools that have a native schema flag use it.
 */
import { posix } from 'node:path';
import { z } from 'zod';
import { normalizeProjectRelativePath } from '../../utils/path-patterns.js';
import { CheckSchema, ProtectedOperationSchema, TaskIdSchema } from './task.js';

/** A plan path spelled as the write gate names a changed file: `./a.ts` and `b/../a.ts` are `a.ts`. */
const PlanPathSchema = z
  .string()
  .overwrite((path) => posix.normalize(normalizeProjectRelativePath(path)));

/** ⏎ answers a question with its default, so the default is an answer the question offers. */
const PlanQuestionSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    choices: z.array(z.string()).nullable(),
    default: z.string(),
  })
  .refine(
    (question) =>
      question.default.trim() !== '' &&
      (question.choices === null ||
        question.choices.length === 0 ||
        question.choices.includes(question.default)),
    { message: 'The default must be non-empty and one of the choices.', path: ['default'] },
  );

const PlanQuestionsSchema = z.object({
  kind: z.literal('questions'),
  questions: z.array(PlanQuestionSchema).min(1).max(3),
});

export const TaskSpecSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  intent: z.string(),
  criteria: z.array(z.string()),
  checks: z.array(CheckSchema),
  suggestedFiles: z.array(PlanPathSchema).min(1),
  contextFiles: z.array(PlanPathSchema),
  exclusions: z.array(z.string()),
  protectedOperations: z
    .array(ProtectedOperationSchema.extend({ path: PlanPathSchema }))
    .nullable(),
  steps: z.array(z.string()).nullable(),
  dependsOn: z.array(TaskIdSchema),
  batch: z.number().int().min(1),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

const CriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  checkIds: z.array(z.string()),
});

const PlanValidationSchema = z.object({
  language: z.string().nullable(),
  typecheck: z.string().nullable(),
  lint: z.string().nullable(),
  test: z.string().nullable(),
  testPattern: z.string().nullable(),
});

export const PlanProposalSchema = z.object({
  kind: z.literal('plan'),
  summary: z.string(),
  decisions: z.array(z.string()),
  criteria: z.array(CriterionSchema),
  checks: z.array(CheckSchema),
  validation: PlanValidationSchema.nullable(),
  tasks: z.array(TaskSpecSchema),
});
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export const PlanResultSchema = z.union([PlanQuestionsSchema, PlanProposalSchema]);
export type PlanResult = z.infer<typeof PlanResultSchema>;

/** Strict mode takes only an object at the root, so the union travels under `result`. */
export const PlanAnswerSchema = z.object({ result: PlanResultSchema });
export type PlanAnswer = z.infer<typeof PlanAnswerSchema>;
export const PLAN_ANSWER_JSON_SCHEMA = z.toJSONSchema(PlanAnswerSchema);

export const PlanSchema = PlanProposalSchema.pick({
  summary: true,
  decisions: true,
  criteria: true,
  checks: true,
  validation: true,
});
export type Plan = z.infer<typeof PlanSchema>;
