import { createPlanner } from './planners/factory.js';
import type { Task, Config, ProjectContext } from '../types.js';

export async function escalateTask(
  task: Task,
  error: string,
  projectDir: string,
  config: Config,
  _context: ProjectContext,
  callbacks: { onOutput: (text: string) => void },
  tier: 1 | 2 = 1,
): Promise<{ success: boolean; output: string; tier: 1 | 2; usage: { inputTokens: number; outputTokens: number } | null }> {
  const planner = await createPlanner(config);

  if (tier === 1) {
    const result = await planner.escalateHint(task, error, projectDir, callbacks);
    return { success: false, output: result.output, tier: 1, usage: result.usage };
  }

  const result = await planner.escalateFull(task, error, projectDir, callbacks);
  return { success: result.success, output: result.output, tier: 2, usage: result.usage };
}
