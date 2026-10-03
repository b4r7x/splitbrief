import { PLAN_JSON_FILE } from '../paths.js';
import { writeSpecFile, type SpecFileRef } from '../paths-io.js';
import { PlanProposalSchema, type PlanProposal } from '../schemas/plan.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function writePlanJson(ref: SpecFileRef, plan: PlanProposal): void {
  writeSpecFile(ref, PLAN_JSON_FILE, `${JSON.stringify(plan, null, 2)}\n`, null);
}

/** Text the user edited as plan.json: the plan it holds, or why it holds none. */
export function parsePlanJson(
  text: string,
): { plan: PlanProposal } | { errors: readonly string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { errors: [`plan.json is not valid JSON (${toErrorMessage(err)}).`] };
  }
  const parsed = PlanProposalSchema.safeParse(json);
  if (parsed.success) return { plan: parsed.data };
  return {
    errors: parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
    ),
  };
}
