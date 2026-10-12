import { parsePlanJson } from '../../core/sessions/plan-file.js';
import { blocksPlan, checkPlan } from '../../engine/spec/plan-checks.js';

/**
 * Why an edited plan.json cannot be saved, or nothing when it can. The context fit needs the
 * BUILD model and the files on disk, so the engine checks it after the save; every other check
 * runs here, through the same functions. The edit is made at the plan card, so the user approves
 * the plan and its npm scripts.
 */
export function planSaveErrors(text: string, projectDir: string): readonly string[] {
  const parsed = parsePlanJson(text);
  if ('errors' in parsed) return parsed.errors;
  return checkPlan(parsed.plan, projectDir, new Map(), undefined, true)
    .filter(blocksPlan)
    .map((error) => error.message);
}
