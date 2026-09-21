import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { buildSkillsSection, discoverSkills } from '../../skill-discovery.js';
import { publishWarning } from '../events.js';
import type { PlanningPhaseOptions } from './types.js';

async function resolvePlanningSkills(
  selectedSkills: SkillMeta[] | undefined,
  state: WorkflowState,
  projectDir: string,
): Promise<SkillMeta[]> {
  if (selectedSkills && selectedSkills.length > 0) return selectedSkills;
  const persisted = state.selectedSkills;
  if (!persisted || persisted.length === 0) return [];
  const ids = new Set(persisted);
  const available = await discoverSkills(projectDir);
  return available.filter((s) => ids.has(s.id));
}

export async function buildPlanningSkillsContext(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
): Promise<string | undefined> {
  const { projectDir, bus } = opts.wctx;
  const skills = await resolvePlanningSkills(opts.selectedSkills, state, projectDir);
  if (skills.length === 0) return undefined;
  const { section, omitted } = await buildSkillsSection(skills);
  if (omitted.length > 0) {
    publishWarning({
      bus,
      phase: state.phase,
      message: `${omitted.length} skills omitted (budget): ${omitted.join(', ')}`,
      safety: { category: 'skills', code: 'skills_truncated' },
    });
  }
  return section;
}
